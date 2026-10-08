// Local comparison contracts. This module is not imported by production Workers.
export type ExperimentVariant = {
  id: "legacy" | "single-evidence" | "qualification-plus-decision" | "single-evidence-alt";
  method: "legacy" | "single-evidence" | "qualification-plus-decision";
  model: string;
  reasoning: string | null;
  promptHash: string;
};
export type ExperimentBudget = {
  cases: number;
  maxVariants: number;
  attemptsPerStage: 2;
  maxCaseWallMs: number;
  maxInputTokensPerStage: number;
  maxOutputTokensFirst: number;
  maxOutputTokensLengthRecovery: number;
  maxEstimatedCostUsd: number;
};
export type ExperimentCase = {
  id: string;
  split: "development" | "holdout" | "observational";
  source: "public" | "synthetic";
  exposed: boolean;
  snapshotHash: string;
};
export type ExperimentManifest = {
  id: string;
  createdAt: string;
  split: ExperimentCase["split"];
  codeHash: string;
  queryHash: string;
  labelHash: string | null;
  budget: ExperimentBudget;
  variants: ExperimentVariant[];
  cases: ExperimentCase[];
  pricing: Array<{model:string;inputUsdPerMillion:number;
    outputUsdPerMillion:number;checkedAt:string}>;
};
export type AttemptReceipt = {
  id: string;
  caseId: string;
  variantId: ExperimentVariant["id"];
  stage: "decision" | "qualification";
  attempt: 1 | 2;
  startedAt: string;
  endedAt: string | null;
  state: "started" | "valid" | "invalid" | "timeout" | "transport_error" | "uncertain";
  inputTokens: number | null;
  outputTokens: number | null;
  requestedModel: string;
  returnedModel: string | null;
  validationCode: string | null;
  resultHash: string | null;
  manifestHash: string;
  snapshotHash: string;
  promptHash: string;
};

const HASH = /^[a-f0-9]{64}$/;
const VARIANT_METHOD: Record<ExperimentVariant["id"], ExperimentVariant["method"]> = {
  legacy: "legacy", "single-evidence": "single-evidence",
  "qualification-plus-decision": "qualification-plus-decision",
  "single-evidence-alt": "single-evidence",
};
function hash(value: unknown): boolean { return typeof value === "string" && HASH.test(value); }
function time(value: unknown): boolean { return typeof value === "string" &&
  value.length <= 40 && Number.isFinite(Date.parse(value)); }
