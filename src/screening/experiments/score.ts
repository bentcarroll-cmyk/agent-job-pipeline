// Local, variant-neutral scoring. This module never calls a model or writes state.
import type { Verdict } from "../../criteria";
import { checkEvidence } from "../policy-report";
import type { PolicyExpectation } from "../policy-fixtures";
import { hashContent } from "../snapshot";
import type { ScreeningResult, ScreeningState } from "../types";
import { validateExperimentManifest, type ExperimentManifest } from "./contracts";

export type ExperimentOutcome = {
  caseId: string;
  variantId: string;
  manifestHash: string;
  inputHash: string;
  status: "completed" | "failed" | "uncertain";
  result: ScreeningResult | null;
  legacyVerdict?: Verdict;
  attemptIds: string[];
  elapsedMs: number;
  // A separate source reviewer supplies semantic support; a source anchor alone
  // cannot establish that the quoted text means what the decision says.
  semanticReview?: {supported:boolean;note:string} | null;
  validatorRecovered?: boolean | null;
  usage?: {inputTokens:number;outputTokens:number} | null;
  estimatedCostUsd?: number | null;
};

export type ExperimentMetrics = {
  attempted:number;completed:number;failed:number;uncertain:number;labeled:number;observational:number;
  rawStateAgreement:number;overallGatePassed:number;falseExclusions:number;falseMatches:number;
  wrongHardExclusions:number | null;invalidEvidenceFacts:number | null;
  missingEvidenceFields:number | null;missingRequiredGaps:number | null;
  qualificationGroupsComplete:number | null;qualificationGroupsExpected:number | null;
  renderedWarningMisses:number | null;
  semanticSupported:number;semanticUnsupported:number;semanticUnreviewed:number;
  validatorRecovered:number;validatorNotRecovered:number;validatorRecoveryUnknown:number;
  elapsedTotalMs:number;elapsedMeanMs:number | null;elapsedMedianMs:number | null;
  elapsedP95Ms:number | null;elapsedMaxMs:number | null;modelAttempts:number;
  inputTokens:number;outputTokens:number;usageUnknown:number;
  knownCostUsd:number;costUnknown:number;costPerGatePassUsd:number | null;
};

function empty(legacy: boolean): ExperimentMetrics {
  return {attempted:0,completed:0,failed:0,uncertain:0,labeled:0,observational:0,
    rawStateAgreement:0,overallGatePassed:0,falseExclusions:0,falseMatches:0,
    wrongHardExclusions:legacy ? null : 0,invalidEvidenceFacts:legacy ? null : 0,
    missingEvidenceFields:legacy ? null : 0,missingRequiredGaps:legacy ? null : 0,
    qualificationGroupsComplete:legacy ? null : 0,qualificationGroupsExpected:legacy ? null : 0,
    renderedWarningMisses:legacy ? null : 0,
    semanticSupported:0,semanticUnsupported:0,semanticUnreviewed:0,
    validatorRecovered:0,validatorNotRecovered:0,validatorRecoveryUnknown:0,
    elapsedTotalMs:0,elapsedMeanMs:null,elapsedMedianMs:null,elapsedP95Ms:null,
    elapsedMaxMs:null,modelAttempts:0,
    inputTokens:0,outputTokens:0,usageUnknown:0,knownCostUsd:0,costUnknown:0,
    costPerGatePassUsd:null};
}

function completeGroups(result: ScreeningResult, patterns: string[]): number {
  return patterns.filter(pattern => {
    const re = new RegExp(pattern,"i");
    return result.decision.evidence.some(fact => fact.field === "qualification" &&
      re.test(`${fact.excerpt} ${fact.value}`) && fact.snapshotId === result.snapshot.id &&
      fact.sourceUrl === result.snapshot.job.url && fact.sourceField === "description" &&
      result.snapshot.job.description?.slice(fact.start,fact.end) === fact.excerpt) &&
      re.test(result.decision.qualificationWarnings.join("\n"));
  }).length;
}

