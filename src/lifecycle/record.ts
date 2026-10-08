// The decide step, the announce step, and Slack answer/undo, all built on
// the tested pieces: evidence.ts, decide.ts and slack-blocks.ts.
import type { InstanceConfig } from "../config/types";
import type { OutcomeEvidence, Question } from "../ledger/import/types";
import type { LedgerRow, LifecycleEvent } from "../ledger/types";
import { postBlocks, postText, updateMessage, type SlackEnv, type SlackPostEnv } from "../slack";
import type { Classification } from "./classify";
import {
  deleteRoundsForMessage,
  executeStatements,
  getReceipt,
  insertRound,
  latestRounds,
  markAnnounced,
  readLedger,
  roundByThread,
  roundsFor,
  saveReceipt,
  savePromotedReceipt,
  type LifecycleWriteBatch,
  scheduledRounds,
  setSlackTs,
  staleQuestionCount,
  unannounced,
  updateRoundSchedule,
  type ReceiptRow,
} from "./db";
import { assignRound, decide, roundForInvite, undoStatements, type BeforeState, type Change, type Decision } from "./decide";
import { toEvidence, type EmailMeta } from "./evidence";
import { evidenceLine } from "./gmail-message";
import {
  changeLine,
  markUndone,
  questionText,
  renderAnswered,
  renderQuestion,
  renderSummary,
  renderUpcoming,
  roundLine,
  type SummaryItem,
} from "./slack-blocks";

export type Classified =
  | { id: string; email: EmailMeta; ok: true; c: Classification }
  | { id: string; email: EmailMeta; ok: false; error: string };

type RoundNote = { round: number; stage: string | null; employer: string; title: string | null };
type ScheduledNote = { round: number; scheduledFor: string; employer: string; title: string | null };
type ChangeJson = { status?: Change; round?: RoundNote; scheduled?: ScheduledNote; note?: string };

function baseReceipt(email: EmailMeta, prior: ReceiptRow | null, live: boolean, now: string): ReceiptRow {
  return {
    gmail_message_id: email.id,
    gmail_thread_id: email.threadId,
    received_at: email.date,
    evidence: evidenceLine(email),
    event: null,
    employer: null,
    title: null,
    requisition_id: null,
    round_stage: null,
    scheduled_for: null,
    decision: "ignored",
    owner_table: null,
    owner_id: null,
    question_id: null,
    question_json: null,
    answer: null,
    change_json: null,
    before_json: null,
    attempts: prior?.attempts ?? 0,
    test: live ? 0 : 1,
    announced_at: null,
    slack_ts: null,
    created_at: prior?.created_at ?? now,
    updated_at: now,
  };
}

// Adds (or, for another email in the same thread, updates) an interview
// round. In test mode it only works out what the round would be.
async function recordRound(
  db: D1Database,
  owner: { table: string; id: string; employer: string; title: string | null },
  email: EmailMeta,
  c: Classification,
  live: boolean,
  now: string,
  pending?: LifecycleWriteBatch,
): Promise<RoundNote | null> {
  if (owner.id.startsWith("new:")) return null;
  const a = assignRound(await roundsFor(db, owner.table, owner.id), email.threadId);
  if (a.action === "update") {
    if (live && c.scheduledFor) await updateRoundSchedule(db, a.id, c.scheduledFor, pending?.statements);
    return null;
  }
  if (live) {
    await insertRound(db, {
      ownerTable: owner.table,
      ownerId: owner.id,
      round: a.round,
      stage: c.roundStage,
      invitedAt: email.date.slice(0, 10),
      scheduledFor: c.scheduledFor,
      threadId: email.threadId,
      messageId: email.id,
      now,
    }, pending?.statements);
  }
  return { round: a.round, stage: c.roundStage, employer: owner.employer, title: owner.title };
}