function whole(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

export function validateExperimentBudget(value: ExperimentBudget): void {
  if (!whole(value.cases, 1, 24) || !whole(value.maxVariants, 1, 3) ||
    value.attemptsPerStage !== 2 || !whole(value.maxCaseWallMs, 1, 400000) ||
    !whole(value.maxInputTokensPerStage, 1, 64000) ||
    !whole(value.maxOutputTokensFirst, 1, 4000) ||
    !whole(value.maxOutputTokensLengthRecovery, value.maxOutputTokensFirst, 8000) ||
    !Number.isFinite(value.maxEstimatedCostUsd) || value.maxEstimatedCostUsd < 0) {
    throw new Error("Invalid experiment budget, attempts, wall time, tokens, or cost ceiling");
  }
}

export function validateExperimentManifest(value: ExperimentManifest): void {
  validateExperimentBudget(value.budget);
  if (!hash(value.id) || !hash(value.codeHash) || !hash(value.queryHash) ||
    !(value.labelHash === null || hash(value.labelHash)) || !time(value.createdAt))
    throw new Error("Experiment manifest has an invalid hash or time");
  if (!["development", "holdout", "observational"].includes(value.split) ||
    (value.split === "observational" ? value.labelHash !== null : value.labelHash === null))
    throw new Error("Experiment split and label hash disagree");
  if (value.cases.length !== value.budget.cases || value.variants.length < 1 ||
    value.variants.length > value.budget.maxVariants) throw new Error("Experiment case or variant budget mismatch");
  const caseIds = new Set<string>();
  for (const item of value.cases) {
    if (!item.id || item.id.length > 200 || caseIds.has(item.id))
      throw new Error("Duplicate or invalid experiment case ID");
    caseIds.add(item.id);
    if (item.split !== value.split) throw new Error("Mixed experiment splits are forbidden");
    if (!["public", "synthetic"].includes(item.source) || !hash(item.snapshotHash))
      throw new Error("Invalid public/synthetic snapshot hash");
    if (value.split === "holdout" && item.exposed)
      throw new Error("An exposed case cannot be sealed holdout");
  }
  const variants = new Set<string>();
  for (const variant of value.variants) {
    if (!(variant.id in VARIANT_METHOD) || VARIANT_METHOD[variant.id] !== variant.method ||
      variants.has(variant.id) || !variant.model || variant.model.length > 200 ||
      !(variant.reasoning === null || typeof variant.reasoning === "string" &&
        variant.reasoning.length <= 100) || !hash(variant.promptHash))
      throw new Error("Invalid or duplicate experiment variant or prompt hash");
    variants.add(variant.id);
  }
  const pricing = new Map<string, number>();
  for (const row of value.pricing) {
    if (!row.model || pricing.has(row.model) || !time(row.checkedAt) ||
      !Number.isFinite(row.inputUsdPerMillion) || row.inputUsdPerMillion < 0 ||
      !Number.isFinite(row.outputUsdPerMillion) || row.outputUsdPerMillion < 0)
      throw new Error("Invalid frozen pricing");
    pricing.set(row.model, 1);
  }
  if (value.variants.some(variant => !pricing.has(variant.model)))
    throw new Error("Every variant needs frozen pricing");
  const worstCost = value.cases.length * value.variants.reduce((total, variant) => {
    const rate = value.pricing.find(row => row.model === variant.model)!;
    const stages = variant.method === "qualification-plus-decision" ? 2 : 1;
    return total + stages * (
      (value.budget.maxInputTokensPerStage * 2 * rate.inputUsdPerMillion +
      (value.budget.maxOutputTokensFirst + value.budget.maxOutputTokensLengthRecovery) *
      rate.outputUsdPerMillion) / 1_000_000);
  }, 0);
  if (worstCost > value.budget.maxEstimatedCostUsd)
    throw new Error("Frozen experiment cost ceiling is below worst-case attempts");
}

export function auditAttemptResume(manifest: ExperimentManifest, receipts: AttemptReceipt[]): {
  reused:string[];uncertain:string[];failed:string[];pending:string[] } {
  validateExperimentManifest(manifest);
  const cases = new Map(manifest.cases.map(item => [item.id, item]));
  const variants = new Map(manifest.variants.map(item => [item.id, item]));
  const seen = new Set<string>();
  const result = { reused:[] as string[], uncertain:[] as string[],
    failed:[] as string[], pending:[] as string[] };
  for (const receipt of receipts) {
    const key = `${receipt.caseId}/${receipt.variantId}/${receipt.stage}/${receipt.attempt}`;
    const variant = variants.get(receipt.variantId);
    const item = cases.get(receipt.caseId);
    if (!receipt.id || seen.has(key) || !item || !variant ||
      receipt.manifestHash !== manifest.id || receipt.snapshotHash !== item.snapshotHash ||
      receipt.promptHash !== variant.promptHash || receipt.requestedModel !== variant.model ||
      ![1, 2].includes(receipt.attempt) ||
      !["decision", "qualification"].includes(receipt.stage) ||
      !["started", "valid", "invalid", "timeout", "transport_error", "uncertain"].includes(receipt.state) ||
      (receipt.stage === "qualification" && variant.method !== "qualification-plus-decision") ||
      !time(receipt.startedAt) ||
      !(receipt.endedAt === null || time(receipt.endedAt)) ||
      (receipt.state === "started" ? receipt.endedAt !== null : receipt.endedAt === null) ||
      (receipt.state === "valid" && (!hash(receipt.resultHash) ||
        receipt.returnedModel !== variant.model)) ||
      (receipt.state !== "valid" && receipt.resultHash !== null) ||
      [receipt.inputTokens, receipt.outputTokens].some(tokens => tokens !== null && !whole(tokens, 0, 10_000_000)))
      throw new Error("Attempt receipt identity, snapshot hash, prompt hash, or state mismatch");
    seen.add(key);
    if (receipt.state === "valid") result.reused.push(key);
    else if (receipt.state === "started" || receipt.state === "uncertain") result.uncertain.push(key);
    else result.failed.push(key);
  }
  for (const item of manifest.cases) for (const variant of manifest.variants) {
    const stages = variant.method === "qualification-plus-decision"
      ? ["qualification", "decision"] : ["decision"];
    for (const stage of stages) {
      const prefix = `${item.id}/${variant.id}/${stage}/`;
      if (![...seen].some(key => key.startsWith(prefix))) result.pending.push(`${prefix}1`);
    }
  }
  return result;
}