function parseLabels(text: string | null): ReadonlyMap<string, PolicyExpectation> {
  if (text === null) return new Map();
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Frozen label artifact must be a case-to-expectation object");
  const labels = new Map<string,PolicyExpectation>();
  for (const [id,raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid frozen case label");
    const value = raw as Record<string,unknown>;
    if (Object.keys(value).some(key => !["state","hardExclude","evidenceFields",
      "gapPatterns","qualificationPatterns","rationale"].includes(key)) ||
      !["match","no_match","needs_review"].includes(value.state as string) ||
      ![null,"employment","clearance","compensation","location"].includes(
        value.hardExclude as string | null) ||
      !Array.isArray(value.evidenceFields) || value.evidenceFields.some(field =>
        !["location","employment","compensation","clearance","function",
          "company_category","qualification"].includes(field)) ||
      ![value.gapPatterns,value.qualificationPatterns].every(list => list === undefined ||
        Array.isArray(list) && list.length <= 24 && list.every(item =>
          typeof item === "string" && item.length <= 500)) ||
      typeof value.rationale !== "string" || !value.rationale.trim())
      throw new Error("Invalid frozen policy expectation");
    labels.set(id,value as PolicyExpectation);
  }
  return labels;
}

export async function scoreExperiment(outcomes: ExperimentOutcome[],
  labelArtifact: string | null,
  manifest: ExperimentManifest): Promise<Record<string, ExperimentMetrics>> {
  validateExperimentManifest(manifest);
  const {id:_id,createdAt:_createdAt,...frozenData} = manifest;
  if (await hashContent(frozenData) !== manifest.id ||
    (labelArtifact === null ? manifest.labelHash !== null :
      await hashContent(labelArtifact) !== manifest.labelHash))
    throw new Error("Frozen manifest or label artifact hash mismatch");
  const labels = parseLabels(labelArtifact);
  const roster = new Map<string,string>(manifest.cases.flatMap(item => manifest.variants.map(variant =>
    [`${item.id}\u0000${variant.id}`,item.snapshotHash] as const)));
  if (outcomes.length !== roster.size) throw new Error("Incomplete frozen case-variant roster");
  if (manifest.split === "observational" ? labels.size !== 0 :
    labels.size !== manifest.cases.length ||
    manifest.cases.some(item => !labels.has(item.id)))
    throw new Error("Frozen case labels do not match the manifest roster");
  const scores: Record<string,ExperimentMetrics> = Object.create(null);
  const elapsed = new Map<string,number[]>();
  const seen = new Set<string>();
  const attemptOwner = new Set<string>();
  for (const row of outcomes) {
    const key = `${row.caseId}\u0000${row.variantId}`;
    const frozenHash = roster.get(key);
    if (!row.caseId || !row.variantId || seen.has(key) || !frozenHash ||
      row.manifestHash !== manifest.id)
      throw new Error("Duplicate, extra, or empty case-variant experiment outcome");
    seen.add(key);
    const legacy = row.variantId === "legacy";
    if (!Array.isArray(row.attemptIds) || row.attemptIds.length > 4 ||
      new Set(row.attemptIds).size !== row.attemptIds.length ||
      !row.attemptIds.every(id => typeof id === "string" && !!id) ||
      (row.status === "completed" && row.attemptIds.length === 0) ||
      !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 ||
      row.inputHash !== frozenHash ||
      !["completed","failed","uncertain"].includes(row.status))
      throw new Error("Invalid experiment outcome identity, attempts, or elapsed time");
    for (const id of row.attemptIds) {
      if (attemptOwner.has(id)) throw new Error("Duplicate model attempt across outcomes");
      attemptOwner.add(id);
    }
    if (row.status === "completed" ?
      !(row.result && !row.legacyVerdict || legacy && row.legacyVerdict && !row.result) :
      !!row.result || !!row.legacyVerdict)
      throw new Error("Invalid completed or failed experiment result");
    if (legacy && row.result || !legacy && row.legacyVerdict)
      throw new Error("Variant result shape does not match its method");
    if (row.result && (row.result.snapshot.jobId !== row.caseId ||
      await hashContent(row.result.snapshot) !== frozenHash))
      throw new Error("Assessment snapshot does not match frozen case identity");
    if (row.result) {
      const decision = row.result.decision;
      if (!decision || !["match","no_match","needs_review"].includes(decision.state) ||
        decision.state === "match" && (!["A","B"].includes(decision.lane as string) ||
          decision.hardExclude !== null) ||
        decision.state !== "match" && decision.lane !== null ||
        decision.state === "needs_review" && decision.hardExclude !== null ||
        ![null,"employment","clearance","compensation","location"].includes(
          decision.hardExclude) ||
        typeof decision.reason !== "string" || !decision.reason.trim() ||
        !Array.isArray(decision.evidence) || decision.evidence.length > 24 ||
        !Array.isArray(decision.gaps) || !decision.gaps.every(gap =>
          typeof gap === "string") ||
        !Array.isArray(decision.qualificationWarnings) ||
        !decision.qualificationWarnings.every(warning => typeof warning === "string"))
        throw new Error("Contradictory or malformed completed screening decision");
    }
    if (row.legacyVerdict && (typeof row.legacyVerdict.match !== "boolean" ||
      typeof row.legacyVerdict.reason !== "string" || !row.legacyVerdict.reason.trim() ||
      !["A","B",null].includes(row.legacyVerdict.lane) ||
      !(row.legacyVerdict.hard_exclude === null ||
        typeof row.legacyVerdict.hard_exclude === "string") ||
      row.legacyVerdict.match && (row.legacyVerdict.hard_exclude !== null ||
        row.legacyVerdict.lane === null)))
      throw new Error("Invalid legacy verdict wire fields");
    if (row.semanticReview !== undefined && row.semanticReview !== null &&
      (typeof row.semanticReview.supported !== "boolean" ||
       typeof row.semanticReview.note !== "string" ||
       !row.semanticReview.note.trim() || row.semanticReview.note.length > 1000))
      throw new Error("Invalid independent semantic review receipt");
    if (row.usage !== undefined && row.usage !== null &&
      (!Number.isSafeInteger(row.usage.inputTokens) || row.usage.inputTokens < 0 ||
       !Number.isSafeInteger(row.usage.outputTokens) || row.usage.outputTokens < 0))
      throw new Error("Invalid experiment token usage");
    if (row.estimatedCostUsd !== undefined && row.estimatedCostUsd !== null &&
      (!Number.isFinite(row.estimatedCostUsd) || row.estimatedCostUsd < 0))
      throw new Error("Invalid experiment cost");
    const variant = manifest.variants.find(item => item.id === row.variantId)!;
    const rate = manifest.pricing.find(item => item.model === variant.model)!;
    const pricedUsage = row.usage ?
      (row.usage.inputTokens * rate.inputUsdPerMillion +
       row.usage.outputTokens * rate.outputUsdPerMillion) / 1_000_000 : null;
    if (pricedUsage !== null && row.estimatedCostUsd !== undefined &&
      row.estimatedCostUsd !== null && row.estimatedCostUsd + 1e-12 < pricedUsage)
      throw new Error("Reported experiment cost understates frozen-price token usage");
    const score = scores[row.variantId] ??= empty(legacy);
    if (!elapsed.has(row.variantId)) elapsed.set(row.variantId,[]);
    elapsed.get(row.variantId)!.push(row.elapsedMs);
    score.attempted++;
    score.modelAttempts += row.attemptIds.length;
    score.elapsedTotalMs += row.elapsedMs;
    score.elapsedMaxMs = Math.max(score.elapsedMaxMs ?? 0,row.elapsedMs);
    if (row.usage) { score.inputTokens += row.usage.inputTokens;
      score.outputTokens += row.usage.outputTokens; } else score.usageUnknown++;
    if (pricedUsage !== null)
      score.knownCostUsd += Math.max(pricedUsage,row.estimatedCostUsd ?? 0);
    else score.costUnknown++;
    if (row.validatorRecovered === true) score.validatorRecovered++;
    else if (row.validatorRecovered === false) score.validatorNotRecovered++;
    else score.validatorRecoveryUnknown++;
    const expected = labels.get(row.caseId);
    if (expected) score.labeled++; else score.observational++;
    if (!legacy && expected?.qualificationPatterns?.length)
      score.qualificationGroupsExpected! += expected.qualificationPatterns.length;
    if (row.status === "failed") score.failed++;
    else if (row.status === "uncertain") score.uncertain++;
    else score.completed++;
    if (row.status !== "completed") { score.semanticUnreviewed++; continue; }
    const actual: ScreeningState = row.result?.decision.state ??
      (row.legacyVerdict?.match ? "match" : "no_match");
    if (actual === "retry") throw new Error("A retry is not a completed assessment");
    if (row.semanticReview?.supported === true) score.semanticSupported++;
    else if (row.semanticReview?.supported === false) score.semanticUnsupported++;
    else score.semanticUnreviewed++;
    if (!expected) continue;
    if (actual === expected.state) score.rawStateAgreement++;
    if (expected.state === "match" && actual === "no_match") score.falseExclusions++;
    if (expected.state === "no_match" && actual === "match") score.falseMatches++;
    if (legacy) {
      if (actual === expected.state && row.semanticReview?.supported === true &&
        !expected.qualificationPatterns?.length)
        score.overallGatePassed++;
      continue;
    }
    const result = row.result!;
    const checks = checkEvidence({state:actual,reason:result.decision.reason,
      latencyMs:row.elapsedMs,calls:row.attemptIds.length,
      decision:result.decision,snapshot:result.snapshot},expected);
    score.invalidEvidenceFacts! += checks.invalidEvidenceFacts;
    score.missingEvidenceFields! += checks.missingEvidenceFields;
    score.missingRequiredGaps! += checks.missingRequiredGaps;
    score.wrongHardExclusions! += checks.wrongHardExclusions;
    const groups = completeGroups(result,expected.qualificationPatterns ?? []);
    score.qualificationGroupsComplete! += groups;
    score.renderedWarningMisses! += (expected.qualificationPatterns?.length ?? 0) - groups;
    if (actual === expected.state && checks.invalidEvidenceFacts === 0 &&
      checks.missingEvidenceFields === 0 && checks.missingRequiredGaps === 0 &&
      checks.wrongHardExclusions === 0 &&
      groups === (expected.qualificationPatterns?.length ?? 0) &&
      row.semanticReview?.supported === true)
      score.overallGatePassed++;
  }
  for (const [variantId,score] of Object.entries(scores)) {
    score.elapsedMeanMs = score.attempted ? score.elapsedTotalMs / score.attempted : null;
    const samples = elapsed.get(variantId)!.sort((a,b) => a-b);
    score.elapsedMedianMs = samples.length ?
      (samples[Math.floor((samples.length-1)/2)] + samples[Math.ceil((samples.length-1)/2)]) / 2 : null;
    score.elapsedP95Ms = samples.length ? samples[Math.ceil(samples.length * .95)-1] : null;
    score.costPerGatePassUsd = score.overallGatePassed && !score.costUnknown ?
      score.knownCostUsd / score.overallGatePassed : null;
  }
  return scores;
}
