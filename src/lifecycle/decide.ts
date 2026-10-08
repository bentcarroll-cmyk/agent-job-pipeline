// One email's decision, made by the same planner the ledger import used, plus
// what Undo needs to reverse it exactly.
import { buildPlan } from "../ledger/import/plan";
import { JOBS_STATUS_SOURCE, planStatements, sqlValue } from "../ledger/import/sql";
import type { OutcomeEvidence, Question } from "../ledger/import/types";
import { employerVariants } from "../ledger/normalize";
import type { LedgerRow } from "../ledger/types";
import type { ThreadRound } from "./db";

export type ExistingRound = { id: number; round: number; gmailThreadId: string | null };

// Another email in a thread that already has a round is the same round (a
// follow-up or a reschedule); a new thread is the next round.
export function assignRound(existing: ExistingRound[], threadId: string): { action: "new"; round: number } | { action: "update"; id: number } {
  const same = existing.find((r) => r.gmailThreadId === threadId);
  if (same) return { action: "update", id: same.id };
  return { action: "new", round: Math.max(0, ...existing.map((r) => r.round)) + 1 };
}

// A calendar invite can arrive in a separate thread, so thread matching
// alone cannot place it. It carries the time of the
// named employer's latest round when that round has no time yet, and only
// when it comes from the employer's domain or from Google Calendar itself, so
// a newsletter that mentions an interview, or titles itself "Invitation: …",
// can't set one.
export function roundForInvite(
  latest: ThreadRound[],
  rows: LedgerRow[],
  email: { from: string; subject: string },
  employer: string | null,
): ThreadRound | null {
  if (!employer) return null;
  const names = employerVariants(employer);
  const domain = email.from.split("@")[1]?.toLowerCase() ?? "";
  const labels = domain.split(".").slice(0, -1);
  const fromEmployer = names.some((n) => n.length >= 4 && labels.some((l) => l.includes(n.replace(/ /g, ""))));
  const calendar =
    email.from.toLowerCase() === "calendar-notification@google.com" && /^(updated )?invitation\b/i.test(email.subject.trim());
  if (!fromEmployer && !calendar) return null;
  const owners = rows.filter((r) => employerVariants(r.employer).some((v) => names.includes(v)));
  const candidates = latest.filter((round) => owners.some((o) => o.ownerTable === round.ownerTable && o.ownerId === round.ownerId));
  if (candidates.length !== 1 || candidates[0].scheduledFor) return null;
  return candidates[0];
}

type Owner = "known_applications" | "jobs";

export type Change = { kind: "updated" | "added"; ownerTable: Owner; ownerId: string; employer: string; title: string | null; from: string | null; to: string };

export type BeforeState =
  | { kind: "insert" }
  | {
      kind: "update";
      ownerTable: Owner;
      ownerId: string;
      sourceJobId: string | null;
      status: string;
      statusUpdatedAt: string | null;
      statusSource: string | null;
      appliedAt: string | null;
      title: string | null;
    };

export type Decision =
  | { kind: "applied"; change: Change; before: BeforeState; statements: string[] }
  | { kind: "unchanged"; ownerTable: Owner; ownerId: string; statements: string[] }
  | { kind: "question"; question: Question }
  | { kind: "skipped" };

export function decide(
  rows: LedgerRow[],
  evidence: OutcomeEvidence,
  answer: { questionId: string; value: string } | null,
  now: string,
): Decision {
  const plan = buildPlan({
    existing: rows,
    candidates: [],
    evidence: [evidence],
    questions: [],
    answers: answer ? { [answer.questionId]: answer.value } : {},
    generatedAt: now,
  });
  if (plan.questions.length) return { kind: "question", question: plan.questions[0] };
  const match = plan.matches[0];
  if (!match) return { kind: "skipped" };
  // Even an unchanged match can backfill a date.
  const statements = planStatements(plan);

  if (match.outcome === "inserted") {
    const r = plan.inserts[0];
    return {
      kind: "applied",
      change: { kind: "added", ownerTable: "known_applications", ownerId: r.ownerId, employer: r.employer, title: r.title, from: null, to: r.status },
      before: { kind: "insert" },
      statements,
    };
  }
  const row = plan.projected.find((r) => r.ownerId === match.ownerId)!;
  const owner = row.ownerTable as Owner;
  if (match.outcome === "unchanged") return { kind: "unchanged", ownerTable: owner, ownerId: row.ownerId, statements };

  const u = plan.updates.find((x) => x.ownerId === match.ownerId)!;
  return {
    kind: "applied",
    change: { kind: "updated", ownerTable: owner, ownerId: u.ownerId, employer: u.employer, title: u.title, from: u.before.status, to: u.after.status },
    before: {
      kind: "update",
      ownerTable: owner,
      ownerId: u.ownerId,
      sourceJobId: u.before.sourceJobId,
      status: u.before.status,
      statusUpdatedAt: u.before.statusUpdatedAt,
      statusSource: u.before.statusSource,
      appliedAt: u.before.appliedAt,
      title: u.before.title,
    },
    statements,
  };
}

export function undoStatements(before: BeforeState, ownerId: string): string[] {
  if (before.kind === "insert") return [`DELETE FROM known_applications WHERE id = ${Number(ownerId)};`];
  if (before.ownerTable === "jobs") {
    return [
      `UPDATE jobs SET application_status = ${sqlValue(before.status)}, application_status_updated_at = ${sqlValue(before.statusUpdatedAt)}, application_status_source = ${sqlValue(before.statusSource ?? "pipeline")} WHERE id = ${sqlValue(before.ownerId)};`,
    ];
  }
  const out = [
    `UPDATE known_applications SET status = ${sqlValue(before.status)}, status_updated_at = ${sqlValue(before.statusUpdatedAt)}, status_source = ${sqlValue(before.statusSource ?? "initial_import")}, applied_at = ${sqlValue(before.appliedAt)}, title = ${sqlValue(before.title)} WHERE id = ${Number(before.ownerId)};`,
  ];
  // The postings mirroring it go back too, labelled the way the import
  // labels them.
  if (before.sourceJobId) {
    const source = JOBS_STATUS_SOURCE[before.statusSource ?? ""] ?? "import";
    out.push(
      `UPDATE jobs SET application_status = ${sqlValue(before.status)}, application_status_source = ${sqlValue(source)}, application_status_updated_at = ${sqlValue(before.statusUpdatedAt)} WHERE known_application_source = ${sqlValue(before.sourceJobId)};`,
    );
  }
  return out;
}
