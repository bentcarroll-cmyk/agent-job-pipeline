// An email moves an application status only along these supported edges;
// other transitions require a candidate decision.
import type { LedgerStatus, LifecycleEvent } from "./types";

export const EVENT_STATUS: Record<LifecycleEvent, LedgerStatus> = {
  application_confirmation: "applied",
  rejection: "closed",
  interview_invitation: "interviewing",
  offer: "offer",
};

const ALLOWED_FROM: Record<string, readonly string[]> = {
  applied: ["new", "needs_materials", "materials_ready", "packet_ready"],
  interviewing: ["applied", "packet_ready", "materials_ready"],
  offer: ["interviewing"],
  closed: ["new", "needs_materials", "materials_ready", "packet_ready", "applied", "interviewing"],
};

// Statuses the candidate chose. A rejection arriving afterwards changes nothing.
const INACTIVE = new Set(["passed", "not_pursuing", "posting_closed"]);

export type TransitionDecision =
  | { action: "apply"; to: LedgerStatus }
  | { action: "unchanged"; reason: "same_status" | "already_inactive" | "older_evidence" }
  | { action: "review"; to: LedgerStatus; reason: "transition_not_allowed" | "status_newer_than_evidence" };

// Compared by day: emails carry a date, while recorded statuses carry a
// processing timestamp that can fall later on the same day.
const day = (s: string) => s.slice(0, 10);

export function decideTransition(
  current: string,
  event: LifecycleEvent,
  currentSince: string | null,
  evidenceAt: string,
): TransitionDecision {
  const to = EVENT_STATUS[event];
  if (current === to) return { action: "unchanged", reason: "same_status" };
  if (event === "rejection" && INACTIVE.has(current)) return { action: "unchanged", reason: "already_inactive" };
  // An email about an earlier stage, no newer than the status already on
  // record, is history (the confirmation that preceded a rejection), not a
  // reason to move backwards. Undated statuses are treated the same way.
  if (statusRank(to) < statusRank(current) && (!currentSince || day(currentSince) >= day(evidenceAt))) {
    return { action: "unchanged", reason: "older_evidence" };
  }
  if (!ALLOWED_FROM[to].includes(current)) return { action: "review", to, reason: "transition_not_allowed" };
  if (currentSince && day(currentSince) > day(evidenceAt)) {
    return { action: "review", to, reason: "status_newer_than_evidence" };
  }
  return { action: "apply", to };
}

// How far along an application is. Every terminal status shares the top
// rank, so moving from any of them to an earlier stage counts as backwards.
export function statusRank(status: string): number {
  switch (status) {
    case "applied":
      return 2;
    case "interviewing":
      return 3;
    case "offer":
      return 4;
    case "closed":
    case "not_pursuing":
    case "passed":
    case "posting_closed":
      return 5;
    default:
      return 1;
  }
}
