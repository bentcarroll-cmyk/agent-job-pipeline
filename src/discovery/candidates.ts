import type { Source } from "../sources";
import { fencedBatch, renewLease, type DiscoveryLease, type DiscoveryPipeline } from "../operations/leases";
import { observedUrl } from "./observe";
import type { ResolutionResult } from "./types";
import { jobRefId, parseJobUrl } from "../unbounded/discovery";
import { lookupAliasOwner } from "./aliases";
import { reconcileFixedCandidateOwners } from "./fixed-candidates";

export type CandidateInput = {
  candidateKey: string;
  originalUrl: string;
  canonicalJobId: string | null;
  discoveredAt: string;
  sourceId: string;
  resolution: ResolutionResult | null;
};
export type CandidateClaim = { candidateKey: string; claimRunId: string; fence: number };
export type StoredCandidate = CandidateClaim & { originalUrl: string; canonicalJobId: string | null;
  resolution: ResolutionResult | null; discoveredAt: string; sourceId: string };

export async function readCandidateInventory(db: D1Database, pipeline: DiscoveryPipeline,
  now = Date.now()): Promise<{ pending: number; claimed: number; retryWait: number; dueRetry: number;
  held: number; oldestOpenDiscoveredAt: string | null }> {
  const row = await db.prepare(`SELECT
    sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
    sum(CASE WHEN status='claimed' THEN 1 ELSE 0 END) AS claimed,
    sum(CASE WHEN status='retry_wait' THEN 1 ELSE 0 END) AS retry_wait,
    sum(CASE WHEN status='retry_wait' AND next_attempt_at<=? THEN 1 ELSE 0 END) AS due_retry,
    sum(CASE WHEN status='held' THEN 1 ELSE 0 END) AS held,
    min(CASE WHEN status<>'complete' THEN discovered_at END) AS oldest_open_discovered_at
    FROM discovery_candidates WHERE pipeline=?`).bind(now, pipeline).first<{
      pending:number|null;claimed:number|null;retry_wait:number|null;due_retry:number|null;
      held:number|null;oldest_open_discovered_at:string|null}>();
  return { pending: row?.pending ?? 0, claimed: row?.claimed ?? 0,
    retryWait: row?.retry_wait ?? 0, dueRetry: row?.due_retry ?? 0,
    held: row?.held ?? 0, oldestOpenDiscoveredAt: row?.oldest_open_discovered_at ?? null };
}

export async function missingRetryContext(db: D1Database, pipeline: DiscoveryPipeline,
  now = Date.now()): Promise<{rows:Array<{jobId:string;stage:string;failedAt:number;nextAttemptAt:number;
    reason:"missing_retry_context"}>;total:number}> {
  const where = `r.pipeline=? AND r.next_attempt_at<=?
      AND NOT EXISTS (SELECT 1 FROM discovery_candidates c
        WHERE c.pipeline=r.pipeline AND c.candidate_key=r.job_id
          AND (json_extract(c.resolution_json,'$.kind')='resolved'
            OR (r.pipeline='fixed_boards' AND c.fixed_context_json IS NOT NULL)))`;
  const rows = (await db.prepare(`SELECT r.job_id,r.stage,r.failed_at,r.next_attempt_at
    FROM discovery_retries r WHERE ${where}
    ORDER BY r.failed_at,r.job_id LIMIT 100`)
    .bind(pipeline, now).all<{job_id:string;stage:string;failed_at:number;next_attempt_at:number}>()).results;
  const total = await db.prepare(`SELECT count(*) AS n FROM discovery_retries r WHERE ${where}`)
    .bind(pipeline, now).first<{n:number}>();
  return { rows: rows.map(row => ({ jobId: row.job_id, stage: row.stage,
    failedAt: row.failed_at, nextAttemptAt: row.next_attempt_at,
    reason: "missing_retry_context" as const })), total: total?.n ?? 0 };
}

