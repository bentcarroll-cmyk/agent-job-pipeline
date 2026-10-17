// One email's decision, made by the same planner the ledger import used, plus
// what Undo needs to reverse it exactly.
import { buildPlan } from "../ledger/import/plan";
import { JOBS_STATUS_SOURCE, planStatements, sqlValue } from "../ledger/import/sql";
import type { OutcomeEvidence, Question } from "../ledger/import/types";
import { employerVariants } from "../ledger/normalize";
import type { LedgerRow } from "../ledger/types";
import type { ThreadRound } from "./db";

export type ExistingRound = {
  id: number;
  round: number;
  stage: string | null;
  scheduledFor: string | null;
  // When its invitation arrived: the email's time, or only the day for a
  // round recorded by hand.
  invitedAt: string;
  gmailThreadId: string | null;
};

export type Invitation = { threadId: string; date: string; stage: string | null; scheduledFor: string | null; opensRound: boolean };

// 'update' carries what to write on the row; null leaves a field as it is.
export type RoundPlacement =
  | { action: "new"; round: number }
  | { action: "update"; id: number; scheduledFor: string | null; stage: string | null }
  | { action: "none" };

// The mailbox owner's own mail: Gmail labels what the account sent or drafted
// SENT or DRAFT. An email rebuilt from its receipt (a Slack answer) no longer
// carries the label.
export const fromOwner = (email: { byOwner?: boolean }) => email.byOwner === true;

// The owner's own replies and forwards, AIApply's "A follow-up from …"
// notices, reference checks and NDAs are about a step already under way,
// however the classifier read them.
export function opensRound(email: { from: string; subject: string; byOwner?: boolean }): boolean {
  const from = email.from.toLowerCase();
  if (fromOwner(email)) return false;
  if (from.endsWith("@aiapplynotif.com") && /^a follow-up from\b/i.test(email.subject.trim())) return false;
  return !/\breference checks?\b|\bNDA\b|\bnon-?disclosure\b/i.test(email.subject);
}

// A step the classifier could name; "other" says only that there is one.
const named = (stage: string | null) => (stage && stage !== "other" ? stage : null);

// Mail about one invitation comes within hours of it (the recruiter's note,
// the scheduling system's email, an NDA); the next round's comes after the
// interview.
const SAME_INVITATION_HOURS = 12;

function arrivedWith(round: ExistingRound, date: string): boolean {
  if (round.invitedAt.length <= 10) return date.slice(0, 10) === round.invitedAt;
  return Date.parse(date) - Date.parse(round.invitedAt) < SAME_INVITATION_HOURS * 3_600_000;
}

// Mail in a round's thread is about that round until it has happened; after
// that, a recruiter often writes the next step into the same thread (a
// screen's thread carrying the panel's logistics).
export const happenedBefore = (round: { scheduledFor: string | null }, date: string) =>
  round.scheduledFor !== null && Date.parse(round.scheduledFor) < Date.parse(date);

// One interview brings a varying number of emails, most in threads of their
// own: the invitation, a scheduling link, a calendar invite, a relay. An email
// is the same round as one on record when it shares its thread (until that
// round has happened) or its start time, or when the latest round has not
// happened yet; a second start time for a round still to come is another
// conversation in it, under the same number. The next round opens once the
// latest has happened, when the email names a different step, or when a round
// that never got a time is followed by an invitation the next day.
export function assignRound(existing: ExistingRound[], email: Invitation): RoundPlacement {
  const thread = existing.find((r) => r.gmailThreadId === email.threadId && !happenedBefore(r, email.date));
  if (thread) return { action: "update", id: thread.id, scheduledFor: email.scheduledFor, stage: null };
  if (!existing.length) return { action: "new", round: 1 };
  const at = email.scheduledFor ? Date.parse(email.scheduledFor) : null;
  const twin = at === null ? undefined : existing.find((r) => r.scheduledFor && Date.parse(r.scheduledFor) === at);
  if (twin) return { action: "update", id: twin.id, scheduledFor: null, stage: null };

  const number = Math.max(...existing.map((r) => r.round));
  const latest = existing.filter((r) => r.round === number);
  const stage = named(email.stage);
  const theirs = named(latest.find((r) => named(r.stage))?.stage ?? null);
  const open = (round: number): RoundPlacement => (email.opensRound ? { action: "new", round } : { action: "none" });
  const join = (r: ExistingRound): RoundPlacement => ({
    action: "update",
    id: r.id,
    scheduledFor: r.scheduledFor ? null : email.scheduledFor,
    stage: named(r.stage) ? null : stage,
  });

  if (stage && theirs && stage !== theirs) return open(number + 1);
  const waiting = latest.find((r) => !r.scheduledFor);
  if (waiting) {
    if (at !== null || (stage && stage === theirs) || arrivedWith(waiting, email.date)) return join(waiting);
    return open(number + 1);
  }
  const arrived = Date.parse(email.date);
  if (!latest.some((r) => Date.parse(r.scheduledFor!) >= arrived)) return open(number + 1);
  return at !== null ? open(number) : join(latest[0]);
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
  if (!fromEmployerOrCalendar(email, names)) return null;
  const candidates = roundsOf(latest, ownersNamed(rows, names));
  if (candidates.length !== 1 || candidates[0].scheduledFor) return null;
  return candidates[0];
}

