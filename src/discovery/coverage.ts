import { fencedBatch, type DiscoveryLease, type DiscoveryPipeline } from "../operations/leases";

export type RunStart = {
  runId: string;
  pipeline: DiscoveryPipeline;
  codeVersion: string;
  queryVersion: string;
  registryVersion: string;
  startedAt: string;
};
export type Stage = "url" | "resolve" | "select" | "fetch" | "screen" | "deliver";
export type StageOutcome = {
  runId: string;
  itemId: string;
  stage: Stage;
  outcome: string;
  at: string;
  errorCode: string | null;
  detail: string | null;
};
export type PageOutcome = {
  runId: string;
  queryId: string;
  page: number;
  attemptId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "complete" | "failed" | "uncertain";
  rawHits: number;
  queryHash: string;
  httpStatus: number | null;
  errorCode?: string | null;
  stoppedBy: "empty" | "budget" | "page_limit" | "failure" | null;
};
export type UrlObservation = {
  runId: string;
  queryId: string;
  page: number;
  ordinal: number;
  rawUrl: string | null;
  normalizedUrl: string | null;
  outcome: "malformed" | "excluded" | "unsupported" | "resolved" | "held";
  jobId: string | null;
  reasonCode?: string | null;
};
export type DiscoveryFunnel = {
  schemaVersion: 1;
  runId: string;
  observedAt: string;
  complete: boolean;
  rawHits: number;
  malformedHits: number;
  validHitOccurrences: number;
  duplicateUrlOccurrences: number;
  uniqueUrls: number;
  queuedUrls: number;
  queuedResolvedUrls: number;
  urlInputOverlap: number;
  unionUrls: number;
  excludedUrls: number;
  unsupportedUrls: number;
  resolvedUrls: number;
  heldUrls: number;
  resolutionPendingUrls: number;
  uniqueResolvedJobs: number;
  aliasUrls: number;
  dueRetryJobs: number;
  queuedInputJobs: number;
  backlogDiscoveryOverlap: number;
  unionInputs: number;
  existingJobs: number;
  cooldownJobs: number;
  capDeferred: number;
  identityReviewJobs: number;
  selectedJobs: number;
  selectionPendingJobs: number;
  applicationLookupPending: number;
  knownApplications: number;
  fetchPlanned: number;
  fetched: number;
  notFound: number;
  fetchFailed: number;
  fetchPending: number;
  preScreenHeld: number;
  screenMatch: number;
  screenNoMatch: number;
  screenReview: number;
  screenRetry: number;
  screenPending: number;
  delivery: {
    openingPending: number;
    createdUniqueIntents: number;
    delivered: number;
    suppressed: number;
    uncertain: number;
    pending: number;
    locationHeld: number;
    cooldownHeld: number;
  };
  diagnostics: {
    failedPages: number;
    uncertainPages: number;
    pageObservationGaps: number;
    identityConflicts: number;
    unreconciledOpeningIntents: number;
  };
};

const STAGE_OUTCOMES: Record<Stage, ReadonlySet<string>> = {
  url: new Set(["malformed", "valid", "excluded", "unsupported"]),
  resolve: new Set(["resolved", "held", "unsupported", "invalid_identity"]),
  select: new Set(["existing", "cooldown", "cap_deferred", "selected", "known_application", "identity_review"]),
  fetch: new Set(["fetched", "not_found", "fetch_failed"]),
  screen: new Set(["pre_screen_held", "match", "no_match", "review", "retry"]),
  deliver: new Set(["delivered", "suppressed", "uncertain", "pending", "location_held", "cooldown_held"]),
};

function assertRun(lease: DiscoveryLease, runId: string): void {
  if (!runId || runId !== lease.owner) throw new Error("Run ID must match the current lease owner");
}

function sameRow(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}

export async function startDiscoveryRun(db: D1Database, lease: DiscoveryLease, input: RunStart): Promise<void> {
  assertRun(lease, input.runId);
  if (lease.pipeline !== input.pipeline) throw new Error("Pipeline and lease disagree");
  const source = input.pipeline === "fixed_boards" ? "fixed_board" : "unbounded_search";
  await fencedBatch(db, lease, [db.prepare(`INSERT INTO discovery_runs
    (run_id,pipeline,code_version,query_version,registry_version,started_at,status,lease_fence)
    VALUES (?,?,?,?,?,?,'running',?) ON CONFLICT(run_id) DO NOTHING`)
    .bind(input.runId, input.pipeline, input.codeVersion, input.queryVersion, input.registryVersion, input.startedAt, lease.fence),
  db.prepare(`INSERT INTO discovery_run_inputs (run_id,kind,input_id,first_seen_at)
    SELECT ?,'opening_delivery',COALESCE(e.id,j.id),j.first_seen_at
      FROM jobs j
      LEFT JOIN job_screening_current c ON c.job_id=j.id
      LEFT JOIN job_evaluations e ON e.id=c.evaluation_id
      LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
     WHERE j.discovery_source=? AND j.application_status='not_applied' AND j.is_known_application=0
       AND ((c.evaluation_id IS NULL AND j.match=1 AND j.notified_at IS NULL)
         OR (e.state IN ('match','needs_review') AND (d.status IS NULL OR d.status='pending')))
       AND NOT EXISTS (SELECT 1 FROM discovery_run_inputs
         WHERE run_id=? AND kind='snapshot_marker' AND input_id='opening_delivery')
    ON CONFLICT(run_id,kind,input_id) DO NOTHING`).bind(input.runId, source, input.runId),
  db.prepare(`INSERT INTO discovery_run_inputs (run_id,kind,input_id,first_seen_at)
    VALUES (?,'snapshot_marker','opening_delivery',NULL)
    ON CONFLICT(run_id,kind,input_id) DO NOTHING`).bind(input.runId)]);
  const row = await db.prepare("SELECT * FROM discovery_runs WHERE run_id=?").bind(input.runId).first<Record<string, unknown>>();
  if (!row || !sameRow(row, { pipeline: input.pipeline, code_version: input.codeVersion,
    query_version: input.queryVersion, registry_version: input.registryVersion,
    lease_fence: lease.fence })) throw new Error("Conflicting discovery run start");
}

