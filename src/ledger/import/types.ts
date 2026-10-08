import type { LedgerRow, LedgerStatus, LifecycleEvent } from "../types";

export type CandidateSource = "codex_pipeline" | "linear_legacy" | "aiapply";

// A source's claim about one application, before it is reconciled with
// what D1 already holds.
export type Candidate = {
  source: CandidateSource;
  sourceJobId: string | null; // "SYN-101" (pipeline) | "SYN-202" (legacy) | null
  employer: string;
  title: string | null;
  status: LedgerStatus;
  statusAt: string | null; // when the source's status took effect
  appliedAt: string | null;
  postingUrl: string | null;
  requisitionId: string | null;
  // An existing row this candidate is known to be: "SYN-303" matches on
  // source_job_id, "aiapply:<Employer>" on an AIApply row at that employer.
  mergeInto: string | null;
  evidence: string;
};

// One email that says something happened to an application.
export type OutcomeEvidence = {
  event: LifecycleEvent;
  employer: string;
  title: string | null;
  requisitionId: string | null;
  date: string; // YYYY-MM-DD
  evidence: string; // "YYYY-MM-DD · sender · subject"
  // The email's From address, for matching the employer's account when the
  // email names a brand (a brand from example@myworkday.test).
  sender?: string;
  // Who recorded the application when this email adds one.
  source?: "lifecycle_email" | "aiapply";
};

export type QuestionKind =
  | "unconfirmed_legacy" // options: applied | not_pursuing | closed | skip
  | "aiapply_digest_only" // options: applied | skip
  | "ambiguous_match" // options: row ids | new | skip
  | "unmatched_evidence" // options: row ids | new | skip
  | "transition_review" // options: apply | skip
  | "backward_move"; // options: keep | apply

// Selected import answers are keyed by question id.
// optionLabels names the row-id options for Slack buttons.
export type Question = {
  id: string;
  kind: QuestionKind;
  text: string;
  evidence: string;
  options: string[];
  optionLabels?: Record<string, string>;
};

export type NewRow = LedgerRow & { evidence: string[] };

export type RowChange = {
  ownerTable: "known_applications" | "jobs";
  ownerId: string;
  employer: string;
  title: string | null;
  sourceJobId: string | null;
  before: LedgerRow;
  after: LedgerRow;
  evidence: string[];
};

// A duplicate known_applications row, deleted in favour of the row it
// duplicates (decisions.json → merge_rows).
export type DeletedRow = { ownerId: string; employer: string; title: string | null; mergedInto: string };

// A duplicate jobs row. The posting stays; it is linked to the application
// it duplicates, which takes it out of the applications view and keeps its
// status in step with that application from then on.
export type LinkedRow = { jobId: string; employer: string; title: string | null; mergedInto: string; sourceJobId: string };

export type ImportPlan = {
  generatedAt: string;
  inserts: NewRow[];
  updates: RowChange[];
  deletes: DeletedRow[];
  links: LinkedRow[];
  // Which row each email landed on: the lifecycle tracker's receipts need it
  // even when nothing changed.
  matches: Array<{ evidenceId: string; ownerId: string; outcome: "applied" | "unchanged" | "inserted" }>;
  questions: Question[];
  // Every ledger row as it should read after the import: the verify step's
  // reference.
  projected: LedgerRow[];
};