// A scheduling email from the employer about an application with no round on
// record is its invitation in all but name: an "Employer Interview - …" note
// can be the first the tracker hears of an interview.
export function startsFirstRound(
  latest: ThreadRound[],
  rows: LedgerRow[],
  email: { from: string; subject: string },
  c: { employer: string | null; scheduledFor: string | null },
): boolean {
  if (!c.employer || !c.scheduledFor) return false;
  const names = employerVariants(c.employer);
  if (!fromEmployerOrCalendar(email, names)) return false;
  const owners = ownersNamed(rows, names);
  return owners.length > 0 && roundsOf(latest, owners).length === 0;
}

function fromEmployerOrCalendar(email: { from: string; subject: string }, names: string[]): boolean {
  const domain = email.from.split("@")[1]?.toLowerCase() ?? "";
  const labels = domain.split(".").slice(0, -1);
  const fromEmployer = names.some((n) => n.length >= 4 && labels.some((l) => l.includes(n.replace(/ /g, ""))));
  const calendar =
    email.from.toLowerCase() === "calendar-notification@google.com" && /^(updated )?invitation\b/i.test(email.subject.trim());
  return fromEmployer || calendar;
}

const ownersNamed = (rows: LedgerRow[], names: string[]) => rows.filter((r) => employerVariants(r.employer).some((v) => names.includes(v)));

const roundsOf = (latest: ThreadRound[], owners: LedgerRow[]) =>
  latest.filter((round) => owners.some((o) => o.ownerTable === round.ownerTable && o.ownerId === round.ownerId));

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
  return decideWith(rows, evidence, answer ? { [answer.questionId]: answer.value } : {}, now);
}

// Only a reply or a forward continues a conversation. Automated mail lands
// in one thread by its subject line alone (two "Thank you for applying"
// emails, AIApply's relays), so its thread says nothing about whose it is.
export const isReply = (subject: string) => /^\s*(re|fwd?)\s*:/i.test(subject);

// Mail whose wording matches no application (a parent company's name for an
// application recorded under its subsidiary) belongs to the application the
// rest of its conversation settled on: threadOwners, which the caller leaves
// empty unless the email is a reply. The thread only answers "which
// application"; whether the status may change is still the owner's to say.
export function decideInThread(
  rows: LedgerRow[],
  evidence: OutcomeEvidence,
  answer: { questionId: string; value: string } | null,
  threadOwners: string[],
  now: string,
): Decision {
  const answers = answer ? { [answer.questionId]: answer.value } : {};
  const d = decideWith(rows, evidence, answers, now);
  if (d.kind !== "question" || !["unmatched_evidence", "ambiguous_match"].includes(d.question.kind)) return d;
  const owners = [...new Set(threadOwners)];
  if (owners.length !== 1 || !rows.some((r) => r.ownerId === owners[0])) return d;
  return decideWith(rows, evidence, { ...answers, [d.question.id]: owners[0] }, now);
}

function decideWith(rows: LedgerRow[], evidence: OutcomeEvidence, answers: Record<string, string>, now: string): Decision {
  const plan = buildPlan({
    existing: rows,
    candidates: [],
    evidence: [evidence],
    questions: [],
    answers,
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