export async function candidateKeyFor(url: string, canonicalJobId: string | null): Promise<string> {
  if (canonicalJobId) return canonicalJobId;
  const normalized = observedUrl(url);
  if (!normalized) throw new Error("Candidate URL is not a bounded HTTPS observation");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return `url:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function compactResolution(result: ResolutionResult | null): string | null {
  if (!result) return null;
  if (result.kind === "held") return JSON.stringify({ ...result, detail: result.detail.slice(0, 500) });
  const posting = result.posting.kind === "employer"
    ? { ...result.posting, job: { ...result.posting.job, description: null, compensation: null } }
    : result.posting;
  const encoded = JSON.stringify({ ...result, posting });
  if (encoded.length > 20_000) throw new Error("Candidate resolution exceeds bounded context");
  return encoded;
}

export async function persistCandidate(db: D1Database, lease: DiscoveryLease,
  input: CandidateInput, observedAt = Date.now()): Promise<void> {
  const url = observedUrl(input.originalUrl);
  const strictRef = url ? parseJobUrl(url, "") : null;
  const resolved = input.resolution?.kind === "resolved" ? input.resolution : null;
  const posting = resolved?.posting ?? null;
  const provenOwner = strictRef && input.canonicalJobId && jobRefId(strictRef) !== input.canonicalJobId
    ? await lookupAliasOwner(db, url!) : null;
  if (!url || !input.candidateKey || input.candidateKey.length > 160 ||
    input.candidateKey !== await candidateKeyFor(url, input.canonicalJobId) ||
    !Number.isFinite(Date.parse(input.discoveredAt)) || !input.sourceId.trim() ||
    input.sourceId.length > 160 ||
    (input.resolution?.kind === "resolved" &&
      (input.resolution.posting.jobId !== input.canonicalJobId && provenOwner !== input.canonicalJobId ||
        !input.resolution.aliases.some(alias => observedUrl(alias) === url))) ||
    (strictRef && input.canonicalJobId !== null && jobRefId(strictRef) !== input.canonicalJobId &&
      provenOwner !== input.canonicalJobId) ||
    (posting?.kind === "ats" &&
      (jobRefId(posting.ref) !== posting.jobId ||
        parseJobUrl(posting.canonicalUrl, "")?.postingId !== posting.ref.postingId)) ||
    (posting?.kind === "employer" &&
      (posting.jobId !== `employer:${posting.employerKey}:${encodeURIComponent(posting.requisitionId)}` ||
        !resolved?.evidence.some(item => observedUrl(item.url) === url &&
          item.employerKey === posting.employerKey && item.requisitionId === posting.requisitionId))) ||
    (input.resolution?.kind !== "resolved" && input.canonicalJobId !== null)) {
    throw new Error("Candidate identity or source context is invalid");
  }
  const status = input.resolution?.kind === "resolved" || input.resolution === null ? "pending" :
    input.resolution.retryable ? "retry_wait" : "held";
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error("Invalid candidate observation time");
  const reason = input.resolution?.kind === "held" ? input.resolution.reason :
    input.resolution ? null : "unresolved_source";
  const resolution = compactResolution(input.resolution);
  const urlKey = await candidateKeyFor(url, null);
  const prior = input.canonicalJobId ? await db.prepare(`SELECT merged_owner_key FROM discovery_candidates
    WHERE pipeline=? AND candidate_key=?`).bind(lease.pipeline, urlKey)
    .first<{merged_owner_key:string|null}>() : null;
  if (prior?.merged_owner_key && prior.merged_owner_key !== input.candidateKey) {
    throw new Error("Unresolved URL already converged on another owner");
  }
  const statements = [];
  if (input.canonicalJobId) statements.push(db.prepare(`INSERT INTO discovery_candidate_url_owners
    (pipeline,url_key,owner_key) VALUES (?,?,?)
    ON CONFLICT(pipeline,url_key) DO UPDATE SET owner_key=
      CASE WHEN owner_key=excluded.owner_key THEN owner_key ELSE NULL END`)
    .bind(lease.pipeline, urlKey, input.candidateKey));
  statements.push(db.prepare(`INSERT INTO discovery_candidates
    (pipeline,candidate_key,original_url,current_url,canonical_job_id,discovered_at,last_seen_at,
      first_run_id,last_seen_run_id,
      source_id,resolution_json,status,next_attempt_at,failure_category)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pipeline,candidate_key) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,
      last_seen_run_id=excluded.last_seen_run_id,
      current_url=CASE WHEN discovery_candidates.status IN ('pending','held') THEN excluded.current_url
        ELSE discovery_candidates.current_url END,
      resolution_json=CASE WHEN discovery_candidates.status IN ('pending','held')
        THEN COALESCE(excluded.resolution_json,discovery_candidates.resolution_json)
        ELSE discovery_candidates.resolution_json END,
      status=CASE WHEN discovery_candidates.status='held' AND excluded.status IN ('pending','retry_wait')
        THEN excluded.status
        ELSE discovery_candidates.status END,
      next_attempt_at=CASE WHEN discovery_candidates.status='held' AND excluded.status='retry_wait'
        THEN excluded.next_attempt_at ELSE discovery_candidates.next_attempt_at END,
      failure_category=CASE WHEN discovery_candidates.status='held' AND excluded.status='pending'
        THEN NULL WHEN discovery_candidates.status='held' AND excluded.status='retry_wait'
        THEN excluded.failure_category ELSE discovery_candidates.failure_category END
    WHERE discovery_candidates.canonical_job_id IS excluded.canonical_job_id`)
    .bind(lease.pipeline, input.candidateKey, url, url, input.canonicalJobId,
      input.discoveredAt, new Date(observedAt).toISOString(), lease.owner, lease.owner,
      input.sourceId, resolution, status,
      status === "retry_wait" ? observedAt + 6 * 3600_000 : 0, reason));
  if (input.canonicalJobId) {
    statements.push(db.prepare(`UPDATE discovery_candidates SET
      discovered_at=MIN(discovered_at,COALESCE((SELECT discovered_at FROM discovery_candidates
        WHERE pipeline=? AND candidate_key=?),discovered_at)),
      original_url=CASE WHEN EXISTS (SELECT 1 FROM discovery_candidates u
        WHERE u.pipeline=? AND u.candidate_key=? AND u.discovered_at<discovery_candidates.discovered_at)
        THEN (SELECT original_url FROM discovery_candidates WHERE pipeline=? AND candidate_key=?)
        ELSE original_url END,
      source_id=CASE WHEN EXISTS (SELECT 1 FROM discovery_candidates u
        WHERE u.pipeline=? AND u.candidate_key=? AND u.discovered_at<discovery_candidates.discovered_at)
        THEN (SELECT source_id FROM discovery_candidates WHERE pipeline=? AND candidate_key=?)
        ELSE source_id END
      WHERE pipeline=? AND candidate_key=?`)
      .bind(lease.pipeline, urlKey, lease.pipeline, urlKey, lease.pipeline, urlKey,
        lease.pipeline, urlKey, lease.pipeline, urlKey, lease.pipeline, input.candidateKey));
    statements.push(db.prepare(`UPDATE discovery_candidates SET status='complete',
      merged_owner_key=?,failure_category=NULL,next_attempt_at=0,claim_run_id=NULL,claim_fence=NULL
      WHERE pipeline=? AND candidate_key=? AND canonical_job_id IS NULL
        AND (merged_owner_key IS NULL OR merged_owner_key=?)`)
      .bind(input.candidateKey, lease.pipeline, urlKey, input.candidateKey));
  }
  const results = await fencedBatch(db, lease, statements);
  if (results[input.canonicalJobId ? 1 : 0]?.meta.changes !== 1) {
    throw new Error("Candidate key conflicts with an existing canonical identity");
  }
}

export async function selectCandidateBatch(db: D1Database, lease: DiscoveryLease,
  options: { now: number; totalLimit: number; dueRetryLimit: number; sources: readonly Source[] }): Promise<CandidateClaim[]> {
  const { now, totalLimit, dueRetryLimit } = options;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > 500 ||
    !Number.isSafeInteger(dueRetryLimit) || dueRetryLimit < 0 || dueRetryLimit > totalLimit) {
    throw new Error("Invalid candidate claim budget");
  }
  await renewLease(db, lease);
  const budget = await db.prepare(`SELECT total_limit,due_retry_limit FROM discovery_candidate_claim_budgets
    WHERE pipeline=? AND run_id=? AND fence=?`).bind(lease.pipeline, lease.owner, lease.fence)
    .first<{total_limit:number;due_retry_limit:number}>();
  if (budget && (budget.total_limit !== totalLimit || budget.due_retry_limit !== dueRetryLimit)) {
    throw new Error("Candidate claim budget changed on replay");
  }
  const existing = (await db.prepare(`SELECT candidate_key FROM discovery_candidates
    WHERE pipeline=? AND status='claimed' AND claim_run_id=? AND claim_fence=?
    ORDER BY discovered_at,candidate_key`).bind(lease.pipeline, lease.owner, lease.fence)
    .all<{candidate_key:string}>()).results;
  if (budget) return existing.map(row => ({ candidateKey: row.candidate_key,
    claimRunId: lease.owner, fence: lease.fence }));

  if (lease.pipeline === "fixed_boards") await reconcileFixedCandidateOwners(db, lease, now, options.sources);

  // A saved assessment or explicit user choice is stronger than a stale
  // fetch/filter retry receipt. Reconcile the receipt without reassessing or
  // changing the saved job. An unassessed saved row needs separate review.
  await fencedBatch(db, lease, [db.prepare(`DELETE FROM discovery_retries
    WHERE pipeline=? AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=discovery_retries.job_id
      AND (j.match IS NOT NULL OR j.is_known_application=1 OR j.application_status<>'not_applied'))
      AND NOT EXISTS (SELECT 1 FROM discovery_candidates c WHERE c.pipeline=discovery_retries.pipeline
        AND c.candidate_key=discovery_retries.job_id AND c.failure_category='ambiguous_ats_owner')`)
    .bind(lease.pipeline)]);
  // Mark rows already owned by the jobs ledger complete before arbitration.
  await fencedBatch(db, lease, [db.prepare(`UPDATE discovery_candidates SET status='complete',
    claim_run_id=NULL,claim_fence=NULL,failure_category=NULL
    WHERE pipeline=? AND canonical_job_id IS NOT NULL AND status IN ('pending','claimed','retry_wait')
      AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=discovery_candidates.canonical_job_id)
      AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
        AND r.job_id=discovery_candidates.canonical_job_id)`)
    .bind(lease.pipeline)]);
  await fencedBatch(db, lease, [db.prepare(`UPDATE discovery_candidates
    SET status='held',failure_category='existing_unassessed_requires_review',next_attempt_at=0,
      claim_run_id=NULL,claim_fence=NULL
    WHERE pipeline=? AND canonical_job_id IS NOT NULL AND status IN ('pending','claimed','retry_wait')
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=discovery_candidates.canonical_job_id
        AND j.match IS NULL AND j.is_known_application=0 AND j.application_status='not_applied')
      AND EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
        AND r.job_id=discovery_candidates.canonical_job_id AND r.next_attempt_at<=?)`)
    .bind(lease.pipeline, now)]);
  const retry = (await db.prepare(`SELECT candidate_key FROM discovery_candidates
    WHERE pipeline=? AND ((status='retry_wait' AND next_attempt_at<=?
      AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
        AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at>?)) OR
      (status='claimed' AND (claim_run_id<>? OR claim_fence<>?)
        AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
          AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at>?)) OR
      (status IN ('pending','complete') AND EXISTS (SELECT 1 FROM discovery_retries r
        WHERE r.pipeline=discovery_candidates.pipeline AND r.job_id=discovery_candidates.candidate_key
          AND r.next_attempt_at<=?)))
    ORDER BY discovered_at,candidate_key LIMIT ?`)
    .bind(lease.pipeline, now, now, lease.owner, lease.fence, now, now, dueRetryLimit)
    .all<{candidate_key:string}>()).results.map(row => row.candidate_key);
  const fresh = (await db.prepare(`SELECT candidate_key FROM discovery_candidates
    WHERE pipeline=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM discovery_retries r
      WHERE r.pipeline=discovery_candidates.pipeline AND r.job_id=discovery_candidates.candidate_key)
    ORDER BY discovered_at,candidate_key LIMIT ?`)
    .bind(lease.pipeline, totalLimit - retry.length)
    .all<{candidate_key:string}>()).results.map(row => row.candidate_key);
  const keys = [...retry, ...fresh];
  const budgetStatement = db.prepare(`INSERT INTO discovery_candidate_claim_budgets
    (pipeline,run_id,fence,total_limit,due_retry_limit) VALUES (?,?,?,?,?)`)
    .bind(lease.pipeline, lease.owner, lease.fence, totalLimit, dueRetryLimit);
  const inputs = db.prepare(`INSERT INTO discovery_run_candidate_inputs
    (run_id,candidate_key,original_url,canonical_job_id,kind,observed_this_run,observed_at,
      status_at_claim,next_attempt_at_at_claim,failure_category_at_claim,claim_selected)
    SELECT ?,candidate_key,original_url,canonical_job_id,
      CASE WHEN first_run_id=? THEN 'current'
        WHEN (status='retry_wait' AND next_attempt_at<=?) OR EXISTS (
          SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
            AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at<=?)
          THEN 'due_retry' ELSE 'carryover' END,
      CASE WHEN last_seen_run_id=? OR EXISTS (SELECT 1 FROM discovery_url_observations o
        WHERE o.run_id=? AND o.job_id=discovery_candidates.candidate_key) THEN 1 ELSE 0 END,?,
      status,MAX(next_attempt_at,COALESCE((SELECT r.next_attempt_at FROM discovery_retries r
        WHERE r.pipeline=discovery_candidates.pipeline AND r.job_id=discovery_candidates.candidate_key),0)),
      failure_category,
      CASE WHEN candidate_key IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END
    FROM discovery_candidates WHERE pipeline=? AND (status<>'complete' OR EXISTS (
      SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
        AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at<=?))
    ON CONFLICT(run_id,candidate_key) DO NOTHING`)
    .bind(lease.owner, lease.owner, now, now, lease.owner, lease.owner, new Date(now).toISOString(),
      JSON.stringify(keys), lease.pipeline, now);
  if (!keys.length) {
    await fencedBatch(db, lease, [budgetStatement, inputs]);
    return [];
  }
  const sql = `UPDATE discovery_candidates SET status='claimed',claim_run_id=?,claim_fence=?,
    attempt_count=attempt_count+1,failure_category=NULL
    WHERE pipeline=? AND candidate_key IN (SELECT value FROM json_each(?))
      AND (status='pending' OR (status='retry_wait' AND next_attempt_at<=?
        AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
          AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at>?)) OR
        (status='claimed' AND (claim_run_id<>? OR claim_fence<>?)
          AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
            AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at>?)) OR
        (status='complete' AND EXISTS (SELECT 1 FROM discovery_retries r
          WHERE r.pipeline=discovery_candidates.pipeline AND r.job_id=discovery_candidates.candidate_key
            AND r.next_attempt_at<=?)))`;
  const result = await fencedBatch(db, lease, [budgetStatement, inputs, db.prepare(sql)
    .bind(lease.owner, lease.fence, lease.pipeline, JSON.stringify(keys), now, now, lease.owner,
      lease.fence, now, now)]);
  if (result[2]?.meta.changes !== keys.length) throw new Error("Candidate claim changed during arbitration");
  return keys.map(candidateKey => ({ candidateKey, claimRunId: lease.owner, fence: lease.fence }));
}

export async function getClaimedCandidates(db: D1Database, lease: DiscoveryLease): Promise<StoredCandidate[]> {
  await renewLease(db, lease);
  const rows = (await db.prepare(`SELECT candidate_key,original_url,canonical_job_id,
    resolution_json,discovered_at,source_id FROM discovery_candidates
    WHERE pipeline=? AND status='claimed' AND claim_run_id=? AND claim_fence=?
    ORDER BY discovered_at,candidate_key`).bind(lease.pipeline, lease.owner, lease.fence)
    .all<{candidate_key:string;original_url:string;canonical_job_id:string|null;
      resolution_json:string|null;discovered_at:string;source_id:string}>()).results;
  return rows.map(row => ({ candidateKey: row.candidate_key, claimRunId: lease.owner, fence: lease.fence,
    originalUrl: row.original_url, canonicalJobId: row.canonical_job_id,
    resolution: row.resolution_json ? JSON.parse(row.resolution_json) as ResolutionResult : null,
    discoveredAt: row.discovered_at, sourceId: row.source_id }));
}

export async function loadCandidateResolution(db: D1Database, pipeline: DiscoveryPipeline,
  candidateKey: string): Promise<ResolutionResult | null> {
  const row = await db.prepare(`SELECT resolution_json FROM discovery_candidates
    WHERE pipeline=? AND candidate_key=?`).bind(pipeline, candidateKey)
    .first<{resolution_json:string|null}>();
  return row?.resolution_json ? JSON.parse(row.resolution_json) as ResolutionResult : null;
}

export async function settleCandidate(db: D1Database, lease: DiscoveryLease,
  claim: CandidateClaim, outcome: { status: "complete" | "held" | "retry_wait";
    failureCategory?: string; nextAttemptAt?: number }): Promise<void> {
  if (claim.claimRunId !== lease.owner || claim.fence !== lease.fence ||
    (outcome.status === "retry_wait" && (!Number.isSafeInteger(outcome.nextAttemptAt) || outcome.nextAttemptAt! < 0))) {
    throw new Error("Candidate settlement has no valid claim or retry schedule");
  }
  const results = await fencedBatch(db, lease, [db.prepare(`UPDATE discovery_candidates
    SET status=?,next_attempt_at=?,failure_category=?,claim_run_id=NULL,claim_fence=NULL
    WHERE pipeline=? AND candidate_key=? AND status='claimed' AND claim_run_id=? AND claim_fence=?
      AND (? <> 'complete' OR (canonical_job_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=discovery_candidates.canonical_job_id)
        AND NOT EXISTS (SELECT 1 FROM discovery_retries r WHERE r.pipeline=discovery_candidates.pipeline
          AND r.job_id=discovery_candidates.canonical_job_id)))`)
    .bind(outcome.status, outcome.nextAttemptAt ?? 0, outcome.failureCategory?.slice(0, 100) ?? null,
      lease.pipeline, claim.candidateKey, lease.owner, lease.fence, outcome.status)]);
  if (results[0]?.meta.changes === 1) return;
  const prior = await db.prepare(`SELECT status,next_attempt_at,failure_category,claim_run_id,claim_fence
    FROM discovery_candidates WHERE pipeline=? AND candidate_key=?`)
    .bind(lease.pipeline, claim.candidateKey).first<{status:string;next_attempt_at:number;
      failure_category:string|null;claim_run_id:string|null;claim_fence:number|null}>();
  if (prior?.status === outcome.status && prior.next_attempt_at === (outcome.nextAttemptAt ?? 0) &&
    prior.failure_category === (outcome.failureCategory?.slice(0, 100) ?? null) &&
    prior.claim_run_id === null && prior.claim_fence === null) return;
  throw new Error("Candidate claim was lost before settlement");
}

// Reconcile after the existing job/retry writers commit. A crash before this
// call leaves a fenced claim; the next run can inspect the ledger and resume.
export async function settleOutstandingCandidates(db: D1Database, lease: DiscoveryLease,
  now = Date.now()): Promise<{ complete: number; retryWait: number; held: number }> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid settlement time");
  const claims = await getClaimedCandidates(db, lease);
  const result = { complete: 0, retryWait: 0, held: 0 };
  for (const claim of claims) {
    const [job, retry] = await db.batch([
      db.prepare("SELECT id FROM jobs WHERE id=?").bind(claim.canonicalJobId),
      db.prepare("SELECT next_attempt_at FROM discovery_retries WHERE pipeline=? AND job_id=?")
        .bind(lease.pipeline, claim.candidateKey),
    ]);
    const deadline = (retry.results[0] as {next_attempt_at:number}|undefined)?.next_attempt_at;
    if (deadline !== undefined) {
      await settleCandidate(db, lease, claim, { status: "retry_wait", nextAttemptAt: deadline,
        failureCategory: "discovery_retry" });
      result.retryWait++;
    } else if (job.results.length > 0) {
      await settleCandidate(db, lease, claim, { status: "complete" });
      result.complete++;
    } else {
      await settleCandidate(db, lease, claim, { status: "retry_wait",
        nextAttemptAt: now + 6 * 3600_000, failureCategory: "incomplete_attempt" });
      result.held++;
    }
  }
  return result;
}
