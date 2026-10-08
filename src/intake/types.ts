import type { NormalizedJob } from "../sources";
import type { Verdict } from "../criteria";

export type IntakeState = "accepted" | "resolving" | "fetching" | "saved" |
  "screening" | "ready" | "delivering" | "delivered" | "already_tracked" |
  "retry_wait" | "held" | "delivery_unknown";
export type IntakeStage = "resolve" | "fetch" | "save" | "screen" | "deliver";
export type DeliveryState = "pending" | "sending" | "delivered" |
  "retry_wait" | "unknown" | "cancelled" | "held";
export type IntakeRequest = {
  id: string; teamId: string; userId: string; channelId: string; inputUrl: string;
  state: IntakeState; stage: IntakeStage; jobId: string | null;
  ownerRequestId: string | null; workflowGeneration: number;
  workflowId: string; createdAt: string; updatedAt: string;
  nextAttemptAt: number; failureCode: string | null; failureDetail: string | null;
};
export type Admission = {
  id: string; teamId: string; userId: string; channelId: string;
  inputUrl: string; now: string;
};
export type WorkflowParams = { requestId: string; generation: number };
export type WorkflowControl = {
  create(input: { id: string; params: WorkflowParams }): Promise<{ id: string }>;
  status(id: string): Promise<"queued" | "running" | "waiting" | "complete" |
    "errored" | "terminated" | "not_found" | "unknown">;
};
export type DispatchSummary = { examined: number; created: number; alreadyRunning: number;
  deferred: number; unknown: number; exhausted: number };
export type JobClaimResult =
  | { kind: "owned"; requestId: string; jobId: string }
  | { kind: "existing"; jobId: string; applicationStatus: string; notifiedAt: string | null }
  | { kind: "joined"; jobId: string; ownerRequestId: string }
  | { kind: "known_application"; jobId: string; status: string | null; sourceJobId: string | null }
  | { kind: "held"; reason: "ambiguous_application_identity" | "alias_conflict" | "posting_changed" };
export type ManualCard = { requestId: string; job: NormalizedJob;
  verdict: Verdict | null; userId: string; selectedAt: string; advisoryError: string | null };
export type SlackReceipt = { channelId: string; messageTs: string };
export type SendOutcome =
  | { kind: "accepted"; receipt: SlackReceipt }
  | { kind: "retryable_rejection"; code: string; retryAfterMs: number }
  | { kind: "rejected"; code: string }
  | { kind: "unknown"; code: string };
