// D1 access for the lifecycle tracker. Thin on purpose: the decisions live
// in decide.ts and the ledger engine, which are unit-tested.
import { snapshotRows, type JobRow, type KnownRow } from "../ledger/import/snapshot";
import type { LedgerRow } from "../ledger/types";
import type { ExistingRound } from "./decide";
import type { UpcomingRound } from "./slack-blocks";

export type ReceiptRow = {
  gmail_message_id: string;
  gmail_thread_id: string | null;
  received_at: string;
  evidence: string;
  event: string | null;
  employer: string | null;
  title: string | null;
  requisition_id: string | null;
  round_stage: string | null;
  scheduled_for: string | null;
  decision: string;
  owner_table: string | null;
  owner_id: string | null;
  question_id: string | null;
  question_json: string | null;
  answer: string | null;
  change_json: string | null;
  before_json: string | null;
  attempts: number;
  test: number;
  announced_at: string | null;
  slack_ts: string | null;
  created_at: string;
  updated_at: string;
};

const RECEIPT_COLUMNS: Array<keyof ReceiptRow> = [
  "gmail_message_id", "gmail_thread_id", "received_at", "evidence", "event", "employer", "title", "requisition_id",
  "round_stage", "scheduled_for", "decision", "owner_table", "owner_id", "question_id", "question_json", "answer",
  "change_json", "before_json", "attempts", "test", "announced_at", "slack_ts", "created_at", "updated_at",
];

export async function readLedger(db: D1Database): Promise<LedgerRow[]> {
  const known = await db.prepare("SELECT * FROM known_applications").all<KnownRow>();
  const jobs = await db
    .prepare(
      "SELECT id, company, title, url, application_status, application_status_updated_at, application_status_source, is_known_application, known_application_source FROM jobs WHERE application_status <> 'not_applied' AND is_known_application = 0",
    )
    .all<JobRow>();
  return snapshotRows(known.results, jobs.results);
}

// One email's statements run as one batch, so they land together or not at
// all. Returns the id of the first inserted row, for Undo.
export async function executeStatements(db: D1Database, statements: string[]): Promise<number | null> {
  if (!statements.length) return null;
  const results = await db.batch(statements.map((s) => db.prepare(s)));
  const insertAt = statements.findIndex((s) => s.startsWith("INSERT"));
  return insertAt >= 0 ? Number(results[insertAt].meta.last_row_id) : null;
}

export async function getReceipt(db: D1Database, id: string): Promise<ReceiptRow | null> {
  return (await db.prepare("SELECT * FROM lifecycle_receipts WHERE gmail_message_id = ?").bind(id).first<ReceiptRow>()) ?? null;
}

// Live dedupes only live-settled mail. Preview receipts never consume live eligibility.
export async function handledIds(db: D1Database, ids: string[], live: boolean): Promise<Set<string>> {
  const done = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT gmail_message_id FROM lifecycle_receipts WHERE decision <> 'retry' AND (? = 0 OR test = 0) AND gmail_message_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(live ? 1 : 0, ...chunk)
      .all<{ gmail_message_id: string }>();
    for (const r of results) done.add(r.gmail_message_id);
  }
  return done;
}

// Live also recovers settled preview mail even beyond an old preview checkpoint.
export async function retryReceipts(db: D1Database, live: boolean, since: string): Promise<Array<{ id: string; threadId: string }>> {
  const { results } = await db
    .prepare("SELECT gmail_message_id AS id, gmail_thread_id AS threadId FROM lifecycle_receipts WHERE (decision = 'retry' AND (? = 1 OR test = 1)) OR (? = 1 AND test = 1 AND received_at >= ?)")
    .bind(live ? 1 : 0, live ? 1 : 0, `${since}T00:00:00.000Z`)
    .all<{ id: string; threadId: string }>();
  return results;
}

export type LifecycleWriteBatch = { statements: D1PreparedStatement[]; ownerInsertIndex: number | null };

