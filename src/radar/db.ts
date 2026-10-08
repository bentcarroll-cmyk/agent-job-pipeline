// D1 access for the AI radar. Thin on purpose: the decisions live in the
// pure modules beside it, which have their own unit tests.
import type { XPost } from "./x-client";

export type Mark = "useful" | "not_useful" | "mute";
export type Metrics = { likes: number; reposts: number; replies: number; quotes: number; views: number | null };
export type TasteExample = { kind: string; topic: string; text: string };

export type PostRow = {
  id: string;
  url: string;
  author_handle: string;
  author_name: string | null;
  author_bio: string | null;
  author_followers: number | null;
  author_created_at: string | null;
  text: string;
  created_at: string;
  quoted_id: string | null;
  quoted_text: string | null;
  conversation_id: string | null;
  metrics_json: string;
  found_by: string;
  first_seen_run: string;
  triage_state: "pending" | "done" | "failed";
  kind: string | null;
  topic: string | null;
  score: number | null;
  reason: string | null;
  digest_date: string | null;
  feedback: string | null;
  feedback_at: string | null;
};

export type RunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  since_time: string | null;
  status: "running" | "posted" | "notice" | "failed";
  collect_ok: number;
  posts_read: number;
  requests: number;
  est_cost_usd: number;
  cut_short: string | null;
  triage_batches: number;
  triage_failed: number;
  editor_input_tokens: number | null;
  editor_output_tokens: number | null;
  editor_fallback: number;
  errors: string | null;
  digest_json: string | null;
  slack_ts: string | null;
};

const BOOST_STEP = 0.25;

// ------------------------------------------------------------------- posts

// A post keeps the first run that saw it; later sightings only add the
// search that found them. So a run's new posts survive a retried collect
// step, and a post seen yesterday is never new again.
export async function savePosts(db: D1Database, runId: string, posts: XPost[], foundBy: string): Promise<void> {
  if (!posts.length) return;
  await db.batch(posts.map((p) => {
    const metrics: Metrics = { likes: p.likes, reposts: p.reposts, replies: p.replies, quotes: p.quotes, views: p.views };
    return db.prepare(
      `INSERT INTO radar_posts (id, url, author_handle, author_name, author_bio, author_followers, author_created_at, text,
         created_at, quoted_id, quoted_text, conversation_id, metrics_json, found_by, first_seen_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json_array(?), ?)
       ON CONFLICT(id) DO UPDATE SET found_by = CASE
         WHEN EXISTS (SELECT 1 FROM json_each(radar_posts.found_by) WHERE value = ?) THEN radar_posts.found_by
         ELSE json_insert(radar_posts.found_by, '$[#]', ?) END`,
    ).bind(
      p.id, p.url, p.authorHandle, p.authorName, p.authorBio, p.authorFollowers, p.authorCreatedAt, p.text,
      p.createdAt, p.quoted?.id ?? null, p.quoted?.text ?? null, p.conversationId, JSON.stringify(metrics),
      foundBy, runId, foundBy, foundBy,
    );
  }));
}

// This run's new posts, oldest first, minus muted authors.
export async function newPostIds(db: D1Database, runId: string): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT p.id FROM radar_posts p LEFT JOIN radar_authors a ON a.handle = lower(p.author_handle)
     WHERE p.first_seen_run = ? AND COALESCE(a.muted, 0) = 0 ORDER BY p.created_at, p.id`,
  ).bind(runId).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

export async function getPosts(db: D1Database, ids: string[]): Promise<PostRow[]> {
  const found: PostRow[] = [];
  // D1 caps bound parameters per statement; 50 stays well inside it.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = await db.prepare(`SELECT * FROM radar_posts WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<PostRow>();
    found.push(...rows.results);
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return found.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export async function saveTriage(
  db: D1Database,
  results: Array<{ id: string; kind: string; topic: string; score: number; reason: string }>,
): Promise<void> {
  if (!results.length) return;
  await db.batch(results.map((r) =>
    db.prepare("UPDATE radar_posts SET triage_state = 'done', kind = ?, topic = ?, score = ?, reason = ? WHERE id = ?")
      .bind(r.kind, r.topic, r.score, r.reason, r.id),
  ));
}

export async function markTriageFailed(db: D1Database, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare("UPDATE radar_posts SET triage_state = 'failed' WHERE id = ?").bind(id)));
}

