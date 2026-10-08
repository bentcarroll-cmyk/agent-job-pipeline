import type { CompanyCategory, NormalizedJob } from "./sources";
import { VERDICT_TOOL, parseVerdict, type Verdict } from "./criteria";
import { buildCriteriaPrompt } from "./config/prompts";
import type { RuntimeConfig } from "./config/types";
import { enforcePolicyVerdict } from "./config/policy";
import { enforceLocationVerdict } from "./location";

export interface FilterEnv {
  runtime: RuntimeConfig;
  AI: Ai;
  AI_GATEWAY_ID: string;
  SCREENING_MODE?: "legacy" | "evidence";
  // Evidence screening only; legacy screening keeps the model default.
  EVIDENCE_REASONING_EFFORT?: ReasoningEffort;
}

// GLM-5.3-Flash defaults to its maximum reasoning level. Workers AI accepts
// only low, high and max, and silently maps any other name back to max.
export type ReasoningEffort = "low" | "high" | "max";
export function assertReasoningEffort(value: unknown): asserts value is ReasoningEffort | undefined {
  if (value !== undefined && !["low", "high", "max"].includes(value as string)) {
    throw new Error(`Unsupported screening reasoning effort ${JSON.stringify(value)}`);
  }
}

const GLM_MODEL = "@cf/zai-org/glm-5.3-flash";
export interface ModelOptions { timing?: "workflow"; reasoningEffort?: ReasoningEffort }
const DEFAULT_TIMING = { gatewayMs: 90_000, attemptMs: 120_000, totalMs: 180_000 };
// Opt in only where a durable Workflow owns the wait. HTTP background work
// must not inherit a longer lifetime from a discovery release.
const WORKFLOW_TIMING = { gatewayMs: 180_000, attemptMs: 200_000, totalMs: 400_000 };

class InvalidModelResponse extends Error {
  constructor(message: string, readonly truncated = false) { super(message); }
}
class ModelDeadlineExceeded extends Error {
  constructor() { super("model response deadline exceeded"); }
}

export async function filterJob(env: FilterEnv, job: NormalizedJob, companyCategory?: CompanyCategory, options: ModelOptions = {}): Promise<Verdict> {
  const verdict = await sampleModelDecision(env, job.id, {
      messages: [
        { role: "system", content: buildCriteriaPrompt(env.runtime) },
        { role: "user", content: [
          `Company: ${job.company}`,
          `Company category: ${companyCategory ? `${companyCategory} (verified fixed-source configuration)` : "unknown"}`,
          `Title: ${job.title}`,
          `Department: ${job.department}`,
          `Location: ${job.location}`,
          job.locationMetadata ? `Source location metadata: ${JSON.stringify(job.locationMetadata)}` : null,
          job.isRemote !== null ? `Remote flag: ${job.isRemote}` : null,
          job.employmentType ? `Employment type: ${job.employmentType}` : null,
          job.compensation ? `Compensation: ${job.compensation}` : `Compensation: not disclosed`,
          `URL: ${job.url}`,
          job.description ? `\n--- POSTING ---\n${job.description}` : `\n(No posting body available.)`,
        ].filter(Boolean).join("\n") },
      ],
      tools: [VERDICT_TOOL],
      tool_choice: "auto",
  }, parseVerdict, "record_verdict", options);
  const trace = (phase: string) => {
    if (options.timing === "workflow") console.log(JSON.stringify({ event: "screening_phase", jobId: job.id, phase }));
  };
  trace("location_guard_start");
  try {
    const checked = enforceLocationVerdict(job, enforcePolicyVerdict(job, verdict, env.runtime.candidate.policy, companyCategory), env.runtime.candidate.policy);
    trace("location_guard_ok");
    return checked;
  } catch (error) {
    trace("location_guard_error");
    throw error;
  }
}

