import { type Verdict } from "../criteria";
import { buildCriteriaPrompt, buildEvidencePrompt } from "../config/prompts";
import type { RuntimeConfig } from "../config/types";
import { filterJob, type FilterEnv, type ModelOptions } from "../filter";
import { SCREENING_VERSIONS } from "../discovery/evidence";
import { evaluateJob } from "./evaluate";
import { hashContent } from "./snapshot";
import { POLICY_FIXTURES, POLICY_FIXTURE_VERSION, type PolicyFixture, type PolicyExpectation, type PolicySplit } from "./policy-fixtures";
import type { EvidenceField, PostingSnapshot, ScreeningDecision, ScreeningState } from "./types";

export type VariantResult = { state: ScreeningState; reason: string; latencyMs: number; calls: number; legacyVerdict?: Verdict; decision?: ScreeningDecision; snapshot?: PostingSnapshot };
export type ComparisonRow = { id: string; split: PolicySplit; source: PolicyFixture["source"]; expected: PolicyExpectation | null; inputHash: string; legacy: VariantResult; evidence: VariantResult };
export type QualityChecks = { invalidEvidenceFacts: number; missingEvidenceFields: number; missingRequiredGaps: number; qualificationWarningMisses: number; wrongHardExclusions: number; issues: string[] };
export type VariantMetrics = {
  stateCounts: Record<ScreeningState, number>; labeled: number; observations: number; stateCorrect: number;
  falsePositives: number; falseNegatives: number; unsafeReviewAcceptances: number; reviewCasesRejected: number; unexpectedReviews: number; retries: number;
  invalidEvidenceFacts: number; missingEvidenceFields: number; missingRequiredGaps: number; qualificationWarningMisses: number; wrongHardExclusions: number;
  calls: number; latency: { totalMs: number; meanMs: number | null; maxMs: number | null };
};
const states: ScreeningState[] = ["match", "no_match", "needs_review", "retry"];

// This checks anchors and policy obligations independently of the production
// validator. Exact text support does not establish semantic correctness.
export function checkEvidence(outcome: VariantResult, expected: PolicyExpectation | null): QualityChecks {
  const checks: QualityChecks = { invalidEvidenceFacts: 0, missingEvidenceFields: 0, missingRequiredGaps: 0, qualificationWarningMisses: 0, wrongHardExclusions: 0, issues: [] };
  const { decision, snapshot } = outcome;
  if (!decision || outcome.state === "retry") return checks;
  const anchored = new Set<EvidenceField>();
  const allowed: Record<EvidenceField, string[]> = { location: ["location", "description"], employment: ["employmentType", "description"], compensation: ["compensation", "description"], clearance: ["description"], function: ["description"], company_category: ["companyCategory", "description"], qualification: ["description"] };
  for (const fact of decision.evidence) {
    const source = fact.sourceField === "companyCategory" ? snapshot?.companyCategory : snapshot?.job[fact.sourceField as keyof typeof snapshot.job];
    const url = fact.sourceField === "companyCategory" ? "configuration:fixed-sources" : snapshot?.job.url;
    if (!snapshot || typeof source !== "string" || fact.snapshotId !== snapshot.id || fact.sourceUrl !== url ||
        !allowed[fact.field]?.includes(fact.sourceField) || !Number.isInteger(fact.start) || !Number.isInteger(fact.end) ||
        fact.start < 0 || fact.end <= fact.start || fact.end > source.length || source.slice(fact.start, fact.end) !== fact.excerpt ||
        /\[(?:middle of posting|snapshot text) omitted\]/i.test(fact.excerpt)) {
      checks.invalidEvidenceFacts++; checks.issues.push(`Unanchored ${fact.field} evidence`);
    } else anchored.add(fact.field);
  }
  if (expected) {
    for (const field of expected.evidenceFields) if (!anchored.has(field)) { checks.missingEvidenceFields++; checks.issues.push(`Missing anchored ${field} evidence`); }
    for (const pattern of expected.gapPatterns ?? []) if (!new RegExp(pattern, "i").test(decision.gaps.join("\n"))) { checks.missingRequiredGaps++; checks.issues.push(`Missing required gap: ${pattern}`); }
    if (expected.qualificationPatterns?.length) {
      const qualifications = decision.evidence.filter(fact => fact.field === "qualification").map(fact => `${fact.excerpt} ${fact.value}`).join("\n");
      if (decision.qualificationWarnings.length === 0 || !anchored.has("qualification") ||
          expected.qualificationPatterns.some(pattern => !new RegExp(pattern, "i").test(qualifications) || !new RegExp(pattern, "i").test(decision.qualificationWarnings.join("\n")))) {
        checks.qualificationWarningMisses++; checks.issues.push("Required credential or specialized-experience warning missing");
      }
    }
    if (outcome.state === "no_match" && decision.hardExclude !== expected.hardExclude) { checks.wrongHardExclusions++; checks.issues.push("Hard-exclusion category differs from the frozen policy label"); }
  }
  return checks;
}