// A scheduling email in a thread that already has a round carries that
// round's time ("Re: Next Steps… confirmed for Wednesday at 11"); so does a
// calendar invite from the employer (see roundForInvite). Nothing else about
// a logistics email is recorded.
async function recordSchedule(
  db: D1Database,
  email: EmailMeta,
  c: Classification,
  rows: LedgerRow[],
  live: boolean,
  pending?: LifecycleWriteBatch,
): Promise<{ ownerTable: string; ownerId: string; note: ScheduledNote } | null> {
  if (!c.scheduledFor) return null;
  const round = (await roundByThread(db, email.threadId)) ?? roundForInvite(await latestRounds(db), rows, email, c.employer);
  if (!round || round.scheduledFor === c.scheduledFor) return null;
  if (live) await updateRoundSchedule(db, round.id, c.scheduledFor, pending?.statements);
  const owner = rows.find((x) => x.ownerId === round.ownerId);
  return {
    ownerTable: round.ownerTable,
    ownerId: round.ownerId,
    note: { round: round.round, scheduledFor: c.scheduledFor, employer: owner?.employer ?? "", title: owner?.title ?? null },
  };
}

// Applies a decision (live only) and fills in the receipt. Shared by the
// daily run and by Slack answers.
async function applyDecision(
  db: D1Database,
  r: ReceiptRow,
  d: Decision,
  email: EmailMeta,
  c: Classification,
  live: boolean,
  now: string,
  decidedAs: "applied" | "answered",
  pending?: LifecycleWriteBatch,
): Promise<ReceiptRow> {
  if (d.kind === "question") {
    return { ...r, decision: "question", question_id: d.question.id, question_json: JSON.stringify(d.question) };
  }
  if (d.kind === "skipped") return { ...r, decision: "ignored" };

  let ownerTable: string = d.kind === "applied" ? d.change.ownerTable : d.ownerTable;
  let ownerId = d.kind === "applied" ? d.change.ownerId : d.ownerId;
  if (live) {
    if (pending) {
      if (d.kind === "applied" && d.change.kind === "added") {
        const index = d.statements.findIndex(s => s.startsWith("INSERT INTO known_applications "));
        if (index < 0) throw new Error("Missing lifecycle application insert");
        pending.ownerInsertIndex = pending.statements.length + index;
        ownerTable = "known_applications";
      }
      pending.statements.push(...d.statements.map(s => db.prepare(s)));
    } else {
      const inserted = await executeStatements(db, d.statements);
      if (d.kind === "applied" && d.change.kind === "added" && inserted !== null) {
        ownerTable = "known_applications";
        ownerId = String(inserted);
      }
    }
  }

  const rows = c.event === "interview_invitation" ? await readLedger(db) : [];
  const owner = rows.find((x) => x.ownerId === ownerId);
  const round =
    c.event === "interview_invitation" && owner
      ? await recordRound(db, { table: ownerTable, id: ownerId, employer: owner.employer, title: owner.title }, email, c, live, now, pending)
      : null;

  const change: ChangeJson = {};
  if (d.kind === "applied") change.status = { ...d.change, ownerTable: ownerTable as Change["ownerTable"], ownerId };
  if (round) change.round = round;
  // A status change or a new round is announced (and undoable); anything
  // else, such as a backfilled date or a reminder in a known thread, is not.
  const announced = change.status || change.round;
  return {
    ...r,
    decision: announced ? decidedAs : "unchanged",
    owner_table: ownerTable,
    owner_id: ownerId,
    change_json: announced ? JSON.stringify(change) : null,
    before_json: d.kind === "applied" ? JSON.stringify(d.before) : round ? JSON.stringify({ kind: "round" }) : null,
  };
}

