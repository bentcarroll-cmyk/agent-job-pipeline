// Shared by the ledger import and the Gmail lifecycle tracker.

export type LedgerStatus =
  | "new"
  | "needs_materials"
  | "materials_ready"
  | "packet_ready"
  | "applied"
  | "interviewing"
  | "offer"
  | "closed"
  | "not_pursuing"
  | "passed"
  | "posting_closed";

export type LifecycleEvent = "application_confirmation" | "rejection" | "interview_invitation" | "offer";

// One row of the `applications` view, or a row the import is about to create
// (ownerTable "new"). Field names mirror the view's columns.
export type LedgerRow = {
  ownerTable: "known_applications" | "jobs" | "new";
  ownerId: string;
  employer: string;
  title: string | null;
  status: string;
  statusUpdatedAt: string | null;
  source: string;
  sourceJobId: string | null;
  canonicalId: string | null;
  postingUrl: string | null;
  requisitionId: string | null;
  appliedAt: string | null;
  statusSource: string | null;
};