export function scoreComparison(rows: ComparisonRow[]): { legacy: VariantMetrics; evidence: VariantMetrics } {
  function score(variant: "legacy" | "evidence"): VariantMetrics {
    const result: VariantMetrics = { stateCounts: { match: 0, no_match: 0, needs_review: 0, retry: 0 }, labeled: 0, observations: 0, stateCorrect: 0,
      falsePositives: 0, falseNegatives: 0, unsafeReviewAcceptances: 0, reviewCasesRejected: 0, unexpectedReviews: 0, retries: 0,
      invalidEvidenceFacts: 0, missingEvidenceFields: 0, missingRequiredGaps: 0, qualificationWarningMisses: 0, wrongHardExclusions: 0,
      calls: 0, latency: { totalMs: 0, meanMs: null, maxMs: null } };
    for (const row of rows) {
      const actual = row[variant], expected = row.expected;
      if (!states.includes(actual.state) || !Number.isFinite(actual.latencyMs) || actual.latencyMs < 0) throw new Error("Invalid comparison outcome");
      result.stateCounts[actual.state]++; result.calls += actual.calls; result.latency.totalMs += actual.latencyMs;
      result.latency.maxMs = Math.max(result.latency.maxMs ?? 0, actual.latencyMs);
      if (actual.state === "retry") result.retries++;
      if (!expected) result.observations++;
      else {
        result.labeled++;
        if (actual.state === expected.state) result.stateCorrect++;
        if (expected.state === "no_match" && actual.state === "match") result.falsePositives++;
        if (expected.state === "match" && actual.state === "no_match") result.falseNegatives++;
        if (expected.state === "needs_review" && actual.state === "match") result.unsafeReviewAcceptances++;
        if (expected.state === "needs_review" && actual.state === "no_match") result.reviewCasesRejected++;
        if (expected.state !== "needs_review" && actual.state === "needs_review") result.unexpectedReviews++;
      }
      if (variant === "evidence") {
        const checks = checkEvidence(actual, expected);
        result.invalidEvidenceFacts += checks.invalidEvidenceFacts; result.missingEvidenceFields += checks.missingEvidenceFields;
        result.missingRequiredGaps += checks.missingRequiredGaps; result.qualificationWarningMisses += checks.qualificationWarningMisses;
        result.wrongHardExclusions += checks.wrongHardExclusions;
      }
    }
    if (rows.length) result.latency.meanMs = result.latency.totalMs / rows.length;
    return result;
  }
  return { legacy: score("legacy"), evidence: score("evidence") };
}

export async function comparisonManifest(fixtures: PolicyFixture[], config: RuntimeConfig) {
  return { fixtureVersion: POLICY_FIXTURE_VERSION, policyFixtureHash: await hashContent(POLICY_FIXTURES),
    selectedInputHash: await hashContent(fixtures), selectedIds: fixtures.map(f => f.id),
    promptHashes: { legacy: await hashContent(buildCriteriaPrompt(config)), evidence: await hashContent(buildEvidencePrompt(config)) }, versions: { ...SCREENING_VERSIONS, criteriaVersion: config.criteriaVersion } };
}

export type ComparisonReport = Awaited<ReturnType<typeof comparisonManifest>> & { createdAt: string; rows: ComparisonRow[]; metrics: ReturnType<typeof scoreComparison> };

// Callable from a local Worker with only an explicitly supplied AI binding.
// No D1, Slack, credentials, lifecycle state or production triggers are imported.
export async function runComparison(env: FilterEnv, fixtures: PolicyFixture[], options: ModelOptions & { paceMs?: number; onResult?: (row: ComparisonRow) => Promise<void> } = {}): Promise<ComparisonReport> {
  if (fixtures.length < 1 || fixtures.length > 18 || new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new Error("Choose 1-18 distinct comparison cases");
  if (new Set(fixtures.map(f => f.split)).size !== 1) throw new Error("Development, heldout and observational splits must run separately");
  if (fixtures.some(f => (f.split === "observational") !== (f.expected === null))) throw new Error("Only observational cases may be unlabelled");
  const paceMs = options.paceMs ?? 4000;
  if (!Number.isFinite(paceMs) || paceMs < 0 || paceMs > 10000) throw new Error("Invalid comparison pacing");
  const frozenInputs = structuredClone(fixtures);
  const manifest = await comparisonManifest(frozenInputs, env.runtime);
  const rows: ComparisonRow[] = [];
  const pause = async () => { if (paceMs) await new Promise(resolve => setTimeout(resolve, paceMs)); };
  for (let index = 0; index < frozenInputs.length; index++) {
    const fixture = frozenInputs[index];
    async function sample(variant: "legacy" | "evidence"): Promise<VariantResult> {
      let calls = 0;
      const wrapped = { ...env, AI: { run: async (...args: unknown[]) => { calls++; return Reflect.apply(env.AI.run, env.AI, args); } } as unknown as Ai };
      const started = Date.now();
      try {
        if (variant === "legacy") {
          const legacyVerdict = await filterJob(wrapped, fixture.job, fixture.companyCategory, options);
          return { state: legacyVerdict.match ? "match" : "no_match", reason: legacyVerdict.reason, legacyVerdict, calls, latencyMs: Date.now() - started };
        }
        const { snapshot, decision } = await evaluateJob(wrapped, fixture.job, fixture.companyCategory, options);
        return { state: decision.state, reason: decision.reason, snapshot, decision, calls, latencyMs: Date.now() - started };
      } catch {
        return { state: "retry", reason: "Evaluation did not complete; no assessment is available.", calls, latencyMs: Date.now() - started };
      }
    }
    const legacy = await sample("legacy");
    await pause();
    const evidence = await sample("evidence");
    const row: ComparisonRow = { id: fixture.id, split: fixture.split, source: fixture.source, expected: fixture.expected,
      inputHash: await hashContent({ job: fixture.job, companyCategory: fixture.companyCategory ?? null }), legacy, evidence };
    rows.push(row);
    await options.onResult?.(row);
    if (index + 1 < frozenInputs.length) await pause();
  }
  return { ...manifest, createdAt: new Date().toISOString(), rows, metrics: scoreComparison(rows) };
}