export async function recordStageOutcome(db: D1Database, lease: DiscoveryLease, input: StageOutcome): Promise<void> {
  return recordStageOutcomes(db, lease, [input]);
}

export async function recordStageOutcomes(db: D1Database, lease: DiscoveryLease, inputs: readonly StageOutcome[]): Promise<void> {
  const incoming = new Map<string, string>();
  for (const input of inputs) {
    assertRun(lease, input.runId);
    if (!input.itemId || !STAGE_OUTCOMES[input.stage]?.has(input.outcome)) throw new Error("Invalid stage outcome");
    if (input.errorCode && !/^[a-z0-9_:-]{1,80}$/i.test(input.errorCode)) throw new Error("Invalid error code");
    const key = JSON.stringify([input.itemId, input.stage]);
    const value = JSON.stringify([input.outcome, input.errorCode, input.detail?.slice(0, 500) ?? null]);
    if (incoming.has(key) && incoming.get(key) !== value) throw new Error("Conflicting discovery stage outcome");
    incoming.set(key, value);
  }
  for (let offset = 0; offset < inputs.length; offset += 50) {
    const chunk = inputs.slice(offset, offset + 50);
    const rows = JSON.stringify(chunk.map(input => [input.itemId, input.stage, input.outcome,
      input.at, input.errorCode, input.detail?.slice(0, 500) ?? null]));
    if (new TextEncoder().encode(rows).byteLength > 900_000) throw new Error("Stage outcome chunk exceeds storage bound");
    // A conflict rejects the entire chunk before any of its new receipts land.
    // The check and insert share one statement, protected by the lease transaction.
    // CROSS JOIN fixes incoming-first order so every conflict check uses the full primary key.
    await fencedBatch(db, lease, [db.prepare(`WITH incoming AS (
      SELECT json_extract(value,'$[0]') AS item_id,json_extract(value,'$[1]') AS stage,
        json_extract(value,'$[2]') AS outcome,json_extract(value,'$[3]') AS at,
        json_extract(value,'$[4]') AS error_code,json_extract(value,'$[5]') AS detail
      FROM json_each(?))
      INSERT INTO discovery_run_items (run_id,item_id,stage,outcome,at,error_code,detail)
      SELECT ?,item_id,stage,outcome,at,error_code,detail FROM incoming
      WHERE NOT EXISTS (SELECT 1 FROM incoming i CROSS JOIN discovery_run_items s
        ON s.run_id=? AND s.item_id=i.item_id AND s.stage=i.stage
        WHERE s.outcome IS NOT i.outcome OR s.error_code IS NOT i.error_code OR s.detail IS NOT i.detail)
      ON CONFLICT(run_id,item_id,stage) DO NOTHING`)
      .bind(rows, lease.owner, lease.owner)]);
    const stored = (await db.prepare(`SELECT * FROM discovery_run_items
      WHERE run_id=? AND item_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(lease.owner, ...chunk.map(input => input.itemId)).all<Record<string, unknown>>()).results;
    const byKey = new Map(stored.map(row => [JSON.stringify([row.item_id, row.stage]), row]));
    for (const input of chunk) {
      const row = byKey.get(JSON.stringify([input.itemId, input.stage]));
      if (!row || !sameRow(row, { outcome: input.outcome, error_code: input.errorCode, detail: input.detail?.slice(0, 500) ?? null })) {
        throw new Error("Conflicting discovery stage outcome");
      }
    }
  }
}

export async function recordCreatedDeliveryIntent(db: D1Database, lease: DiscoveryLease,
  intentId: string, at: string): Promise<void> {
  if (!intentId) throw new Error("Missing delivery intent identity");
  await fencedBatch(db, lease, [db.prepare(`INSERT INTO discovery_run_inputs
    (run_id,kind,input_id,first_seen_at) VALUES (?,'created_delivery',?,?)
    ON CONFLICT(run_id,kind,input_id) DO NOTHING`).bind(lease.owner, intentId, at)]);
}

// This receipt precedes an external send. Without a later durable delivered
// receipt, the send may have been accepted and remains uncertain.
export async function recordDeliveryAttempt(db: D1Database, lease: DiscoveryLease,
  intentId: string, at: string): Promise<void> {
  if (!intentId) throw new Error("Missing delivery intent identity");
  await fencedBatch(db, lease, [db.prepare(`INSERT INTO discovery_delivery_attempts
    (run_id,intent_id,started_at) VALUES (?,?,?)
    ON CONFLICT(run_id,intent_id) DO NOTHING`).bind(lease.owner, intentId, at)]);
}

export async function recordQueryPage(db: D1Database, lease: DiscoveryLease, input: PageOutcome): Promise<void> {
  assertRun(lease, input.runId);
  if (!input.queryId || !input.attemptId || !Number.isSafeInteger(input.page) || input.page < 1 ||
    !Number.isSafeInteger(input.rawHits) || input.rawHits < 0 || !/^[a-f0-9]{64}$/.test(input.queryHash)) {
    throw new Error("Invalid query page");
  }
  if (input.status === "uncertain" && input.finishedAt !== null) throw new Error("Uncertain page must remain unfinished");
  if ((input.status === "failed" && !input.errorCode) ||
    (input.errorCode && !/^[a-z0-9_:-]{1,80}$/i.test(input.errorCode))) throw new Error("Invalid query page error code");
  const existing = await db.prepare("SELECT * FROM discovery_query_pages WHERE run_id=? AND query_id=? AND page=?")
    .bind(input.runId, input.queryId, input.page).first<Record<string, unknown>>();
  if (existing && (existing.attempt_id !== input.attemptId || existing.query_hash !== input.queryHash)) {
    throw new Error("Conflicting query page attempt");
  }
  if (existing?.status === "uncertain" && input.status !== "uncertain") {
    await fencedBatch(db, lease, [
      db.prepare(`UPDATE discovery_query_pages SET finished_at=?,status=?,raw_hits=?,http_status=?,error_code=?,stopped_by=?
        WHERE run_id=? AND query_id=? AND page=? AND attempt_id=? AND status='uncertain'`)
        .bind(input.finishedAt, input.status, input.rawHits, input.httpStatus, input.errorCode ?? null, input.stoppedBy,
          input.runId, input.queryId, input.page, input.attemptId),
      db.prepare(`UPDATE discovery_page_attempts SET finished_at=?,status=?,http_status=?
        WHERE attempt_id=? AND status='uncertain'`)
        .bind(input.finishedAt, input.status, input.httpStatus, input.attemptId),
    ]);
  } else if (!existing) {
    await fencedBatch(db, lease, [
      db.prepare(`INSERT INTO discovery_page_attempts
        (attempt_id,run_id,query_id,page,started_at,finished_at,status,http_status)
        VALUES (?,?,?,?,?,?,?,?)`)
        .bind(input.attemptId, input.runId, input.queryId, input.page, input.startedAt,
          input.finishedAt, input.status, input.httpStatus),
      db.prepare(`INSERT INTO discovery_query_pages
        (run_id,query_id,page,attempt_id,started_at,finished_at,status,raw_hits,query_hash,http_status,error_code,stopped_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(input.runId, input.queryId, input.page, input.attemptId, input.startedAt,
          input.finishedAt, input.status, input.rawHits, input.queryHash, input.httpStatus,
          input.errorCode ?? null, input.stoppedBy),
    ]);
  } else {
    // A replay must still pass the lease fence before claiming success.
    await fencedBatch(db, lease, [db.prepare("UPDATE discovery_query_pages SET status=status WHERE run_id=? AND query_id=? AND page=?")
      .bind(input.runId, input.queryId, input.page)]);
  }
  const row = await db.prepare("SELECT * FROM discovery_query_pages WHERE run_id=? AND query_id=? AND page=?")
    .bind(input.runId, input.queryId, input.page).first<Record<string, unknown>>();
  const replayOfFinishedPage = existing && existing.status !== "uncertain" && input.status === "uncertain";
  if (!row || !sameRow(row, { attempt_id: input.attemptId, query_hash: input.queryHash }) ||
    (!replayOfFinishedPage && !sameRow(row, { status: input.status, raw_hits: input.rawHits,
      http_status: input.httpStatus, error_code: input.errorCode ?? null, stopped_by: input.stoppedBy }))) {
    throw new Error("Conflicting query page outcome");
  }
}

function validateUrlObservation(lease: DiscoveryLease, input: UrlObservation): void {
  assertRun(lease, input.runId);
  if (!input.queryId || !Number.isSafeInteger(input.page) || input.page < 1 ||
    !Number.isSafeInteger(input.ordinal) || input.ordinal < 0 ||
    (input.outcome === "malformed" ? input.normalizedUrl !== null : !input.normalizedUrl) ||
    (input.outcome === "resolved" ? !input.jobId : input.jobId !== null) ||
    (input.outcome === "held" && !input.reasonCode) ||
    (input.reasonCode && !/^[a-z0-9_:-]{1,80}$/i.test(input.reasonCode))) throw new Error("Invalid URL observation");
}

export async function recordUrlObservation(db: D1Database, lease: DiscoveryLease, input: UrlObservation): Promise<void> {
  return recordUrlObservations(db, lease, [input]);
}

// One fenced insert and one scoped verification read per bounded chunk. Using
// JSON rows keeps bound parameters below D1's 100-parameter ceiling without
// losing any occurrence or weakening conflicting-replay checks.
export async function recordUrlObservations(db: D1Database, lease: DiscoveryLease, inputs: readonly UrlObservation[]): Promise<void> {
  if (!inputs.length) return;
  const page = inputs[0];
  const incoming = new Map<number, string>();
  for (const input of inputs) {
    validateUrlObservation(lease, input);
    if (input.runId !== page.runId || input.queryId !== page.queryId || input.page !== page.page) {
      throw new Error("URL observation batch must describe the same page");
    }
    const value = JSON.stringify([input.rawUrl, input.normalizedUrl, input.outcome, input.jobId, input.reasonCode ?? null]);
    if (incoming.has(input.ordinal) && incoming.get(input.ordinal) !== value) throw new Error("Conflicting URL observation");
    incoming.set(input.ordinal, value);
  }
  for (let offset = 0; offset < inputs.length; offset += 50) {
    const chunk = inputs.slice(offset, offset + 50);
    const rows = JSON.stringify(chunk.map(input => [input.ordinal, input.rawUrl,
      input.normalizedUrl, input.outcome, input.jobId, input.reasonCode ?? null]));
    if (new TextEncoder().encode(rows).byteLength > 900_000) throw new Error("URL observation chunk exceeds storage bound");
    await fencedBatch(db, lease, [db.prepare(`WITH incoming AS (
      SELECT json_extract(value,'$[0]') AS ordinal,json_extract(value,'$[1]') AS raw_url,
        json_extract(value,'$[2]') AS normalized_url,json_extract(value,'$[3]') AS outcome,
        json_extract(value,'$[4]') AS job_id,json_extract(value,'$[5]') AS reason_code
      FROM json_each(?))
      INSERT INTO discovery_url_observations
        (run_id,query_id,page,ordinal,raw_url,normalized_url,outcome,job_id,reason_code)
      SELECT ?,?,?,ordinal,raw_url,normalized_url,outcome,job_id,reason_code FROM incoming
      WHERE NOT EXISTS (SELECT 1 FROM incoming i CROSS JOIN discovery_url_observations s
        ON s.run_id=? AND s.query_id=? AND s.page=? AND s.ordinal=i.ordinal
        WHERE s.raw_url IS NOT i.raw_url OR s.normalized_url IS NOT i.normalized_url
          OR s.outcome IS NOT i.outcome OR s.job_id IS NOT i.job_id OR s.reason_code IS NOT i.reason_code)
      ON CONFLICT(run_id,query_id,page,ordinal) DO NOTHING`)
      .bind(rows, page.runId, page.queryId, page.page, page.runId, page.queryId, page.page)]);
    const stored = (await db.prepare(`SELECT * FROM discovery_url_observations
      WHERE run_id=? AND query_id=? AND page=? AND ordinal IN (${chunk.map(() => "?").join(",")})`)
      .bind(page.runId, page.queryId, page.page, ...chunk.map(input => input.ordinal)).all<Record<string, unknown>>()).results;
    const byOrdinal = new Map(stored.map(row => [row.ordinal, row]));
    for (const input of chunk) {
      const row = byOrdinal.get(input.ordinal);
      if (!row || !sameRow(row, { raw_url: input.rawUrl, normalized_url: input.normalizedUrl,
        outcome: input.outcome, job_id: input.jobId, reason_code: input.reasonCode ?? null })) throw new Error("Conflicting URL observation");
    }
  }
}

export async function finishDiscoveryRun(db: D1Database, lease: DiscoveryLease, runId: string,
  status: "complete" | "partial" | "failed" | "interrupted", at: string): Promise<void> {
  assertRun(lease, runId);
  await fencedBatch(db, lease, [...closingDeliveryStatements(db, runId, at),
    db.prepare(`UPDATE discovery_runs SET status=?,finished_at=?
    WHERE run_id=? AND status='running'`).bind(status, at, runId)]);
  const row = await db.prepare("SELECT status,finished_at FROM discovery_runs WHERE run_id=?")
    .bind(runId).first<{status: string; finished_at: string | null}>();
  if (row?.status !== status || !row.finished_at) throw new Error("Conflicting discovery run finish");
  if (status === "complete") await fencedBatch(db, lease, [db.prepare(`UPDATE discovery_health_incidents
    SET state='recovered',last_run_id=?,last_seen_at=?,report_needed=1
    WHERE pipeline=? AND state='open'`).bind(lease.owner, row.finished_at, lease.pipeline)]);
}

// The opening and closing inventories are both frozen. A historical run must
// not change when another run later delivers or suppresses the same intent.
export function closingDeliveryStatements(db: D1Database, runId: string, at: string): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO discovery_run_inputs (run_id,kind,input_id,first_seen_at)
      SELECT ?,'closing_delivery',COALESCE(e.id,j.id),j.first_seen_at
        FROM jobs j
        LEFT JOIN job_screening_current c ON c.job_id=j.id
        LEFT JOIN job_evaluations e ON e.id=c.evaluation_id
        LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
       WHERE j.discovery_source=(SELECT CASE pipeline WHEN 'fixed_boards' THEN 'fixed_board' ELSE 'unbounded_search' END
          FROM discovery_runs WHERE run_id=?)
         AND j.application_status='not_applied' AND j.is_known_application=0
         AND ((c.evaluation_id IS NULL AND j.match=1 AND j.notified_at IS NULL)
           OR (e.state IN ('match','needs_review') AND (d.status IS NULL OR d.status='pending')))
         AND EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')
         AND NOT EXISTS (SELECT 1 FROM discovery_run_inputs
           WHERE run_id=? AND kind='snapshot_marker' AND input_id='closing_delivery')
      ON CONFLICT(run_id,kind,input_id) DO NOTHING`).bind(runId, runId, runId, runId),
    db.prepare(`INSERT INTO discovery_run_inputs (run_id,kind,input_id,first_seen_at)
      SELECT ?,'snapshot_marker','closing_delivery',NULL
      WHERE EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')
      ON CONFLICT(run_id,kind,input_id) DO NOTHING`).bind(runId, runId),
    db.prepare(`INSERT INTO discovery_run_delivery_resolutions
      (run_id,intent_id,outcome,reason_code,observed_at)
      SELECT ?,i.input_id,'delivered','delivery_receipt',?
        FROM discovery_run_inputs i
        LEFT JOIN job_evaluations e ON e.id=i.input_id
        JOIN jobs j ON j.id=COALESCE(e.job_id,i.input_id)
        LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
       WHERE i.run_id=? AND i.kind IN ('opening_delivery','created_delivery')
         AND ((e.id IS NULL AND j.notified_at IS NOT NULL AND j.notified_at<=?)
           OR (e.id IS NOT NULL AND d.status='delivered' AND d.delivered_at IS NOT NULL
             AND d.delivered_at<=?))
         AND EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')
      ON CONFLICT(run_id,intent_id) DO NOTHING`).bind(runId, at, runId, at, at, runId),
    db.prepare(`INSERT INTO discovery_run_delivery_resolutions
      (run_id,intent_id,outcome,reason_code,observed_at)
      SELECT ?,i.input_id,'suppressed','user_disposition',?
        FROM discovery_run_inputs i
        LEFT JOIN job_evaluations e ON e.id=i.input_id
        JOIN jobs j ON j.id=COALESCE(e.job_id,i.input_id)
       WHERE i.run_id=? AND i.kind IN ('opening_delivery','created_delivery')
         AND (j.application_status<>'not_applied' OR j.is_known_application=1)
         AND NOT EXISTS (SELECT 1 FROM discovery_run_inputs c
           WHERE c.run_id=i.run_id AND c.kind='closing_delivery' AND c.input_id=i.input_id)
         AND NOT EXISTS (SELECT 1 FROM discovery_run_items s
           WHERE s.run_id=i.run_id AND s.item_id=i.input_id AND s.stage='deliver'
             AND s.outcome IN ('delivered','suppressed','uncertain'))
         AND NOT EXISTS (SELECT 1 FROM discovery_delivery_attempts a
           WHERE a.run_id=i.run_id AND a.intent_id=i.input_id)
         AND NOT EXISTS (SELECT 1 FROM discovery_run_delivery_resolutions r
           WHERE r.run_id=i.run_id AND r.intent_id=i.input_id)
         AND EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')
      ON CONFLICT(run_id,intent_id) DO NOTHING`).bind(runId, at, runId, runId),
  ];
}

type ItemRow = { item_id: string; stage: Stage; outcome: string; detail: string | null };
type UrlRow = { normalized_url: string | null; outcome: UrlObservation["outcome"]; job_id: string | null };
type CandidateInputRow = { candidate_key: string; original_url: string;
  canonical_job_id: string | null; kind: "current" | "carryover" | "due_retry";
  observed_this_run: number; observed_at: string; status_at_claim: string;
  next_attempt_at_at_claim: number; failure_category_at_claim: string | null;
  claim_selected: number };

function count(rows: ItemRow[], stage: Stage, outcome: string): number {
  return rows.filter(row => row.stage === stage && row.outcome === outcome).length;
}

export async function summarizeRun(db: D1Database, runId: string): Promise<DiscoveryFunnel> {
  const [runs, pages, urls, items, opening, created, closing, resolutions, attempts, currentPending] = await db.batch([
    db.prepare("SELECT * FROM discovery_runs WHERE run_id=?").bind(runId),
    db.prepare("SELECT * FROM discovery_query_pages WHERE run_id=?").bind(runId),
    db.prepare("SELECT * FROM discovery_url_observations WHERE run_id=? ORDER BY query_id,page,ordinal").bind(runId),
    db.prepare("SELECT * FROM discovery_run_items WHERE run_id=?").bind(runId),
    db.prepare("SELECT input_id FROM discovery_run_inputs WHERE run_id=? AND kind='opening_delivery'").bind(runId),
    db.prepare("SELECT input_id FROM discovery_run_inputs WHERE run_id=? AND kind='created_delivery'").bind(runId),
    db.prepare("SELECT input_id FROM discovery_run_inputs WHERE run_id=? AND kind='closing_delivery'").bind(runId),
    db.prepare("SELECT intent_id,outcome FROM discovery_run_delivery_resolutions WHERE run_id=?").bind(runId),
    db.prepare("SELECT intent_id FROM discovery_delivery_attempts WHERE run_id=?").bind(runId),
    db.prepare(`SELECT COALESCE(e.id,j.id) AS intent_id
      FROM jobs j
      LEFT JOIN job_screening_current c ON c.job_id=j.id
      LEFT JOIN job_evaluations e ON e.id=c.evaluation_id
      LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
      WHERE j.discovery_source=(SELECT CASE pipeline WHEN 'fixed_boards' THEN 'fixed_board' ELSE 'unbounded_search' END
        FROM discovery_runs WHERE run_id=?)
        AND j.application_status='not_applied' AND j.is_known_application=0
        AND ((c.evaluation_id IS NULL AND j.match=1 AND j.notified_at IS NULL)
          OR (e.state IN ('match','needs_review') AND (d.status IS NULL OR d.status='pending')))`)
      .bind(runId),
  ]);
  const run = runs.results[0] as Record<string, unknown> | undefined;
  if (!run) throw new Error("Unknown discovery run");
  const pageRows = pages.results as Array<{status:string;raw_hits:number}>;
  const urlRows = urls.results as UrlRow[];
  const itemRows = items.results as ItemRow[];
  let candidateInputs: CandidateInputRow[] = [];
  try {
    candidateInputs = (await db.prepare(`SELECT candidate_key,original_url,canonical_job_id,kind,
      observed_this_run,observed_at,status_at_claim,next_attempt_at_at_claim,
      failure_category_at_claim,claim_selected
      FROM discovery_run_candidate_inputs WHERE run_id=?`).bind(runId).all<CandidateInputRow>()).results;
  } catch (error) {
    if (!/no such table: discovery_run_candidate_inputs/i.test(String(error))) throw error;
  }
  const rawHits = urlRows.length;
  const malformedHits = urlRows.filter(row => row.outcome === "malformed").length;
  const validHitOccurrences = rawHits - malformedHits;
  const byUrl = new Map<string, UrlRow[]>();
  for (const row of urlRows) {
    if (row.normalized_url === null) continue;
    const group = byUrl.get(row.normalized_url) ?? [];
    group.push(row);
    byUrl.set(row.normalized_url, group);
  }
  const uniqueUrls = byUrl.size;
  const queuedInputs = candidateInputs.filter(input => input.kind !== "current");
  const candidateUrls = new Set(queuedInputs.map(input => input.original_url));
  const queuedUrls = candidateUrls.size;
  const urlInputOverlap = [...candidateUrls].filter(url => byUrl.has(url)).length;
  const unionUrls = new Set([...byUrl.keys(), ...candidateUrls]).size;
  const unique = [...byUrl.values()].map(group => group.find(row => row.outcome === "resolved") ?? group[0]);
  const resolveOutcomes = new Map(itemRows.filter(row => row.stage === "resolve")
    .map(row => [row.item_id, row]));
  const resolvedOwnersByUrl = new Map(candidateInputs.flatMap(input => {
    const owner = input.canonical_job_id ?? (resolveOutcomes.get(input.candidate_key)?.outcome === "resolved"
      ? resolveOutcomes.get(input.candidate_key)?.detail : null);
    return owner ? [[input.original_url, owner] as const] : [];
  }));
  const resolvedUrlSet = new Set(unique.filter(row => row.outcome === "resolved")
    .map(row => row.normalized_url).filter((url): url is string => !!url));
  for (const url of resolvedOwnersByUrl.keys()) resolvedUrlSet.add(url);
  const resolvedUrls = resolvedUrlSet.size;
  const queuedResolvedUrls = [...candidateUrls].filter(url => !byUrl.has(url) && resolvedUrlSet.has(url)).length;
  const identityConflicts = [...byUrl.values()].filter(group =>
    new Set(group.filter(row => row.outcome === "resolved").map(row => row.job_id)).size > 1).length;
  const jobIds = new Set(unique.filter(row => row.outcome === "resolved").map(row => row.job_id!));
  for (const owner of resolvedOwnersByUrl.values()) jobIds.add(owner);
  const uniqueResolvedJobs = jobIds.size;
  const candidateJobIds = new Set(queuedInputs.map(input => input.canonical_job_id)
    .filter((id): id is string => !!id));
  const heldUrlSet = new Set(unique.filter(row => row.outcome === "held")
    .map(row => row.normalized_url).filter((url): url is string => !!url));
  for (const input of candidateInputs) {
    if (!input.canonical_job_id && ["held", "invalid_identity"].includes(
      resolveOutcomes.get(input.candidate_key)?.outcome ?? "") ||
      !input.canonical_job_id && input.status_at_claim === "held") {
      heldUrlSet.add(input.original_url);
    }
  }
  for (const url of resolvedUrlSet) heldUrlSet.delete(url);
  const excludedUrlSet = new Set(unique.filter(row => row.outcome === "excluded")
    .map(row => row.normalized_url).filter((url): url is string => !!url));
  const unsupportedUrlSet = new Set(unique.filter(row => row.outcome === "unsupported")
    .map(row => row.normalized_url).filter((url): url is string => !!url));
  for (const input of candidateInputs) {
    if (resolveOutcomes.get(input.candidate_key)?.outcome === "unsupported") {
      unsupportedUrlSet.add(input.original_url);
    }
  }
  for (const url of [...resolvedUrlSet, ...heldUrlSet, ...excludedUrlSet]) unsupportedUrlSet.delete(url);
  const dueRetryJobs = new Set(candidateInputs.filter(input => input.kind === "due_retry")
    .map(input => input.canonical_job_id).filter((id): id is string => !!id)).size;
  const backlogDiscoveryOverlap = [...candidateJobIds].filter(id => jobIds.has(id)).length;
  const unionJobIds = new Set([...jobIds, ...candidateJobIds]);
  const selection = new Map(itemRows.filter(row => row.stage === "select").map(row => [row.item_id, row.outcome]));
  const queuedCooldownIds = new Set(candidateInputs.filter(input => input.canonical_job_id &&
    input.claim_selected === 0 && input.status_at_claim !== "held" &&
    input.next_attempt_at_at_claim > Date.parse(input.observed_at)).map(input => input.canonical_job_id!));
  const queuedCapDeferredIds = new Set(candidateInputs.filter(input => input.canonical_job_id &&
    input.claim_selected === 0 && input.status_at_claim !== "held" &&
    !queuedCooldownIds.has(input.canonical_job_id)).map(input => input.canonical_job_id!));
  for (const id of selection.keys()) { queuedCooldownIds.delete(id); queuedCapDeferredIds.delete(id); }
  const fetched = count(itemRows, "fetch", "fetched");
  const notFound = count(itemRows, "fetch", "not_found");
  const fetchFailed = count(itemRows, "fetch", "fetch_failed");
  const selectedJobs = count(itemRows, "select", "selected") + count(itemRows, "select", "known_application");
  const knownApplications = count(itemRows, "select", "known_application");
  const applicationLookupPending = 0;
  const fetchPlanned = selectedJobs - knownApplications - applicationLookupPending;
  const screenMatch = count(itemRows, "screen", "match");
  const screenNoMatch = count(itemRows, "screen", "no_match");
  const screenReview = count(itemRows, "screen", "review");
  const screenRetry = count(itemRows, "screen", "retry");
  const preScreenHeld = count(itemRows, "screen", "pre_screen_held");
  const deliveryRows = itemRows.filter(row => row.stage === "deliver");
  const openingIds = new Set((opening.results as Array<{input_id:string}>).map(row => row.input_id));
  const createdIds = new Set((created.results as Array<{input_id:string}>).map(row => row.input_id));
  const pendingRows = run.status === "running" ? currentPending.results as Array<{intent_id:string}> :
    (closing.results as Array<{input_id:string}>).map(row => ({intent_id:row.input_id}));
  const pendingIds = new Set(pendingRows.map(row => row.intent_id));
  const outcomes = new Map(deliveryRows.map(row => [row.item_id, row.outcome]));
  for (const row of attempts.results as Array<{intent_id:string}>) {
    if (outcomes.get(row.intent_id) !== "delivered") {
      outcomes.set(row.intent_id, "uncertain");
    }
  }
  for (const row of resolutions.results as Array<{intent_id:string;outcome:string}>) {
    if (row.outcome === "delivered" ||
      !["delivered", "suppressed", "uncertain"].includes(outcomes.get(row.intent_id) ?? "")) {
      outcomes.set(row.intent_id, row.outcome);
    }
  }
  const intentIds = new Set([...openingIds, ...createdIds, ...pendingIds, ...outcomes.keys()]);
  const terminalIds = new Set([...outcomes].filter(([,outcome]) =>
    ["delivered", "suppressed", "uncertain"].includes(outcome)).map(([id]) => id));
  const unreconciledOpeningIntents = [...openingIds].filter(id => !pendingIds.has(id) && !terminalIds.has(id)).length;
  const delivered = [...outcomes.values()].filter(outcome => outcome === "delivered").length;
  const suppressed = [...outcomes.values()].filter(outcome => outcome === "suppressed").length;
  const uncertain = [...outcomes.values()].filter(outcome => outcome === "uncertain").length;
  const pending = intentIds.size - delivered - suppressed - uncertain;
  const pageObservationGaps = pageRows.reduce((total, row) => total + row.raw_hits, 0) - rawHits;
  const summary: DiscoveryFunnel = {
    schemaVersion: 1, runId, observedAt: new Date().toISOString(),
    complete: run.status === "complete" && pageRows.every(row => row.status !== "uncertain") &&
      pageObservationGaps === 0 && identityConflicts === 0 && unreconciledOpeningIntents === 0 &&
      [...unionJobIds].every(id => selection.has(id)) &&
      fetchPlanned === fetched + notFound + fetchFailed &&
      fetched === preScreenHeld + screenMatch + screenNoMatch + screenReview + screenRetry,
    rawHits, malformedHits, validHitOccurrences,
    duplicateUrlOccurrences: validHitOccurrences - uniqueUrls, uniqueUrls,
    queuedUrls, queuedResolvedUrls, urlInputOverlap, unionUrls,
    excludedUrls: excludedUrlSet.size,
    unsupportedUrls: unsupportedUrlSet.size,
    resolvedUrls, heldUrls: heldUrlSet.size,
    resolutionPendingUrls: unionUrls - excludedUrlSet.size - unsupportedUrlSet.size -
      resolvedUrls - heldUrlSet.size,
    uniqueResolvedJobs, aliasUrls: resolvedUrls - uniqueResolvedJobs,
    dueRetryJobs, queuedInputJobs: candidateJobIds.size, backlogDiscoveryOverlap, unionInputs: unionJobIds.size,
    existingJobs: count(itemRows, "select", "existing"),
    cooldownJobs: count(itemRows, "select", "cooldown") + queuedCooldownIds.size,
    capDeferred: count(itemRows, "select", "cap_deferred") + queuedCapDeferredIds.size,
    identityReviewJobs: count(itemRows, "select", "identity_review"),
    selectedJobs,
    selectionPendingJobs: [...unionJobIds].filter(id => !selection.has(id) &&
      !queuedCooldownIds.has(id) && !queuedCapDeferredIds.has(id)).length,
    applicationLookupPending, knownApplications, fetchPlanned,
    fetched, notFound, fetchFailed, fetchPending: fetchPlanned - fetched - notFound - fetchFailed,
    preScreenHeld, screenMatch, screenNoMatch, screenReview, screenRetry,
    screenPending: fetched - preScreenHeld - screenMatch - screenNoMatch - screenReview - screenRetry,
    delivery: {
      openingPending: openingIds.size, createdUniqueIntents: intentIds.size - openingIds.size,
      delivered, suppressed, uncertain, pending,
      locationHeld: [...outcomes.values()].filter(outcome => outcome === "location_held").length,
      cooldownHeld: [...outcomes.values()].filter(outcome => outcome === "cooldown_held").length,
    },
    diagnostics: {
      failedPages: pageRows.filter(row => row.status === "failed").length,
      uncertainPages: pageRows.filter(row => row.status === "uncertain").length,
      pageObservationGaps, identityConflicts, unreconciledOpeningIntents,
    },
  };
  assertDiscoveryFunnel(summary);
  return summary;
}

export function assertDiscoveryFunnel(funnel: DiscoveryFunnel): void {
  const checks: Array<[string, number, number]> = [
    ["raw URL hits", funnel.rawHits, funnel.malformedHits + funnel.validHitOccurrences],
    ["valid URL occurrences", funnel.validHitOccurrences, funnel.duplicateUrlOccurrences + funnel.uniqueUrls],
    ["URL union", funnel.uniqueUrls + funnel.queuedUrls, funnel.unionUrls + funnel.urlInputOverlap],
    ["URL outcomes", funnel.unionUrls, funnel.excludedUrls + funnel.unsupportedUrls + funnel.resolvedUrls +
      funnel.heldUrls + funnel.resolutionPendingUrls],
    ["resolved job aliases", funnel.resolvedUrls, funnel.uniqueResolvedJobs + funnel.aliasUrls],
    ["job union", funnel.uniqueResolvedJobs + funnel.queuedInputJobs, funnel.unionInputs + funnel.backlogDiscoveryOverlap],
    ["job selection", funnel.unionInputs, funnel.existingJobs + funnel.cooldownJobs + funnel.capDeferred +
      funnel.identityReviewJobs + funnel.selectedJobs + funnel.selectionPendingJobs],
    ["application lookup", funnel.selectedJobs, funnel.applicationLookupPending + funnel.knownApplications + funnel.fetchPlanned],
    ["fetch outcomes", funnel.fetchPlanned, funnel.fetched + funnel.notFound + funnel.fetchFailed + funnel.fetchPending],
    ["screen outcomes", funnel.fetched, funnel.preScreenHeld + funnel.screenMatch + funnel.screenNoMatch + funnel.screenReview + funnel.screenRetry + funnel.screenPending],
    ["delivery intents", funnel.delivery.openingPending + funnel.delivery.createdUniqueIntents,
      funnel.delivery.delivered + funnel.delivery.suppressed + funnel.delivery.uncertain + funnel.delivery.pending],
  ];
  for (const [name, left, right] of checks) {
    if (left !== right) throw new Error(`Discovery funnel ${name} does not conserve: ${left} != ${right}`);
  }
  if (funnel.dueRetryJobs > funnel.queuedInputJobs ||
    funnel.delivery.locationHeld > funnel.delivery.pending ||
    funnel.delivery.cooldownHeld > funnel.delivery.pending) throw new Error("Discovery funnel subset bound failed");
  const scalars = Object.entries(funnel).filter(([,value]) => typeof value === "number") as Array<[string,number]>;
  for (const [name, value] of [...scalars,
    ...Object.entries(funnel.delivery).map(([key,value]) => [`delivery.${key}`, value] as [string,number])]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Discovery funnel ${name} must be a nonnegative integer`);
  }
}