export async function sampleModelDecision<T>(env: FilterEnv, jobId: string, input: ChatCompletionsInput, parse: (args: string) => T, expectedTool?: string, options: ModelOptions = {}): Promise<T> {
  const effort = options.reasoningEffort;
  assertReasoningEffort(effort);
  const timing = options.timing === "workflow" ? WORKFLOW_TIMING : DEFAULT_TIMING;
  const deadline = Date.now() + timing.totalMs;
  let maxTokens = 4000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = Date.now();
    const diagnostics = { event: "model_attempt", jobId, attempt, maxTokens,
      elapsedMs: 0, finishReason: null as string | null, completionTokens: null as number | null, outcome: "error" };
    try {
      const result = await runFilter(env, input, maxTokens, deadline, timing, effort);
      const choice = result?.choices?.[0];
      diagnostics.finishReason = choice?.finish_reason ?? null;
      diagnostics.completionTokens = result?.usage?.completion_tokens ?? null;
      const toolCall = choice?.message?.tool_calls?.[0];
      // Even a parseable match boolean is not a completed verdict when the
      // provider reports truncation. Never persist a truncated decision.
      if (choice?.finish_reason === "length" || !toolCall) {
        throw new InvalidModelResponse(
          `${toolCall ? "truncated tool call" : "no tool call returned"} (finish_reason=${choice?.finish_reason}, completion_tokens=${result?.usage?.completion_tokens})`,
          choice?.finish_reason === "length",
        );
      }
      let verdict: T;
      try {
        if (!("function" in toolCall)) throw new Error("missing verdict function");
        if (expectedTool && (toolCall.function?.name !== expectedTool || choice?.message?.tool_calls?.length !== 1)) throw new Error("unexpected screening tool call");
        verdict = parse(toolCall.function?.arguments);
      }
      catch (error) { throw new InvalidModelResponse((error as Error).message); }
      diagnostics.outcome = "valid";
      return verdict;
    } catch (error) {
      diagnostics.outcome = error instanceof ModelDeadlineExceeded ? "deadline" : error instanceof InvalidModelResponse ? "invalid" : "transport_error";
      // Only invalid output earns a second sample. Transport failures and
      // deadlines belong to the Workflow's durable cooldown policy.
      if (!(error instanceof InvalidModelResponse)) throw error;
      if (attempt === 2) throw new InvalidModelResponse(`${error.message} (attempts=${attempt}, max_tokens=${maxTokens})`, error.truncated);
      if (error.truncated) maxTokens = 8000;
    } finally {
      diagnostics.elapsedMs = Date.now() - startedAt;
      console.log(JSON.stringify(diagnostics));
    }
  }
  throw new Error("model attempts exhausted");
}

async function runFilter(env: FilterEnv, input: ChatCompletionsInput, maxTokens: number, deadline: number, timing: typeof DEFAULT_TIMING, effort?: ReasoningEffort) {
  const attemptDeadline = Math.min(deadline, Date.now() + timing.attemptMs);
  const remainingMs = attemptDeadline - Date.now();
  if (remainingMs <= 0) throw new ModelDeadlineExceeded();
  const controller = new AbortController();
  const timeoutError = new ModelDeadlineExceeded();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, remainingMs);
  });
  try {
    // Race only inference: the caller still has time to persist the failure.
    // The signal also cancels response-body consumption; the race guarantees
    // settlement even if an adapter ignores cancellation. Late results cannot
    // return a verdict and late rejections remain observed by Promise.race.
    // Max is the model default and absent from the generic generated type,
    // so it is expressed by omitting reasoning_effort.
    const result = await Promise.race([env.AI.run(GLM_MODEL, {
      ...input,
      // Preserve the normal request. Only a length-limited first response
      // earns extra headroom; reasoning consumes this completion budget too.
      max_tokens: maxTokens,
      ...(effort === "low" || effort === "high" ? { reasoning_effort: effort } : {}),
    }, {
      // Gateway timeout bounds initial response arrival, while our deadline
      // includes the whole body and shares a total budget across both samples.
      gateway: { id: env.AI_GATEWAY_ID, requestTimeoutMs: timing.gatewayMs },
      signal: controller.signal,
    }), timeout]);
    // A delayed timer callback must not make an already-expired result valid.
    if (Date.now() >= attemptDeadline) {
      controller.abort(timeoutError);
      throw timeoutError;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
