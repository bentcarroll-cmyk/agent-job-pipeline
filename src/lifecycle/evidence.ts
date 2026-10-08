// A classified email → the evidence the ledger planner understands.
import { appliedDay, withinDays } from "../ledger/import/plan";
import type { OutcomeEvidence } from "../ledger/import/types";
import { normalizeTitle } from "../ledger/normalize";
import type { LedgerRow, LifecycleEvent } from "../ledger/types";
import type { Classification } from "./classify";
import { evidenceLine, type EmailMessage } from "./gmail-message";

// Everything the decide step needs about an email; its text stays behind in
// the classify step.
export type EmailMeta = Omit<EmailMessage, "text">;

export type EvidenceResult =
  | { kind: "evidence"; evidence: OutcomeEvidence }
  | { kind: "ignore"; reason: "not_job" | "logistics" }
  | { kind: "fyi"; note: string };

export function toEvidence(email: EmailMeta, c: Classification, rows: LedgerRow[]): EvidenceResult {
  if (c.event === "not_job_related") return { kind: "ignore", reason: "not_job" };
  if (c.event === "interview_logistics") return { kind: "ignore", reason: "logistics" };

  const date = email.date.slice(0, 10);
  let employer = c.employer;
  if (!employer && email.from === "indeedapply@indeed.com" && c.title) {
    // Indeed names the title but not the employer. Attach it only when
    // exactly one application with that title went in within two days.
    const title = normalizeTitle(c.title);
    const near = rows.filter((r) => r.title && normalizeTitle(r.title) === title && withinDays(appliedDay(r), date, 2));
    if (near.length !== 1) {
      return { kind: "fyi", note: `Indeed application for "${c.title}": employer not named and no single match, so not added. Use /job if you want it.` };
    }
    employer = near[0].employer;
  }
  if (!employer) return { kind: "fyi", note: `${evidenceLine(email)}: no employer named, so not matched.` };

  return {
    kind: "evidence",
    evidence: {
      event: c.event as LifecycleEvent,
      employer,
      title: c.title,
      requisitionId: c.requisitionId,
      date,
      evidence: evidenceLine(email),
      sender: email.from,
      ...(email.from.endsWith("@aiapplynotif.com") ? { source: "aiapply" as const } : {}),
    },
  };
}
