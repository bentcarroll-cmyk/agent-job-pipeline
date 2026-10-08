import { jobInsertStatement, notificationPipeline, type JobInsert } from "../db";
import type { Verdict } from "../criteria";
import type { NormalizedJob } from "../sources";
import { fencedBatch, type DiscoveryLease } from "../operations/leases";
import { recordFailure } from "../operations/retries";
import type { PostingSnapshot, ScreeningDecision, ScreeningEvaluation } from "./types";

export async function createEvaluation(input: {
  jobId: string;
  runId: string;
  snapshot: PostingSnapshot | null;
  decision: ScreeningDecision;
  evaluatedAt?: string;
  stage?: "fetch" | "filter";
}): Promise<ScreeningEvaluation> {
  assertSnapshotIdentity(input.jobId, input.snapshot);
  if (!input.snapshot && input.decision.state !== "retry") throw new Error("Completed screening requires a posting snapshot");
  const { criteriaVersion, promptVersion, model } = input.decision;
  const bytes = new TextEncoder().encode(JSON.stringify([input.runId, input.jobId, input.stage ?? "filter", criteriaVersion, promptVersion, model]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = `evaluation:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  return { id, jobId: input.jobId, runId: input.runId, snapshot: input.snapshot, decision: input.decision, evaluatedAt: input.evaluatedAt ?? new Date().toISOString() };
}

function assertSnapshotIdentity(jobId: string, snapshot: PostingSnapshot | null): void {
  if (snapshot && (snapshot.jobId !== jobId || snapshot.job.id !== jobId)) throw new Error("Posting snapshot belongs to a different job");
}

// Only INSERT ... DO NOTHING touches immutable evidence. All later projection
// reads use persisted decision bytes, never potentially changed replay input.
function evaluationStatements(db: D1Database, evaluation: ScreeningEvaluation, instanceId?: string): D1PreparedStatement[] {
  assertSnapshotIdentity(evaluation.jobId, evaluation.snapshot);
  const { snapshot, decision } = evaluation;
  const statements: D1PreparedStatement[] = [];
  if (snapshot) {
    statements.push(db.prepare(`INSERT INTO posting_snapshots
      (id,job_id,content_hash,normalized_json,company_category,fetched_at,normalizer_version)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM job_evaluations WHERE id=?)
      ON CONFLICT(id) DO NOTHING`).bind(snapshot.id, snapshot.jobId, snapshot.contentHash, JSON.stringify(snapshot.job), snapshot.companyCategory, snapshot.fetchedAt, snapshot.normalizerVersion, evaluation.id));
  }
  statements.push(db.prepare(`INSERT INTO job_evaluations
    (id,job_id,run_id,snapshot_id,state,decision_json,criteria_version,prompt_version,model,evaluated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(evaluation.id, evaluation.jobId, evaluation.runId, snapshot?.id ?? null, decision.state, JSON.stringify(decision), decision.criteriaVersion, decision.promptVersion, decision.model, evaluation.evaluatedAt));
  statements.push(db.prepare(`INSERT INTO job_screening_current (job_id,evaluation_id)
    SELECT job_id,id FROM job_evaluations WHERE id=? AND job_id=?
      AND criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
    ON CONFLICT(job_id) DO UPDATE SET evaluation_id=excluded.evaluation_id
    WHERE (SELECT criteria_version FROM job_evaluations WHERE id=job_screening_current.evaluation_id) <>
          (SELECT criteria_version FROM job_evaluations WHERE id=excluded.evaluation_id)
       OR (SELECT evaluated_at FROM job_evaluations WHERE id=excluded.evaluation_id) >
          (SELECT evaluated_at FROM job_evaluations WHERE id=job_screening_current.evaluation_id)
       OR ((SELECT evaluated_at FROM job_evaluations WHERE id=excluded.evaluation_id) =
           (SELECT evaluated_at FROM job_evaluations WHERE id=job_screening_current.evaluation_id)
           AND excluded.evaluation_id > job_screening_current.evaluation_id)`).bind(evaluation.id, evaluation.jobId, instanceId ?? null));
  return statements;
}

export async function saveScreeningResult(db: D1Database, row: JobInsert, evaluation: ScreeningEvaluation, lease?: DiscoveryLease, instanceId?: string): Promise<void> {
  if (lease && evaluation.runId !== lease.owner) throw new Error("Screening evaluation belongs to a different run");
  if (evaluation.decision.state === "retry") throw new Error("Retry outcomes require saveScreeningRetry");
  if (!evaluation.snapshot) throw new Error("Completed screening requires a posting snapshot");
  await persistResult(db, row, evaluation, lease, instanceId);
}

// /job is a prior user selection. Its advisory result can include retry without
// making new discovery work or clearing a different discovery run's cooldown.
export async function saveManualScreeningResult(db: D1Database, row: JobInsert, evaluation: ScreeningEvaluation, instanceId?: string): Promise<void> {
  if (row.applicationStatusSource !== "manual" || row.applicationStatus !== "needs_materials") throw new Error("Manual screening requires an explicitly selected job");
  await persistResult(db, row, evaluation, undefined, instanceId);
}

async function persistResult(db: D1Database, row: JobInsert, evaluation: ScreeningEvaluation, lease?: DiscoveryLease, instanceId?: string): Promise<void> {
  if (row.job.id !== evaluation.jobId) throw new Error("Screening evaluation belongs to a different job");
  if (row.criteriaVersion !== evaluation.decision.criteriaVersion) throw new Error("Job and evaluation criteria provenance differ");
  const statements = evaluationStatements(db, evaluation, instanceId);
  statements.push(jobInsertStatement(db, { ...row, verdict: null, deferNotifiedAt: true }));
  statements.push(projectionStatement(db, evaluation.jobId, instanceId));
  statements.push(db.prepare(`INSERT INTO screening_deliveries (evaluation_id,job_id,status,delivered_at)
    SELECT id,job_id,'pending',NULL FROM job_evaluations WHERE id=? AND job_id=? AND state IN ('match','needs_review')
    ON CONFLICT(evaluation_id) DO NOTHING`).bind(evaluation.id, evaluation.jobId));
  if (lease) statements.push(db.prepare("DELETE FROM discovery_retries WHERE pipeline=? AND job_id=?").bind(lease.pipeline, evaluation.jobId));
  await fencedBatch(db, lease, statements);
}

function projectionStatement(db: D1Database, jobId: string, instanceId?: string): D1PreparedStatement {
  return db.prepare(`UPDATE jobs SET
    criteria_version=(SELECT e.criteria_version FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id WHERE c.job_id=jobs.id),
    match=(SELECT CASE e.state WHEN 'match' THEN 1 WHEN 'no_match' THEN 0 ELSE NULL END
      FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id WHERE c.job_id=jobs.id),
    match_lane=(SELECT json_extract(e.decision_json,'$.lane') FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id WHERE c.job_id=jobs.id),
    match_hard_exclude=(SELECT json_extract(e.decision_json,'$.hardExclude') FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id WHERE c.job_id=jobs.id),
    match_reason=(SELECT json_extract(e.decision_json,'$.reason') FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id WHERE c.job_id=jobs.id)
    WHERE id=? AND EXISTS (SELECT 1 FROM job_screening_current c JOIN job_evaluations e ON e.id=c.evaluation_id
      WHERE c.job_id=jobs.id AND e.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?))`).bind(jobId, instanceId ?? null);
}

export async function saveScreeningRetry(db: D1Database, evaluation: ScreeningEvaluation, lease: DiscoveryLease, stage: "fetch" | "filter", error: string, instanceId?: string): Promise<void> {
  if (evaluation.decision.state !== "retry") throw new Error("Failure persistence requires a retry decision");
  if (evaluation.runId !== lease.owner) throw new Error("Retry evaluation belongs to a different run");
  await recordFailure(db, lease, evaluation.jobId, stage, error, Date.now(), [...evaluationStatements(db, evaluation, instanceId), projectionStatement(db, evaluation.jobId, instanceId)]);
}

export type PendingScreeningNotification = { job: NormalizedJob; verdict: Verdict; criteriaVersion: string; decision?: ScreeningDecision; evaluationId?: string };

export async function getPendingScreeningNotifications(db: D1Database, discoverySource: string, limit: number, afterJobId: string | null = null, instanceId?: string): Promise<PendingScreeningNotification[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const { results } = await db.prepare(`SELECT j.id,j.company,j.title,j.url,j.location,j.department,j.is_remote,j.employment_type,j.posted_at,j.compensation,
      j.match_lane,j.match_hard_exclude,j.match_reason,e.id AS evaluation_id,e.decision_json,COALESCE(e.criteria_version,j.criteria_version) AS criteria_version
    FROM jobs j
    LEFT JOIN job_screening_current c ON c.job_id=j.id
    LEFT JOIN job_evaluations e ON e.id=c.evaluation_id
    LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
    WHERE j.discovery_source=? AND j.application_status='not_applied' AND j.is_known_application=0
      AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=? AND r.job_id=j.id AND r.next_attempt_at>?)
      AND ((c.evaluation_id IS NULL AND j.match=1 AND j.notified_at IS NULL
          AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?))
        OR (e.state IN ('match','needs_review') AND (d.status IS NULL OR d.status='pending')
          AND e.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)))
      AND (? IS NULL OR (j.first_seen_at,j.id) > (SELECT first_seen_at,id FROM jobs WHERE id=?))
    ORDER BY j.first_seen_at,j.id LIMIT ?`).bind(discoverySource, notificationPipeline(discoverySource), Date.now(), instanceId ?? null, instanceId ?? null, afterJobId, afterJobId, limit).all<{
      id: string; company: string; title: string; url: string; location: string; department: string; is_remote: number | null;
      employment_type: string | null; posted_at: string | null; compensation: string | null;
      match_lane: "A" | "B" | null; match_hard_exclude: string | null; match_reason: string | null;
      criteria_version: string; evaluation_id: string | null; decision_json: string | null;
    }>();
  return results.map(r => {
    const decision: ScreeningDecision | undefined = r.decision_json ? JSON.parse(r.decision_json) : undefined;
    return { criteriaVersion: r.criteria_version, job: { id: r.id, company: r.company, title: r.title, url: r.url, location: r.location, department: r.department,
      isRemote: r.is_remote === null ? null : r.is_remote === 1, employmentType: r.employment_type, postedAt: r.posted_at, compensation: r.compensation, description: null },
      verdict: decision ? { match: decision.state === "match", lane: decision.lane, hard_exclude: decision.hardExclude, reason: decision.reason }
        : { match: true, lane: r.match_lane, hard_exclude: r.match_hard_exclude, reason: r.match_reason ?? "" },
      ...(decision ? { decision, evaluationId: r.evaluation_id! } : {}),
    };
  });
}

// A Workflow's pending-list step is memoized. Recheck this inside the actual
// notification callback so later user decisions and evaluations are respected.
export async function isScreeningNotificationPending(db: D1Database, jobId: string, evaluationId: string | undefined, pipeline?: "fixed_boards" | "unbounded_discovery", instanceId?: string, expectedVersion?: string): Promise<boolean> {
  if (!instanceId || typeof expectedVersion !== "string" || !expectedVersion) return false;
  const pending = await db.prepare(`SELECT 1 AS pending FROM jobs j
    LEFT JOIN job_screening_current c ON c.job_id=j.id
    LEFT JOIN job_evaluations e ON e.id=c.evaluation_id
    LEFT JOIN screening_deliveries d ON d.evaluation_id=e.id
    WHERE j.id=? AND j.application_status='not_applied' AND j.is_known_application=0
      AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=? AND r.job_id=j.id AND r.next_attempt_at>?)
      AND COALESCE(e.criteria_version,j.criteria_version)=?
      AND ((? IS NULL AND c.evaluation_id IS NULL AND j.match=1 AND j.notified_at IS NULL
          AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?))
        OR (c.evaluation_id=? AND e.state IN ('match','needs_review') AND (d.status IS NULL OR d.status='pending')
          AND e.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)))
    LIMIT 1`).bind(jobId, pipeline ?? "", Date.now(), expectedVersion, evaluationId ?? null, instanceId ?? null, evaluationId ?? null, instanceId ?? null).first<{ pending: number }>();
  return pending?.pending === 1;
}

export async function screeningNotificationSource(db: D1Database, jobId: string, evaluationId: string): Promise<NormalizedJob | null> {
  const row = await db.prepare(`SELECT s.normalized_json FROM job_evaluations e
    JOIN posting_snapshots s ON s.id=e.snapshot_id AND s.job_id=e.job_id
    WHERE e.id=? AND e.job_id=?`).bind(evaluationId, jobId).first<{ normalized_json: string }>();
  if (!row) return null;
  try {
    const job: NormalizedJob = JSON.parse(row.normalized_json);
    return job?.id === jobId ? job : null;
  } catch { return null; }
}

export async function markScreeningNotified(db: D1Database, jobId: string, evaluationId: string | undefined, at: string, lease?: DiscoveryLease): Promise<void> {
  if (!evaluationId) {
    await fencedBatch(db, lease, [db.prepare(`UPDATE jobs SET notified_at=COALESCE(notified_at,?) WHERE id=?
      AND application_status='not_applied' AND is_known_application=0 AND match=1
      AND NOT EXISTS (SELECT 1 FROM job_screening_current WHERE job_id=jobs.id)`).bind(at, jobId)]);
    return;
  }
  const eligible = "j.application_status='not_applied' AND j.is_known_application=0 AND c.evaluation_id=e.id";
  await fencedBatch(db, lease, [
    db.prepare(`INSERT INTO screening_deliveries (evaluation_id,job_id,status,delivered_at)
      SELECT e.id,e.job_id,CASE WHEN ${eligible} THEN 'delivered' ELSE 'suppressed' END,
        CASE WHEN ${eligible} THEN ? ELSE NULL END
      FROM job_evaluations e JOIN jobs j ON j.id=e.job_id LEFT JOIN job_screening_current c ON c.job_id=j.id
      WHERE e.id=? AND e.job_id=? AND e.state IN ('match','needs_review')
      ON CONFLICT(evaluation_id) DO UPDATE SET status=excluded.status,delivered_at=excluded.delivered_at
      WHERE screening_deliveries.status='pending'`).bind(at, evaluationId, jobId),
    db.prepare(`UPDATE jobs SET notified_at=(SELECT delivered_at FROM screening_deliveries WHERE evaluation_id=? AND job_id=? AND status='delivered')
      WHERE id=? AND application_status='not_applied' AND is_known_application=0
        AND EXISTS (SELECT 1 FROM job_screening_current c JOIN screening_deliveries d ON d.evaluation_id=c.evaluation_id
          WHERE c.job_id=jobs.id AND c.evaluation_id=? AND d.status='delivered')`).bind(evaluationId, jobId, jobId, evaluationId),
  ]);
}
