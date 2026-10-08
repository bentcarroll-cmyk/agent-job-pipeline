import type { FilterEnv } from "../filter";
import type { JobInsert } from "../db";
import type { DiscoveryLease } from "../operations/leases";
import { recordFailure } from "../operations/retries";
import { screeningRetryDecision } from "./evaluate";
import { createEvaluation, saveScreeningResult, saveScreeningRetry } from "./store";
import type { ScreeningResult } from "./types";

// Called from a storage step after inference has completed. A retry receipt
// shares the cooldown transaction and never creates a discovery jobs row.
export async function saveDiscoveryScreening(db: D1Database, row: JobInsert, result: ScreeningResult, lease: DiscoveryLease, instanceId?: string): Promise<string> {
  const evaluation = await createEvaluation({ jobId: row.job.id, runId: lease.owner, ...result });
  if (result.decision.state === "retry") {
    await saveScreeningRetry(db, evaluation, lease, "filter", result.decision.reason, instanceId);
  } else {
    await saveScreeningResult(db, row, evaluation, lease, instanceId);
  }
  return evaluation.id;
}

export async function recordDiscoveryFailure(env: Pick<FilterEnv, "SCREENING_MODE" | "runtime">, db: D1Database, lease: DiscoveryLease, jobId: string, stage: "fetch" | "filter", error: string, instanceId?: string): Promise<void> {
  if (env.SCREENING_MODE !== "evidence") {
    await recordFailure(db, lease, jobId, stage, error);
    return;
  }
  const decision = screeningRetryDecision(stage === "fetch" ? "Posting retrieval failed; retry after cooldown." : "Screening failed; retry after cooldown.", env.runtime);
  const evaluation = await createEvaluation({ jobId, runId: lease.owner, snapshot: null, decision, stage });
  await saveScreeningRetry(db, evaluation, lease, stage, error, instanceId);
}