export async function decideAndRecord(db: D1Database, item: Classified, live: boolean, now: string): Promise<string> {
  const stored = await getReceipt(db, item.id);
  const promotion = live && stored?.test === 1;
  // Settled live receipts dedupe in either mode; preview cannot alter live retries.
  if (stored && ((!live && stored.test === 0) || (!promotion && stored.decision !== "retry"))) return stored.decision;
  const prior = promotion ? { ...stored!, attempts: 0 } : stored;
  const pending: LifecycleWriteBatch | undefined = promotion ? { statements: [], ownerInsertIndex: null } : undefined;
  const persist = async (receipt: ReceiptRow): Promise<string> => {
    const saved = pending ? await savePromotedReceipt(db, receipt, pending) : await saveReceipt(db, receipt);
    if (saved) return receipt.decision;
    const current = await getReceipt(db, item.id);
    if (!current) throw new Error("Lifecycle receipt promotion lost eligibility");
    return current.decision;
  };
  let r = baseReceipt(item.email, prior, live, now);

  if (!item.ok) {
    const attempts = (prior?.attempts ?? 0) + 1;
    const decision = attempts >= 3 ? "failed" : "retry";
    return persist({ ...r, decision, attempts });
  }

  const c = item.c;
  r = { ...r, event: c.event, employer: c.employer, title: c.title, requisition_id: c.requisitionId, round_stage: c.roundStage, scheduled_for: c.scheduledFor };
  const rows = await readLedger(db);
  const ev = toEvidence(item.email, c, rows);
  if (ev.kind === "ignore") {
    if (ev.reason === "logistics") {
      const scheduled = await recordSchedule(db, item.email, c, rows, live, pending);
      if (scheduled) {
        return persist({
          ...r,
          decision: "scheduled",
          owner_table: scheduled.ownerTable,
          owner_id: scheduled.ownerId,
          change_json: JSON.stringify({ scheduled: scheduled.note }),
        });
      }
    }
    const decision = ev.reason === "not_job" ? "not_job" : "ignored";
    return persist({ ...r, decision });
  }
  if (ev.kind === "fyi") {
    return persist({ ...r, decision: "fyi", change_json: JSON.stringify({ note: ev.note }) });
  }
  // Stored as resolved (an Indeed email's employer), so an answer rebuilds
  // the same evidence and the same question id.
  r = { ...r, employer: ev.evidence.employer };
  const d = decide(rows, ev.evidence, null, now);
  const saved = await applyDecision(db, r, d, item.email, c, live, now, "applied", pending);
  return persist(saved);
}

export function evidenceFromReceipt(r: ReceiptRow): OutcomeEvidence {
  return {
    event: r.event as LifecycleEvent,
    employer: r.employer ?? "",
    title: r.title,
    requisitionId: r.requisition_id,
    date: r.received_at.slice(0, 10),
    evidence: r.evidence,
    sender: r.evidence.split(" · ")[1],
    ...(r.evidence.includes("@aiapplynotif.com") ? { source: "aiapply" as const } : {}),
  };
}

const classificationOf = (r: ReceiptRow): Classification => ({
  event: r.event as Classification["event"],
  employer: r.employer,
  title: r.title,
  requisitionId: r.requisition_id,
  roundStage: r.round_stage as Classification["roundStage"],
  scheduledFor: r.scheduled_for,
});

const metaOf = (r: ReceiptRow): EmailMeta => ({
  id: r.gmail_message_id,
  threadId: r.gmail_thread_id ?? r.gmail_message_id,
  from: r.evidence.split(" · ")[1] ?? "",
  subject: r.evidence.split(" · ").slice(2).join(" · "),
  date: r.received_at,
});

export function summaryItems(receipts: ReceiptRow[]): { items: SummaryItem[]; questions: ReceiptRow[] } {
  const items: SummaryItem[] = [];
  const questions: ReceiptRow[] = [];
  for (const r of receipts) {
    if (r.decision === "applied" && r.change_json) {
      const ch = JSON.parse(r.change_json) as ChangeJson;
      const date = r.received_at.slice(0, 10);
      if (ch.status) items.push({ kind: "change", messageId: r.gmail_message_id, change: ch.status, event: r.event ?? "", date });
      if (ch.round) items.push({ kind: "round", messageId: r.gmail_message_id, ...ch.round, date });
    } else if (r.decision === "scheduled" && r.change_json) {
      const s = (JSON.parse(r.change_json) as ChangeJson).scheduled;
      if (s) items.push({ kind: "scheduled", messageId: r.gmail_message_id, ...s });
    } else if (r.decision === "fyi" && r.change_json) {
      items.push({ kind: "fyi", note: (JSON.parse(r.change_json) as ChangeJson).note ?? "" });
    } else if (r.decision === "failed") {
      items.push({ kind: "fyi", note: `Couldn't read after 3 tries: ${r.evidence}` });
    } else if (r.decision === "question") {
      questions.push(r);
    }
  }
  return { items, questions };
}

