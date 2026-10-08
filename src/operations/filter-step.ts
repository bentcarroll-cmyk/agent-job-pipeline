import type { DiscoverySteps } from "./discovery-run";
import type { DiscoveryLease } from "./leases";
import { recordFailure } from "./retries";

const INTERRUPTED_ATTEMPT = "Attempt failed due to internal workflows error";

function isInterruptedAttempt(error: unknown): error is { name?: string; message: string } {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  // RPC can reconstruct a custom error as Error. Match this specific runtime
  // failure, not every WorkflowInternalError (which includes corrupt output).
  return (name === undefined || name === "Error" || name === "WorkflowInternalError") &&
    (message === INTERRUPTED_ATTEMPT || message === `WorkflowInternalError: ${INTERRUPTED_ATTEMPT}`);
}

export async function runFilterStep<T extends Rpc.Serializable<T>>(
  step: DiscoverySteps, db: D1Database, lease: DiscoveryLease, id: string, callback: () => Promise<T>,
  persistInterruptedFailure?: (error: string) => Promise<void>,
): Promise<T | { ok: false; error: string }> {
  try {
    return await step.do(`filter:${id}`, { timeout: "8 minutes", retries: { limit: 0, delay: "10 seconds" } }, callback);
  } catch (failure) {
    if (!isInterruptedAttempt(failure)) throw failure;
    // A callback can finish without its result being durably checkpointed.
    // Record that uncertainty outside the failed step. DiscoverySteps renews
    // ownership and recordFailure fences the write; lease loss stays fatal.
    return step.do(`recover-filter:${id}`, async () => {
      const error = `${id}: filter step failed (${failure.name ?? "Error"}): ${failure.message}`;
      if (persistInterruptedFailure) await persistInterruptedFailure(error);
      else await recordFailure(db, lease, id, "filter", error);
      return { ok: false as const, error };
    });
  }
}