// Triaged posts from this run that could make the digest, with their
// author's boost.
export async function triagedRows(db: D1Database, runId: string): Promise<Array<PostRow & { boost: number }>> {
  const rows = await db.prepare(
    `SELECT p.*, COALESCE(a.boost, 0) AS boost FROM radar_posts p
     LEFT JOIN radar_authors a ON a.handle = lower(p.author_handle)
     WHERE p.first_seen_run = ? AND p.triage_state = 'done' AND p.kind <> 'noise' AND p.score > 0
       AND COALESCE(a.muted, 0) = 0
     ORDER BY p.id`,
  ).bind(runId).all<PostRow & { boost: number }>();
  return rows.results;
}

export async function markDigest(db: D1Database, ids: string[], date: string): Promise<void> {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare("UPDATE radar_posts SET digest_date = ? WHERE id = ?").bind(date, id)));
}

export async function tasteExamples(db: D1Database, limit = 10): Promise<{ useful: TasteExample[]; notUseful: TasteExample[] }> {
  const recent = async (mark: Mark) =>
    (await db.prepare(
      `SELECT kind, topic, substr(text, 1, 200) AS text FROM radar_posts
       WHERE feedback = ? AND kind IS NOT NULL ORDER BY feedback_at DESC LIMIT ?`,
    ).bind(mark, limit).all<TasteExample>()).results;
  return { useful: await recent("useful"), notUseful: await recent("not_useful") };
}

// Only the 72-hour collection window needs dedup, so posts that were never
// delivered or marked can go after a while.
export async function prunePosts(db: D1Database, beforeIso: string): Promise<number> {
  const result = await db.prepare("DELETE FROM radar_posts WHERE created_at < ? AND digest_date IS NULL AND feedback IS NULL")
    .bind(beforeIso).run();
  return result.meta.changes ?? 0;
}

// -------------------------------------------------------------------- runs

export async function startRun(db: D1Database, runId: string, startedAt: string, sinceIso: string): Promise<void> {
  await db.prepare("INSERT INTO radar_runs (id, started_at, since_time, status) VALUES (?, ?, ?, 'running') ON CONFLICT(id) DO NOTHING")
    .bind(runId, startedAt, sinceIso).run();
}

export async function otherRunInProgress(db: D1Database, runId: string, sinceIso: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS busy FROM radar_runs WHERE status = 'running' AND id <> ? AND started_at >= ? LIMIT 1")
    .bind(runId, sinceIso).first();
  return row !== null;
}

export async function lastCollectStart(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT started_at FROM radar_runs WHERE collect_ok = 1 ORDER BY started_at DESC LIMIT 1")
    .first<{ started_at: string }>();
  return row?.started_at ?? null;
}

export async function monthSpend(db: D1Database, monthStartIso: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(est_cost_usd), 0) AS spent FROM radar_runs WHERE started_at >= ?")
    .bind(monthStartIso).first<{ spent: number }>();
  return row?.spent ?? 0;
}

// Cost fields aren't written here any more: addSpend writes them per request
// as it happens, so this only needs to record how the attempt as a whole
// went.
export async function recordCollect(
  db: D1Database,
  runId: string,
  s: { cutShort: string[]; collectOk: boolean; errors: string[] },
): Promise<void> {
  await db.prepare(
    "UPDATE radar_runs SET cut_short = ?, collect_ok = ?, errors = ? WHERE id = ?",
  ).bind(JSON.stringify(s.cutShort), s.collectOk ? 1 : 0, s.errors.length ? JSON.stringify(s.errors) : null, runId).run();
}

// Called once per completed X request (collect or expand), so the spend is
// on record even if the step it's part of later fails and is retried.
export async function addSpend(db: D1Database, runId: string, s: { posts: number; requests: number; spent: number }): Promise<void> {
  await db.prepare("UPDATE radar_runs SET posts_read = posts_read + ?, requests = requests + ?, est_cost_usd = est_cost_usd + ? WHERE id = ?")
    .bind(s.posts, s.requests, s.spent, runId).run();
}

// json_insert only appends one value at a time, so N errors need N
// statements; batched together so they land as one transaction rather than
// interleaving with another writer's append.
export async function appendRunErrors(db: D1Database, runId: string, errors: string[]): Promise<void> {
  if (!errors.length) return;
  await db.batch(errors.map((error) =>
    db.prepare("UPDATE radar_runs SET errors = json_insert(COALESCE(errors, '[]'), '$[#]', ?) WHERE id = ?").bind(error, runId),
  ));
}

export async function recordTriage(db: D1Database, runId: string, batches: number, failed: number): Promise<void> {
  await db.prepare("UPDATE radar_runs SET triage_batches = ?, triage_failed = ? WHERE id = ?").bind(batches, failed, runId).run();
}