export async function announce(env: SlackPostEnv & { DB: D1Database; instance: Pick<InstanceConfig, "schedule"> }, live: boolean, now: string): Promise<void> {
  const pending = await unannounced(env.DB, !live);
  const { items, questions } = summaryItems(pending);
  if (!live) for (const q of questions) items.push({ kind: "question", text: questionText(JSON.parse(q.question_json!) as Question) });
  const stale = live ? await staleQuestionCount(env.DB, new Date(Date.parse(now) - 2 * 86_400_000).toISOString()) : 0;

  const dateLabel = new Date(now).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: env.instance.schedule.timezone });
  if (items.length || stale) {
    for (const m of renderSummary(items, { test: !live, dateLabel, staleQuestions: stale, timezone: env.instance.schedule.timezone })) await postBlocks(env, m.text, m.blocks);
  }
  // From recorded times, so it is posted in test mode too.
  const upcoming = renderUpcoming(await scheduledRounds(env.DB), now, env.instance.schedule.timezone);
  if (upcoming) await postText(env, upcoming);
  if (live) {
    for (const q of questions) {
      const question = JSON.parse(q.question_json!) as Question;
      const ts = await postBlocks(env, `Question: ${question.text}`, renderQuestion(question, q.gmail_message_id, q.evidence));
      await setSlackTs(env.DB, q.gmail_message_id, ts);
    }
  }
  await markAnnounced(env.DB, pending.map((r) => r.gmail_message_id), now);
}

// A tapped answer: apply it now and rewrite the question message.
export async function answerQuestion(
  env: SlackEnv & { DB: D1Database },
  messageId: string,
  option: string,
  where: { channelId: string; messageTs: string },
): Promise<void> {
  const db = env.DB;
  const now = new Date().toISOString();
  const r = await getReceipt(db, messageId);
  if (!r || r.decision !== "question" || !r.question_id) return;
  const question = JSON.parse(r.question_json!) as Question;
  const rows = await readLedger(db);
  const d = decide(rows, evidenceFromReceipt(r), { questionId: r.question_id, value: option }, now);
  const saved = await applyDecision(db, { ...r, answer: option, updated_at: now }, d, metaOf(r), classificationOf(r), true, now, "answered");
  await saveReceipt(db, saved);

  if (saved.decision === "question") {
    // The answer led to a second question (for example, reopening a closed application).
    const next = JSON.parse(saved.question_json!) as Question;
    await updateMessage(env, where.channelId, where.messageTs, renderQuestion(next, messageId, r.evidence), `Question: ${next.text}`);
    return;
  }
  const ch = saved.change_json ? (JSON.parse(saved.change_json) as ChangeJson) : {};
  const outcome = ch.status
    ? changeLine(ch.status, r.event ?? "", r.received_at)
    : ch.round
      ? roundLine({ ...ch.round, date: r.received_at })
      : saved.decision === "ignored"
        ? "Ignored."
        : "Recorded; nothing needed to change.";
  await updateMessage(env, where.channelId, where.messageTs, renderAnswered(question, outcome, messageId), outcome);
}

// A tapped Undo: restore the row exactly as it was and strike the line. The
// receipt becomes 'ignored', so the email is never picked up again.
export async function undoChange(
  env: SlackEnv & { DB: D1Database },
  messageId: string,
  where: { channelId: string; messageTs: string; blocks: unknown[]; text: string },
): Promise<void> {
  const db = env.DB;
  const r = await getReceipt(db, messageId);
  if (!r || !["applied", "answered"].includes(r.decision) || !r.before_json) return;
  const before = JSON.parse(r.before_json) as BeforeState | { kind: "round" };
  if (before.kind !== "round" && r.owner_id) await executeStatements(db, undoStatements(before, r.owner_id));
  await deleteRoundsForMessage(db, messageId);
  await saveReceipt(db, { ...r, decision: "ignored", updated_at: new Date().toISOString() });
  await updateMessage(env, where.channelId, where.messageTs, markUndone(where.blocks as any[], messageId), where.text);
}
