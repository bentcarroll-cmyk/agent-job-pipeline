import { buildEvidencePrompt } from "../config/prompts";
import type { RuntimeConfig } from "../config/types";
import { assertReasoningEffort, sampleModelDecision, type FilterEnv, type ModelOptions } from "../filter";
import { SCREENING_VERSIONS, validateScreeningDecision } from "../discovery/evidence";
import type { CompanyCategory, NormalizedJob } from "../sources";
import { createPostingSnapshot } from "./snapshot";
import type { PostingSnapshot, ScreeningDecision, ScreeningResult } from "./types";

export const SCREENING_TOOL = { type: "function" as const, function: {
 name: "record_screening_decision", description: "Record an evidence-grounded possible match, rejection, or review need",
 parameters: { type: "object", additionalProperties: false, required: ["state", "lane", "hardExclude", "reason", "gaps", "evidence"], properties: {
  state: {type: "string", enum: ["match", "no_match", "needs_review"]},
  lane: {type: "string", enum: ["A", "B", "none"]},
  hardExclude: {type: "string", enum: ["employment", "clearance", "compensation", "location", "none"]},
  reason: {type: "string"}, gaps: {type: "array", items: {type: "string"}},
  evidence: {type: "array", items: {type: "object", additionalProperties: false, required: ["field", "value", "sourceField", "excerpt"], properties: {
   field: {type: "string", enum: ["location", "employment", "compensation", "clearance", "function", "company_category", "qualification"]},
   value: {type: "string"}, excerpt: {type: "string"},
   sourceField: {type: "string", enum: ["description", "compensation", "location", "employmentType", "companyCategory"]},
  } } },
 } },
} };

export function screeningRetryDecision(reason: string, config: RuntimeConfig): ScreeningDecision {
 return {state: "retry", lane: null, hardExclude: null, reason: reason.slice(0,500), evidence: [], gaps: ["No completed screening assessment is available."], qualificationWarnings: [], ...SCREENING_VERSIONS, criteriaVersion: config.criteriaVersion};
}
export function screeningInput(snapshot: PostingSnapshot, config: RuntimeConfig): ChatCompletionsInput {
 return {messages: [{role: "system", content: buildEvidencePrompt(config)}, {role: "user", content: JSON.stringify(snapshot)}], tools: [SCREENING_TOOL], tool_choice: "auto"};
}
export async function evaluateJob(env: FilterEnv, job: NormalizedJob, category?: CompanyCategory, options: ModelOptions = {}): Promise<ScreeningResult> {
 // A misconfigured effort must fail loudly, not become a retry for every posting.
 const effort = env.EVIDENCE_REASONING_EFFORT;
 assertReasoningEffort(effort);
 // The configured level is part of each evaluation's model provenance.
 const model = effort === undefined ? SCREENING_VERSIONS.model : `${SCREENING_VERSIONS.model};reasoning_effort=${effort}`;
 const snapshot = await createPostingSnapshot(job, category);
 try {
  const decision = await sampleModelDecision(env, job.id, screeningInput(snapshot, env.runtime), args => parseScreeningResponse(args, snapshot, env.runtime), "record_screening_decision",
   effort === undefined ? options : { ...options, reasoningEffort: effort });
  return {snapshot, decision: {...decision, model}};
 } catch {
  // Provider output may contain body text or secrets; detailed operational
  // metadata is logged by the sampler, never persist arbitrary error bodies.
  return {snapshot, decision: {...screeningRetryDecision("Screening did not complete within the bounded model attempts; retry after cooldown.", env.runtime), model}};
 }
}

export function parseScreeningResponse(args: string, snapshot: PostingSnapshot, config: RuntimeConfig): ScreeningDecision {
 const raw: unknown = JSON.parse(args);
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid screening response object");
 const value = raw as Record<string, unknown>;
 if (!["A", "B", "none"].includes(value.lane as string) ||
     !["employment", "clearance", "compensation", "location", "none"].includes(value.hardExclude as string)) throw new Error("invalid screening wire enums");
 return validateScreeningDecision({...value, lane: value.lane === "none" ? null : value.lane, hardExclude: value.hardExclude === "none" ? null : value.hardExclude}, snapshot, config);
}