function receiptStatement(db: D1Database, r: ReceiptRow, captureInsertedOwner = false): D1PreparedStatement {
  const cols = RECEIPT_COLUMNS.join(", ");
  const values = RECEIPT_COLUMNS.map(c => captureInsertedOwner && c === "owner_id" ? "CAST(last_insert_rowid() AS TEXT)"
    : captureInsertedOwner && c === "change_json" ? "json_set(?, '$.status.ownerId', CAST(last_insert_rowid() AS TEXT))" : "?");
  const bindings = RECEIPT_COLUMNS.filter(c => !captureInsertedOwner || c !== "owner_id").map(c => r[c]);
  const updates = RECEIPT_COLUMNS.filter(c => c !== "gmail_message_id" && c !== "created_at")
    .map(c => `${c} = excluded.${c}`).join(", ");
  return db.prepare(`INSERT INTO lifecycle_receipts (${cols}) VALUES (${values.join(", ")})
    ON CONFLICT(gmail_message_id) DO UPDATE SET ${updates}
    WHERE lifecycle_receipts.test = 1 OR excluded.test = 0`).bind(...bindings);
}

// Preview writes can never downgrade a live receipt, even after a stale read.
export async function saveReceipt(db: D1Database, r: ReceiptRow): Promise<boolean> {
  return (await receiptStatement(db, r).run()).meta.changes > 0;
}

// Promotion's ledger/round/schedule writes and receipt are one D1 transaction.
// The existing decision NOT NULL constraint fences an absent/non-preview
// receipt before ANY dependent mutation. A competing live retry keeps its budget.
export async function savePromotedReceipt(db: D1Database, r: ReceiptRow, pending: LifecycleWriteBatch): Promise<boolean> {
  const assertion = db.prepare(`INSERT INTO lifecycle_receipts
    (gmail_message_id, received_at, evidence, decision, created_at, updated_at)
    VALUES (?, ?, ?, (SELECT decision FROM lifecycle_receipts WHERE gmail_message_id = ? AND test = 1), ?, ?)
    ON CONFLICT(gmail_message_id) DO UPDATE SET decision = excluded.decision`)
    .bind(r.gmail_message_id, r.received_at, r.evidence, r.gmail_message_id, r.created_at, r.updated_at);
  const writes = [...pending.statements];
  if (pending.ownerInsertIndex !== null) {
    if (pending.ownerInsertIndex < 0 || pending.ownerInsertIndex >= writes.length || r.owner_table !== "known_applications")
      throw new Error("Invalid lifecycle owner capture");
    // Capture immediately after the application INSERT, before later inserts
    // can change last_insert_rowid(). Both owner_id and change_json use it.
    writes.splice(pending.ownerInsertIndex + 1, 0, receiptStatement(db, r, true));
  } else writes.push(receiptStatement(db, r));
  try { await db.batch([assertion, ...writes]); return true; }
  catch (error) {
    if (String(error).includes("NOT NULL constraint failed: lifecycle_receipts.decision")) return false;
    throw error;
  }
}

export async function unannounced(db: D1Database, test: boolean): Promise<ReceiptRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM lifecycle_receipts WHERE announced_at IS NULL AND test = ? AND decision <> 'retry' ORDER BY received_at")
    .bind(test ? 1 : 0)
    .all<ReceiptRow>();
  return results;
}

export async function markAnnounced(db: D1Database, ids: string[], at: string): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await db.batch(chunk.map((id) => db.prepare("UPDATE lifecycle_receipts SET announced_at = ? WHERE gmail_message_id = ?").bind(at, id)));
  }
}

export async function setSlackTs(db: D1Database, id: string, ts: string): Promise<void> {
  await db.prepare("UPDATE lifecycle_receipts SET slack_ts = ? WHERE gmail_message_id = ?").bind(ts, id).run();
}

