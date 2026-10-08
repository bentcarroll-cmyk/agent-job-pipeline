import { fencedBatch, renewLease, type DiscoveryLease } from "../operations/leases";
import { matchesFixedWorkdaySource, fixedSourceForJob, type Source, type NormalizedJob } from "../sources";
import { observedUrl } from "./observe";
import { jobRefId, parseJobUrl } from "../unbounded/discovery";
import type { CandidateClaim } from "./candidates";
import { getExistingAtsJobOwners } from "../db";

function snapshotFixedCandidate(db: D1Database, lease: DiscoveryLease, now: number,
  eligible: string, guard: (string | number | null)[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO discovery_run_candidate_inputs
    (run_id,candidate_key,original_url,canonical_job_id,kind,observed_this_run,observed_at,
      status_at_claim,next_attempt_at_at_claim,failure_category_at_claim,claim_selected)
    SELECT ?,candidate_key,original_url,canonical_job_id,
      CASE WHEN first_run_id=? THEN 'current'
        WHEN (status='retry_wait' AND next_attempt_at<=?) OR EXISTS (
          SELECT 1 FROM discovery_retries r WHERE r.pipeline='fixed_boards'
            AND r.job_id=discovery_candidates.candidate_key AND r.next_attempt_at<=?)
          THEN 'due_retry' ELSE 'carryover' END,
      CASE WHEN last_seen_run_id=? OR EXISTS (SELECT 1 FROM discovery_url_observations o
        WHERE o.run_id=? AND o.job_id=discovery_candidates.candidate_key) THEN 1 ELSE 0 END,?,status,
      MAX(next_attempt_at,COALESCE((SELECT next_attempt_at FROM discovery_retries r
        WHERE r.pipeline='fixed_boards' AND r.job_id=discovery_candidates.candidate_key),0)),
      failure_category,0 FROM discovery_candidates WHERE ${eligible}
    ON CONFLICT(run_id,candidate_key) DO NOTHING`)
    .bind(lease.owner, lease.owner, now, now, lease.owner, lease.owner, new Date(now).toISOString(), ...guard);
}

export async function holdFixedOwnerConflict(db: D1Database, lease: DiscoveryLease,
  candidateKey: string, currentUrl: string, now: number): Promise<void> {
  if (lease.pipeline !== "fixed_boards") throw new Error("Fixed candidate requires fixed-board lease");
  const eligible = `pipeline='fixed_boards' AND candidate_key=? AND current_url=?
    AND canonical_job_id=candidate_key
    AND EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')`;
  const guard = [candidateKey, currentUrl, lease.owner];
  await fencedBatch(db, lease, [
    snapshotFixedCandidate(db, lease, now, eligible, guard),
    db.prepare(`INSERT INTO discovery_run_items (run_id,item_id,stage,outcome,at,detail)
      SELECT ?,candidate_key,'select','identity_review',?,'ambiguous_ats_owner'
      FROM discovery_candidates WHERE ${eligible}
      ON CONFLICT(run_id,item_id,stage) DO NOTHING`)
      .bind(lease.owner, new Date(now).toISOString(), ...guard),
    db.prepare(`UPDATE discovery_candidates SET status='held',failure_category='ambiguous_ats_owner',
      claim_run_id=NULL,claim_fence=NULL,merged_owner_key=NULL WHERE ${eligible}`).bind(...guard),
  ]);
}

// Reconcile ownership before retry eligibility: a future cooldown must not
// hide a posting already assessed, dispositioned, or delivered by manual intake.
// Page only candidate metadata; owner lookup uses indexed IDs and ATS proof.
export async function reconcileFixedCandidateOwners(db: D1Database,
  lease: DiscoveryLease, now: number, sources: readonly Source[]): Promise<void> {
  if (lease.pipeline !== "fixed_boards") throw new Error("Fixed candidate requires fixed-board lease");
  const openOrRetry = `(status IN ('pending','claimed','retry_wait','held') OR
    (status='complete' AND EXISTS (SELECT 1 FROM discovery_retries r
      WHERE r.pipeline='fixed_boards' AND r.job_id=discovery_candidates.candidate_key)))`;
  let after = "";
  while (true) {
    await renewLease(db, lease);
    const rows = (await db.prepare(`SELECT candidate_key,current_url,failure_category FROM discovery_candidates
      WHERE pipeline='fixed_boards' AND candidate_key>? AND canonical_job_id=candidate_key
        AND ${openOrRetry}
      ORDER BY candidate_key LIMIT 50`).bind(after)
      .all<{candidate_key:string;current_url:string;failure_category:string|null}>()).results;
    if (!rows.length) return;
    const conflicts = new Set<string>();
    const owners = await getExistingAtsJobOwners(db,
      rows.map(row => ({ id: row.candidate_key, url: row.current_url })), sources, conflicts);
    for (const row of rows) {
      if (conflicts.has(row.candidate_key)) {
        await holdFixedOwnerConflict(db, lease, row.candidate_key, row.current_url, now);
        continue;
      }
      const ownerId = owners.get(row.candidate_key);
      if (!ownerId || (ownerId === row.candidate_key && row.failure_category !== "ambiguous_ats_owner")) continue;
      const owner = await db.prepare("SELECT url FROM jobs WHERE id=?").bind(ownerId).first<{url:string}>();
      const requested = parseJobUrl(row.current_url, "");
      const stored = owner && parseJobUrl(owner.url, "");
      const [ats, company, ...postingParts] = row.candidate_key.split(":");
      const source = sources.find(item => item.ats === ats && item.company === company);
      if (!requested || !stored || requested.ats === "workday" ||
        !source || !("slug" in source) || requested.ats !== ats ||
        requested.slug.toLowerCase() !== source.slug.toLowerCase() ||
        requested.postingId.toLowerCase() !== postingParts.join(":").toLowerCase() ||
        jobRefId(requested) !== jobRefId(stored)) continue;
      const canonicalId = jobRefId(requested);
      const eligible = `pipeline='fixed_boards' AND candidate_key=? AND canonical_job_id=candidate_key
        AND current_url=? AND ${openOrRetry}
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id IN (discovery_candidates.candidate_key,?) AND j.id<>?)
        AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=? AND j.url=? AND
          (j.match IS NOT NULL OR j.is_known_application=1 OR j.application_status<>'not_applied'
            OR j.notified_at IS NOT NULL))
        AND EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND status='running')`;
      const guard = [row.candidate_key, row.current_url, canonicalId, ownerId, ownerId, owner.url, lease.owner];
      const mergedOwner = ownerId === row.candidate_key ? null : ownerId;
      const at = new Date(now).toISOString();
      // Snapshot, reason, completion, and receipt deletion commit together.
      // Keep the display-cased candidate ID in the run funnel and retain the
      // proven owner separately; neither jobs nor delivery receipts are changed.
      await fencedBatch(db, lease, [
        snapshotFixedCandidate(db, lease, now, eligible, guard),
        db.prepare(`INSERT INTO discovery_run_items (run_id,item_id,stage,outcome,at,detail)
          SELECT ?,candidate_key,'select','existing',?,? FROM discovery_candidates WHERE ${eligible}
          ON CONFLICT(run_id,item_id,stage) DO NOTHING`).bind(lease.owner, at, ownerId, ...guard),
        db.prepare(`UPDATE discovery_candidates SET status='complete',next_attempt_at=0,
          failure_category=NULL,claim_run_id=NULL,claim_fence=NULL,merged_owner_key=?
          WHERE ${eligible}`).bind(mergedOwner, ...guard),
        db.prepare(`DELETE FROM discovery_retries WHERE pipeline='fixed_boards' AND job_id=?
          AND EXISTS (SELECT 1 FROM discovery_candidates WHERE pipeline='fixed_boards'
            AND candidate_key=? AND canonical_job_id=candidate_key AND current_url=?
            AND status='complete' AND merged_owner_key IS ?)
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE id IN (?,?) AND id<>?)
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=? AND j.url=? AND
            (j.match IS NOT NULL OR j.is_known_application=1 OR j.application_status<>'not_applied'
              OR j.notified_at IS NOT NULL))`)
          .bind(row.candidate_key, row.candidate_key, row.current_url, mergedOwner,
            row.candidate_key, canonicalId, ownerId, ownerId, owner.url),
      ]);
    }
    after = rows[rows.length - 1].candidate_key;
  }
}

export type ClaimedFixedCandidate = {
  claim: CandidateClaim;
  job: NormalizedJob;
  observedThisRun: boolean;
  discoveredAt: string;
};

// A fixed board's display-cased ID can refer to a job already owned by a
// lowercase manual-intake ID. Keep the candidate key stable for later board
// observations, but complete its claim against a proven ATS owner.
export async function settleFixedAliasCandidate(db: D1Database, lease: DiscoveryLease,
  claim: CandidateClaim, job: NormalizedJob, ownerId: string): Promise<void> {
  if (lease.pipeline !== "fixed_boards" || claim.candidateKey !== job.id ||
    claim.claimRunId !== lease.owner || claim.fence !== lease.fence || ownerId === job.id) {
    throw new Error("Invalid fixed candidate alias claim");
  }
  const owner = await db.prepare("SELECT url FROM jobs WHERE id=?").bind(ownerId).first<{ url: string }>();
  const requested = parseJobUrl(job.url, "");
  const stored = owner && parseJobUrl(owner.url, "");
  if (!requested || !stored || requested.ats === "workday" ||
    jobRefId(requested) !== jobRefId(stored)) throw new Error("Fixed candidate alias lacks ATS identity proof");
  const results = await fencedBatch(db, lease, [db.prepare(`UPDATE discovery_candidates
    SET status='complete',next_attempt_at=0,failure_category=NULL,
      claim_run_id=NULL,claim_fence=NULL,merged_owner_key=?
    WHERE pipeline='fixed_boards' AND candidate_key=? AND canonical_job_id=?
      AND status='claimed' AND claim_run_id=? AND claim_fence=?
      AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND url=?)`)
    .bind(ownerId, claim.candidateKey, job.id, lease.owner, lease.fence, ownerId, owner.url)]);
  if (results[0]?.meta.changes !== 1) throw new Error("Fixed candidate alias claim was lost");
}

// Fixed board identity comes from a configured board response, including
// Greenhouse listings whose public application URL uses an employer host.
// Retain the bounded listing context without treating its snapshot as fresh
// posting availability on a later run.
export async function persistFixedCandidate(db: D1Database, lease: DiscoveryLease,
  job: NormalizedJob, sourceId: string, discoveredAt: string,
  sources: readonly Source[], observedAt = Date.now()): Promise<void> {
  const source = fixedSourceForJob(job, sources);
  const url = observedUrl(job.url);
  if (lease.pipeline !== "fixed_boards" || !source || `${source.ats}:${source.company}` !== sourceId || source.company !== job.company ||
    !job.id.startsWith(`${source.ats}:${source.company}:`) || job.id.length > 160 ||
    !job.id.slice(`${source.ats}:${source.company}:`.length) ||
    !job.title?.trim() || !url ||
    (source.ats === "workday" && !matchesFixedWorkdaySource(job, sources)) ||
    !Number.isFinite(Date.parse(discoveredAt)) ||
    !Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error("Fixed candidate source or identity is invalid");
  }
  const context = JSON.stringify(job);
  if (context.length > 20_000) throw new Error("Fixed candidate context exceeds bounded retention");
  const results = await fencedBatch(db, lease, [db.prepare(`INSERT INTO discovery_candidates
    (pipeline,candidate_key,original_url,current_url,canonical_job_id,discovered_at,last_seen_at,
      first_run_id,last_seen_run_id,source_id,fixed_context_json,status)
    VALUES ('fixed_boards',?,?,?,?,?,?,?,?,?,?,'pending')
    ON CONFLICT(pipeline,candidate_key) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,last_seen_run_id=excluded.last_seen_run_id,
      current_url=CASE WHEN discovery_candidates.status IN ('pending','held')
        THEN excluded.current_url ELSE discovery_candidates.current_url END,
      fixed_context_json=excluded.fixed_context_json,
      status=CASE WHEN discovery_candidates.status='held' THEN 'pending'
        ELSE discovery_candidates.status END,
      failure_category=CASE WHEN discovery_candidates.status='held' THEN NULL
        ELSE discovery_candidates.failure_category END
    WHERE discovery_candidates.canonical_job_id=excluded.canonical_job_id
      AND discovery_candidates.source_id=excluded.source_id`)
    .bind(job.id, url, url, job.id, discoveredAt, new Date(observedAt).toISOString(),
      lease.owner, lease.owner, sourceId, context)]);
  if (results[0]?.meta.changes !== 1) throw new Error("Fixed candidate identity conflicts with stored context");
}

export async function loadClaimedFixedCandidates(db: D1Database,
  lease: DiscoveryLease): Promise<ClaimedFixedCandidate[]> {
  if (lease.pipeline !== "fixed_boards") throw new Error("Fixed candidate requires fixed-board lease");
  await renewLease(db, lease);
  const rows = (await db.prepare(`SELECT candidate_key,fixed_context_json,last_seen_run_id,discovered_at
    FROM discovery_candidates WHERE pipeline='fixed_boards' AND status='claimed'
      AND claim_run_id=? AND claim_fence=? ORDER BY discovered_at,candidate_key`)
    .bind(lease.owner, lease.fence).all<{candidate_key:string;fixed_context_json:string|null;
      last_seen_run_id:string;discovered_at:string}>()).results;
  return rows.map(row => {
    if (!row.fixed_context_json) throw new Error("Claimed fixed candidate lacks source context");
    const job = JSON.parse(row.fixed_context_json) as NormalizedJob;
    if (job.id !== row.candidate_key || !job.url) throw new Error("Claimed fixed candidate identity changed");
    return { claim: { candidateKey: row.candidate_key, claimRunId: lease.owner, fence: lease.fence },
      job, observedThisRun: row.last_seen_run_id === lease.owner, discoveredAt: row.discovered_at };
  });
}