export async function recordEditor(
  db: D1Database,
  runId: string,
  s: { inputTokens: number | null; outputTokens: number | null; fallback: boolean; digestJson: string },
): Promise<void> {
  await db.prepare("UPDATE radar_runs SET editor_input_tokens = ?, editor_output_tokens = ?, editor_fallback = ?, digest_json = ? WHERE id = ?")
    .bind(s.inputTokens, s.outputTokens, s.fallback ? 1 : 0, s.digestJson, runId).run();
}

export async function finishRun(
  db: D1Database,
  runId: string,
  s: { status: "posted" | "notice" | "failed"; finishedAt: string; slackTs?: string | null; error?: string },
): Promise<void> {
  const error = s.error ?? null;
  await db.prepare(
    `UPDATE radar_runs SET status = ?, finished_at = ?, slack_ts = COALESCE(?, slack_ts),
       errors = CASE WHEN ? IS NULL THEN errors ELSE json_insert(COALESCE(errors, '[]'), '$[#]', ?) END
     WHERE id = ?`,
  ).bind(s.status, s.finishedAt, s.slackTs ?? null, error, error, runId).run();
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare("SELECT * FROM radar_runs WHERE id = ?").bind(runId).first<RunRow>();
}

// ---------------------------------------------------------------- feedback

// The author effect and the post's mark are one D1 batch (one SQLite
// transaction), author statement first: if either statement fails, both
// roll back, so a post is never left marked with its author boost
// unapplied. Both statements share the same feedback-state guard, so a
// double tap (or Slack redelivering the click) finds the post already
// marked, has both statements do nothing, and returns false.
export async function applyFeedback(db: D1Database, postId: string, mark: Mark, at: string): Promise<boolean> {
  const [, marked] = await db.batch([
    authorStatement(db, postId, mark, at, 1),
    db.prepare("UPDATE radar_posts SET feedback = ?, feedback_at = ? WHERE id = ? AND feedback IS NULL").bind(mark, at, postId),
  ]);
  return (marked.meta.changes ?? 0) > 0;
}

// Reads the current mark first (there is nothing to reverse without it),
// then clears it and reverses its author effect in the same one-batch,
// guard-first shape as applyFeedback. A concurrent Undo that already
// cleared the mark leaves both statements a no-op here, so this returns
// null instead of reversing the author effect twice.
export async function undoFeedback(db: D1Database, postId: string, at: string): Promise<Mark | null> {
  const post = await db.prepare("SELECT author_handle, feedback FROM radar_posts WHERE id = ?")
    .bind(postId).first<{ author_handle: string; feedback: Mark | null }>();
  if (!post?.feedback) return null;
  const [, cleared] = await db.batch([
    authorStatement(db, postId, post.feedback, at, -1),
    db.prepare("UPDATE radar_posts SET feedback = NULL, feedback_at = NULL WHERE id = ? AND feedback = ?").bind(postId, post.feedback),
  ]);
  return (cleared.meta.changes ?? 0) > 0 ? post.feedback : null;
}

// The author change for one mark, applied only while the post's mark is in
// the expected state: unmarked for a new mark, still carrying it for Undo.
// INSERT … SELECT keeps that guard inside the same statement; the SELECT's
// WHERE clause also resolves SQLite's INSERT…SELECT upsert parsing ambiguity.
function authorStatement(db: D1Database, postId: string, mark: Mark, at: string, direction: 1 | -1): D1PreparedStatement {
  const guard = direction === 1 ? "p.feedback IS NULL" : "p.feedback = ?";
  const guardArgs = direction === 1 ? [] : [mark];
  if (mark === "mute") {
    return db.prepare(
      `INSERT INTO radar_authors (handle, boost, muted, updated_at)
       SELECT lower(p.author_handle), 0, ?, ? FROM radar_posts p WHERE p.id = ? AND ${guard}
       ON CONFLICT(handle) DO UPDATE SET muted = excluded.muted, updated_at = excluded.updated_at`,
    ).bind(direction === 1 ? 1 : 0, at, postId, ...guardArgs);
  }
  const delta = (mark === "useful" ? BOOST_STEP : -BOOST_STEP) * direction;
  return db.prepare(
    `INSERT INTO radar_authors (handle, boost, muted, updated_at)
     SELECT lower(p.author_handle), max(-1, min(1, ?)), 0, ? FROM radar_posts p WHERE p.id = ? AND ${guard}
     ON CONFLICT(handle) DO UPDATE SET boost = max(-1, min(1, radar_authors.boost + ?)), updated_at = excluded.updated_at`,
  ).bind(delta, at, postId, ...guardArgs, delta);
}