export async function staleQuestionCount(db: D1Database, announcedBefore: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM lifecycle_receipts WHERE decision = 'question' AND test = 0 AND announced_at < ?")
    .bind(announcedBefore)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function roundsFor(db: D1Database, ownerTable: string, ownerId: string): Promise<ExistingRound[]> {
  const { results } = await db
    .prepare("SELECT id, round, gmail_thread_id AS gmailThreadId FROM interview_rounds WHERE owner_table = ? AND owner_id = ?")
    .bind(ownerTable, ownerId)
    .all<ExistingRound>();
  return results;
}

export async function insertRound(
  db: D1Database,
  r: { ownerTable: string; ownerId: string; round: number; stage: string | null; invitedAt: string; scheduledFor: string | null; threadId: string; messageId: string; now: string },
  deferred?: D1PreparedStatement[],
): Promise<void> {
  const statement = db.prepare(
      "INSERT INTO interview_rounds (owner_table, owner_id, round, stage, invited_at, scheduled_for, gmail_thread_id, gmail_message_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(r.ownerTable, r.ownerId, r.round, r.stage, r.invitedAt, r.scheduledFor, r.threadId, r.messageId, r.now);
  if (deferred) deferred.push(statement);
  else await statement.run();
}

export type ThreadRound = { id: number; ownerTable: string; ownerId: string; round: number; scheduledFor: string | null };

// The round an email thread belongs to, if one was recorded from it.
export async function roundByThread(db: D1Database, threadId: string): Promise<ThreadRound | null> {
  const row = await db
    .prepare(
      "SELECT id, owner_table AS ownerTable, owner_id AS ownerId, round, scheduled_for AS scheduledFor FROM interview_rounds WHERE gmail_thread_id = ? ORDER BY round DESC LIMIT 1",
    )
    .bind(threadId)
    .first<ThreadRound>();
  return row ?? null;
}

// Each application's highest round.
export async function latestRounds(db: D1Database): Promise<ThreadRound[]> {
  const { results } = await db
    .prepare(
      "SELECT id, owner_table AS ownerTable, owner_id AS ownerId, round, scheduled_for AS scheduledFor FROM interview_rounds r WHERE round = (SELECT MAX(round) FROM interview_rounds x WHERE x.owner_table = r.owner_table AND x.owner_id = r.owner_id)",
    )
    .all<ThreadRound>();
  return results;
}

// Every round with a time, named by its application; the caller picks the
// ones coming up.
export async function scheduledRounds(db: D1Database): Promise<UpcomingRound[]> {
  const { results } = await db
    .prepare(
      "SELECT a.employer, a.title, r.round, r.scheduled_for AS scheduledFor FROM interview_rounds r JOIN applications a ON a.owner_table = r.owner_table AND a.owner_id = r.owner_id WHERE r.scheduled_for IS NOT NULL",
    )
    .all<UpcomingRound>();
  return results;
}

export async function updateRoundSchedule(db: D1Database, id: number, scheduledFor: string, deferred?: D1PreparedStatement[]): Promise<void> {
  const statement = db.prepare("UPDATE interview_rounds SET scheduled_for = ? WHERE id = ?").bind(scheduledFor, id);
  if (deferred) deferred.push(statement);
  else await statement.run();
}

export async function deleteRoundsForMessage(db: D1Database, messageId: string): Promise<void> {
  await db.prepare("DELETE FROM interview_rounds WHERE gmail_message_id = ?").bind(messageId).run();
}

export async function getCheckpoint(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT last_checked_at FROM lifecycle_checkpoints WHERE id = 1").first<{ last_checked_at: string }>();
  return row?.last_checked_at ?? null;
}

export async function setCheckpoint(db: D1Database, at: string): Promise<void> {
  await db
    .prepare("INSERT INTO lifecycle_checkpoints (id, last_checked_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_checked_at = excluded.last_checked_at")
    .bind(at)
    .run();
}
