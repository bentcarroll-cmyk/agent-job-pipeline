// Isolated screening candidate. Nothing in production imports this module.
import { buildEvidencePrompt } from "../../config/prompts";
import type { RuntimeConfig } from "../../config/types";
import { validateScreeningDecision } from "../../discovery/evidence";
import { SCREENING_TOOL, screeningRetryDecision } from "../evaluate";
import type { EvidenceFact, PostingSnapshot, ScreeningDecision, ScreeningResult } from "../types";
import { parseQualifications, qualificationInput,
  type QualificationExtraction } from "./qualifications";

export type ExperimentSampler = (input: {
  stage: "qualification" | "decision";
  request: ChatCompletionsInput;
  expectedTool: string;
  deadlineAt: number;
  maxAttempts: 2;
  parse: (args: string) => unknown;
}) => Promise<unknown>;

const CASE_WALL_MS = 400000;
const PROMPT_VERSION = "qualification-plus-decision-v1";
const decisionPrompt = (config: RuntimeConfig) => `${buildEvidencePrompt(config)}\nEXPERIMENTAL TWO-STAGE CONTRACT: Required qualification facts have already been
extracted and anchored from this exact snapshot. They appear as acceptedQualifications
in the user JSON. Do not assess the candidate's credentials or use unconfirmed
qualifications to reject or downgrade an otherwise possible match. Decide function,
location, employment, clearance, and pay from the complete snapshot. Return no
qualification evidence of your own; the accepted facts are attached and validated
locally after your response. A conflict or missing evidence calls for needs_review.`;

function checkedExtraction(value: unknown, snapshot: PostingSnapshot): QualificationExtraction {
  if (!value || typeof value !== "object" || !Array.isArray((value as QualificationExtraction).facts) ||
    !Array.isArray((value as QualificationExtraction).gaps))
    throw new Error("Qualification stage returned no validated extraction");
  const proposed = value as QualificationExtraction;
  const checked = parseQualifications(JSON.stringify({snapshotId:snapshot.id,jobId:snapshot.jobId,
    qualifications:proposed.facts.map(fact => ({excerpt:fact.excerpt,value:fact.value})),
    gaps:proposed.gaps}),snapshot);
  if (checked.facts.length !== proposed.facts.length ||
    checked.facts.some((fact,index) => Object.keys(fact).some(key =>
      fact[key as keyof EvidenceFact] !== proposed.facts[index]?.[key as keyof EvidenceFact])))
    throw new Error("Qualification facts do not belong to the current snapshot");
  return checked;
}

function parseDecision(args: string, snapshot: PostingSnapshot,
  accepted: QualificationExtraction, config: RuntimeConfig): ScreeningDecision {
  const parsed: unknown = JSON.parse(args);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid decision object");
  const raw = parsed as Record<string,unknown>;
  if (!Array.isArray(raw.evidence) || !Array.isArray(raw.gaps) ||
    !["A","B","none"].includes(raw.lane as string) ||
    !["employment","clearance","compensation","location","none"].includes(raw.hardExclude as string))
    throw new Error("Invalid decision wire format");
  if (raw.evidence.length > 24) throw new Error("Decision evidence exceeds the existing 24-fact limit");
  if (raw.evidence.some(item => item && typeof item === "object" &&
    (item as {field?:unknown}).field === "qualification"))
    throw new Error("Decision stage must not replace accepted qualification evidence");
  if (accepted.facts.length && raw.state === "no_match" && raw.hardExclude === "none")
    throw new Error("Unstructured no-function-fit cannot safely distinguish qualification uncertainty");
  if (accepted.facts.length && raw.hardExclude === "none" && raw.state !== "match") {
    const explanation = [raw.reason,...raw.gaps].join(" ");
    if (/qualif|credential|licen[sc]e|certif|degree|diploma|educat|bachelor|master|doctorate|Ph\.?D|candidate|profile|background|experience|prerequisit|unverif|PMP|CPA|RN\b/i.test(explanation))
      throw new Error("Qualification uncertainty cannot downgrade the role");
  }
  const ordinary = raw.evidence;
  if (ordinary.length + accepted.facts.length > 24)
    throw new Error("Combined evidence exceeds the existing 24-fact limit");
  // The decision model cannot remove or rewrite already accepted requirements.
  const evidence = [...ordinary,...accepted.facts] as EvidenceFact[];
  const decision = validateScreeningDecision({...raw,
    lane:raw.lane === "none" ? null : raw.lane,
    hardExclude:raw.hardExclude === "none" ? null : raw.hardExclude,
    evidence,gaps:[...raw.gaps,...accepted.gaps]},snapshot,config);
  return {...decision,promptVersion:PROMPT_VERSION};
}

function decisionInput(snapshot: PostingSnapshot,
  extraction: QualificationExtraction, config: RuntimeConfig): ChatCompletionsInput {
  return {messages:[{role:"system",content:decisionPrompt(config)},
    {role:"user",content:JSON.stringify({snapshot,acceptedQualifications:
      extraction.facts.map(fact => ({excerpt:fact.excerpt,value:fact.value})),
      qualificationCoverageGaps:extraction.gaps})}],
    tools:[SCREENING_TOOL],tool_choice:"auto"};
}

function retry(snapshot: PostingSnapshot, reason: string, config: RuntimeConfig): ScreeningResult {
  return {snapshot,decision:{...screeningRetryDecision(reason, config),promptVersion:PROMPT_VERSION}};
}

export async function evaluateQualificationCandidate(snapshot: PostingSnapshot,
  sample: ExperimentSampler, config: RuntimeConfig, now: () => number = Date.now): Promise<ScreeningResult> {
  const deadlineAt = now() + CASE_WALL_MS;
  try {
    if (!snapshot.job.description?.trim()) return retry(snapshot,"Qualification source is unavailable.",config);
    const initial = await sample({stage:"qualification",request:qualificationInput(snapshot),
      expectedTool:"record_qualifications",deadlineAt,maxAttempts:2,
      parse:args => parseQualifications(args,snapshot)});
    if (now() >= deadlineAt) return retry(snapshot,"Qualification stage exceeded the shared deadline.",config);
    const extraction = checkedExtraction(initial,snapshot);
    const proposed = await sample({stage:"decision",request:decisionInput(snapshot,extraction,config),
      expectedTool:"record_screening_decision",deadlineAt,maxAttempts:2,
      parse:args => parseDecision(args,snapshot,extraction,config)});
    if (now() >= deadlineAt) return retry(snapshot,"Decision stage exceeded the shared deadline.",config);
    const decision = validateScreeningDecision(proposed,snapshot,config);
    return {snapshot,decision:{...decision,promptVersion:PROMPT_VERSION}};
  } catch {
    return retry(snapshot,"Experimental assessment did not pass bounded source validation.",config);
  }
}
