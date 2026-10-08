import type { NormalizedJob } from "../sources";
import type { Admission, IntakeRequest, IntakeState, IntakeStage, JobClaimResult } from "./types";
import type { Verdict } from "../criteria";
import type { ResolutionResult } from "../discovery/types";
import { observedUrl } from "../discovery/observe";

type RequestRow = {
  id:string;team_id:string;user_id:string;channel_id:string;input_url:string;
  state:IntakeState;stage:IntakeStage;job_id:string|null;owner_request_id:string|null;
  workflow_generation:number;workflow_id:string;created_at:string;updated_at:string;
  next_attempt_at:number;failure_code:string|null;failure_detail:string|null;
};

function mapRequest(row: RequestRow): IntakeRequest {
  return { id: row.id, teamId: row.team_id, userId: row.user_id, channelId: row.channel_id,
    inputUrl: row.input_url, state: row.state, stage: row.stage, jobId: row.job_id,
    ownerRequestId: row.owner_request_id, workflowGeneration: row.workflow_generation,
    workflowId: row.workflow_id, createdAt: row.created_at, updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at, failureCode: row.failure_code,
    failureDetail: row.failure_detail };
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      value.length <= 4096 && !!url.hostname;
  } catch { return false; }
}

export async function readIntake(db: D1Database, id: string): Promise<IntakeRequest | null> {
  const row = await db.prepare("SELECT * FROM manual_intake_requests WHERE id=?")
    .bind(id).first<RequestRow>();
  return row ? mapRequest(row) : null;
}

export async function acceptIntake(db: D1Database, input: Admission): Promise<IntakeRequest> {
  if (!/^[a-f0-9]{64}$/.test(input.id) || !input.teamId || !input.userId || !input.channelId ||
    !validUrl(input.inputUrl) || !Number.isFinite(Date.parse(input.now))) {
    throw new Error("Invalid manual intake admission");
  }
  await db.prepare(`INSERT INTO manual_intake_requests
    (id,team_id,user_id,channel_id,input_url,state,stage,workflow_id,created_at,updated_at)
    VALUES (?,?,?,?,?,'accepted','resolve',?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(input.id, input.teamId, input.userId, input.channelId, input.inputUrl,
      `intake-${input.id}-g0`, input.now, input.now).run();
  const saved = await readIntake(db, input.id);
  if (!saved || saved.teamId !== input.teamId || saved.userId !== input.userId ||
    saved.channelId !== input.channelId || saved.inputUrl !== input.inputUrl) {
    throw new Error("Conflicting manual intake request identity");
  }
  return saved;
}

export async function setIntakeStage(db: D1Database, requestId: string, generation: number,
  input: { state: IntakeState; stage: IntakeStage; at: string;
    failureCode?: string; failureDetail?: string; nextAttemptAt?: number }): Promise<boolean> {
  if (!Number.isSafeInteger(generation) || generation < 0 ||
    !Number.isFinite(Date.parse(input.at)) || !Number.isSafeInteger(input.nextAttemptAt ?? 0))
    throw new Error("Invalid manual intake stage");
  const result = await db.prepare(`UPDATE manual_intake_requests SET state=?,stage=?,
    failure_code=?,failure_detail=?,next_attempt_at=?,updated_at=?
    WHERE id=? AND workflow_generation=? AND state NOT IN
      ('delivered','already_tracked','held','delivery_unknown')`)
    .bind(input.state, input.stage, input.failureCode ?? null, input.failureDetail ?? null,
      input.nextAttemptAt ?? 0, input.at, requestId, generation).run();
  return result.meta.changes === 1;
}

export async function saveResolutionResult(db: D1Database, requestId: string, generation: number,
  result: ResolutionResult, at: string): Promise<boolean> {
  const update = await db.prepare(`UPDATE manual_intake_requests SET resolution_json=?,
    state='fetching',stage='fetch',failure_code=NULL,failure_detail=NULL,
    next_attempt_at=0,updated_at=? WHERE id=? AND workflow_generation=? AND state NOT IN
      ('delivered','already_tracked','held','delivery_unknown')`)
    .bind(JSON.stringify(result), at, requestId, generation).run();
  return update.meta.changes === 1;
}

export async function readAdvisory(db: D1Database, requestId: string): Promise<{
  verdict: Verdict | null; failure: string | null } | null> {
  const row = await db.prepare("SELECT advisory_json FROM manual_intake_requests WHERE id=?")
    .bind(requestId).first<{advisory_json:string|null}>();
  return row?.advisory_json ? JSON.parse(row.advisory_json) as {
    verdict: Verdict | null; failure: string | null } : null;
}

export async function saveAdvisory(db: D1Database, requestId: string, generation: number,
  verdict: Verdict | null, failure: string | null, at: string, criteriaVersion?: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE manual_intake_requests SET advisory_json=?,
    state=CASE WHEN EXISTS (SELECT 1 FROM jobs j JOIN manual_intake_jobs m ON m.job_id=j.id
      WHERE j.id=manual_intake_requests.job_id AND m.owner_request_id=manual_intake_requests.id
        AND j.application_status='needs_materials' AND j.application_status_source='manual'
        AND j.discovery_source='manual_add') THEN 'ready' ELSE 'already_tracked' END,
    stage='deliver',failure_code=?,next_attempt_at=0,updated_at=?
    WHERE id=? AND workflow_generation=? AND state IN ('saved','screening','ready')`)
    .bind(JSON.stringify({ verdict, failure, criteriaVersion: criteriaVersion ?? null }), failure ? "advisory_unavailable" : null,
      at, requestId, generation).run();
  return result.meta.changes === 1;
}

async function existingJob(db: D1Database, jobId: string): Promise<{
  application_status:string;notified_at:string|null}|null> {
  return db.prepare("SELECT application_status,notified_at FROM jobs WHERE id=?")
    .bind(jobId).first<{application_status:string;notified_at:string|null}>();
}

async function knownApplications(db: D1Database, job: NormalizedJob): Promise<Array<{
  status:string|null;source_job_id:string|null;canonical_id:string|null;posting_url:string|null}>> {
  const requisition = decodeURIComponent(job.id.split(":").at(-1) ?? "");
  return (await db.prepare(`SELECT status,source_job_id,canonical_id,posting_url FROM known_applications
    WHERE canonical_id=? OR posting_url=? OR
      (lower(trim(COALESCE(employer,'')))=lower(trim(?)) AND
        (lower(canonical_id)=lower(?) OR lower(requisition_id)=lower(?)))
    ORDER BY id LIMIT 3`).bind(job.id, job.url, job.company, requisition, requisition)
    .all<{status:string|null;source_job_id:string|null;canonical_id:string|null;
      posting_url:string|null}>()).results;
}

function ambiguousKnownApplication(rows: Awaited<ReturnType<typeof knownApplications>>,
  job: NormalizedJob): boolean {
  return rows.length > 1 || rows.some(row => row.posting_url !== null &&
    row.posting_url !== job.url && row.canonical_id !== job.id);
}

function aliasProof(job: NormalizedJob,
  proof?: Extract<ResolutionResult, {kind:"resolved"}>): {
    aliases:string[];employerKey:string;requisitionId:string;sourceUrl:string}|null {
  if (!proof) return null;
  if (proof.posting.jobId !== job.id) throw new Error("Manual alias proof has another job identity");
  const evidence = proof.evidence.find(item => item.employerKey && item.requisitionId &&
    proof.aliases.includes(observedUrl(item.url) ?? ""));
  if (!evidence?.employerKey || !evidence.requisitionId) return null;
  const sourceUrl = observedUrl(evidence.url);
  if (!sourceUrl || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(evidence.employerKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(evidence.requisitionId) ||
    (proof.posting.kind === "employer" &&
      (proof.posting.employerKey !== evidence.employerKey ||
        proof.posting.requisitionId.toLowerCase() !== evidence.requisitionId.toLowerCase())))
    throw new Error("Manual alias proof is invalid");
  const aliases = [...new Set(proof.aliases.map(alias => observedUrl(alias)))];
  if (aliases.some(alias => !alias) || aliases.length === 0 || aliases.length > 16)
    throw new Error("Manual alias proof has invalid aliases");
  return { aliases: aliases as string[], employerKey: evidence.employerKey,
    requisitionId: evidence.requisitionId, sourceUrl };
}

async function setExistingRequest(db: D1Database, requestId: string, generation: number,
  jobId: string, ownerRequestId: string | null, state: "already_tracked" | "held",
  failureCode: string | null, at: string): Promise<void> {
  await db.prepare(`UPDATE manual_intake_requests SET state=?,stage='save',job_id=?,
    owner_request_id=?,failure_code=?,updated_at=?
    WHERE id=? AND workflow_generation=? AND state<>'delivered'`)
    .bind(state, jobId, ownerRequestId, failureCode, at, requestId, generation).run();
}

export async function holdProvisionalAliasConflict(db: D1Database, requestId: string,
  generation: number, jobId: string, at: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE manual_intake_requests SET state='held',stage='save',
    failure_code='alias_conflict',failure_detail='A proven alias has another owner',updated_at=?
    WHERE id=? AND workflow_generation=? AND job_id=? AND state='already_tracked'`)
    .bind(at, requestId, generation, jobId).run();
  return result.meta.changes === 1;
}

export async function claimAndSaveJob(db: D1Database, requestId: string, generation: number,
  job: NormalizedJob, at: string,
  proof?: Extract<ResolutionResult, {kind:"resolved"}>, criteriaVersion?: string): Promise<JobClaimResult> {
  if (!/^[a-f0-9]{64}$/.test(requestId) || !Number.isSafeInteger(generation) || generation < 0 ||
    !job.id || !job.company || !job.title || !validUrl(job.url) ||
    !Number.isFinite(Date.parse(at))) throw new Error("Invalid manual job claim");
  const request = await readIntake(db, requestId);
  if (!request) throw new Error("Manual intake request is missing");
  if (request.workflowGeneration !== generation) throw new Error("Stale manual intake generation");
  const owned = await db.prepare("SELECT owner_request_id FROM manual_intake_jobs WHERE job_id=?")
    .bind(job.id).first<{owner_request_id:string}>();
  if (owned?.owner_request_id === requestId) {
    const saved = await existingJob(db, job.id);
    if (!saved) throw new Error("Manual job ownership has no saved job");
    const stored = await db.prepare("SELECT posting_json FROM manual_intake_requests WHERE id=?")
      .bind(requestId).first<{posting_json:string|null}>();
    if (stored?.posting_json && stored.posting_json !== JSON.stringify(job)) {
      await setExistingRequest(db, requestId, generation, job.id, requestId,
        "held", "posting_changed", at);
      return { kind: "held", reason: "posting_changed" };
    }
    await db.prepare(`UPDATE manual_intake_requests SET
      state=CASE WHEN advisory_json IS NULL THEN 'saved' ELSE 'ready' END,
      stage=CASE WHEN advisory_json IS NULL THEN 'screen' ELSE 'deliver' END,
      failure_code=NULL,failure_detail=NULL,next_attempt_at=0,updated_at=?
      WHERE id=? AND workflow_generation=? AND job_id=? AND owner_request_id=?
        AND state IN ('fetching','retry_wait')`)
      .bind(at, requestId, generation, job.id, requestId).run();
    return { kind: "owned", requestId, jobId: job.id };
  }
  if (owned) {
    await setExistingRequest(db, requestId, generation, job.id, owned.owner_request_id,
      "already_tracked", null, at);
    return { kind: "joined", jobId: job.id, ownerRequestId: owned.owner_request_id };
  }
  const existing = await existingJob(db, job.id);
  if (existing) {
    await setExistingRequest(db, requestId, generation, job.id, null, "already_tracked", null, at);
    return { kind: "existing", jobId: job.id,
      applicationStatus: existing.application_status, notifiedAt: existing.notified_at };
  }
  const known = await knownApplications(db, job);
  if (ambiguousKnownApplication(known, job)) {
    await setExistingRequest(db, requestId, generation, job.id, null,
      "held", "ambiguous_application_identity", at);
    return { kind: "held", reason: "ambiguous_application_identity" };
  }
  if (known.length === 1) {
    await setExistingRequest(db, requestId, generation, job.id, null, "already_tracked", null, at);
    return { kind: "known_application", jobId: job.id,
      status: known[0].status, sourceJobId: known[0].source_job_id };
  }
  const proven = aliasProof(job, proof);
  const aliasGate = proven ? ` AND NOT EXISTS (SELECT 1 FROM discovery_job_owners
      WHERE employer_key=? AND requisition_key=?)
      AND NOT EXISTS (SELECT 1 FROM discovery_job_aliases
        WHERE alias IN (${proven.aliases.map(() => "?").join(",")}))` : "";
  const requisition = decodeURIComponent(job.id.split(":").at(-1) ?? "");
  const claim = db.prepare(`INSERT INTO manual_intake_jobs (job_id,owner_request_id,created_at)
    SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM manual_intake_requests
      WHERE id=? AND workflow_generation=? AND state IN ('accepted','resolving','fetching','saved'))
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=?)
      AND NOT EXISTS (SELECT 1 FROM known_applications WHERE canonical_id=? OR posting_url=? OR
        (lower(trim(COALESCE(employer,'')))=lower(trim(?)) AND
          (lower(canonical_id)=lower(?) OR lower(requisition_id)=lower(?))))${aliasGate}
    ON CONFLICT(job_id) DO NOTHING`)
    .bind(job.id, requestId, at, requestId, generation, job.id, job.id, job.url,
      job.company, requisition, requisition,
      ...(proven ? [proven.employerKey, proven.requisitionId.toLowerCase(), ...proven.aliases] : []));
  const insert = db.prepare(`INSERT INTO jobs
    (id,company,title,url,location,department,is_remote,employment_type,posted_at,
      compensation,first_seen_at,last_seen_at,is_known_application,known_application_source,
      match,notified_at,application_status,application_status_source,application_status_updated_at,
      discovery_source,criteria_version)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,'needs_materials','manual',?,
      'manual_add',? WHERE EXISTS (SELECT 1 FROM manual_intake_jobs
        WHERE job_id=? AND owner_request_id=?) AND EXISTS (SELECT 1 FROM manual_intake_requests
        WHERE id=? AND workflow_generation=?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(job.id, job.company, job.title, job.url, job.location, job.department,
      job.isRemote === null ? null : job.isRemote ? 1 : 0, job.employmentType,
      job.postedAt, job.compensation, at, at, at, criteriaVersion ?? null, job.id, requestId, requestId, generation);
  const update = db.prepare(`UPDATE manual_intake_requests SET state='saved',stage='screen',
    job_id=?,owner_request_id=?,posting_json=?,failure_code=NULL,failure_detail=NULL,updated_at=?
    WHERE id=? AND workflow_generation=? AND EXISTS (SELECT 1 FROM manual_intake_jobs
      WHERE job_id=? AND owner_request_id=?) AND EXISTS (SELECT 1 FROM jobs WHERE id=?)`)
    .bind(job.id, requestId, JSON.stringify(job), at, requestId, generation,
      job.id, requestId, job.id);
  const aliasWrites = proven ? [
    db.prepare(`INSERT INTO discovery_job_owners
      (employer_key,requisition_key,requisition_id,owner_job_id)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM manual_intake_jobs
        WHERE job_id=? AND owner_request_id=?)`)
      .bind(proven.employerKey, proven.requisitionId.toLowerCase(), proven.requisitionId,
        job.id, job.id, requestId),
    ...proven.aliases.map(alias => db.prepare(`INSERT INTO discovery_job_aliases
      (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM manual_intake_jobs
        WHERE job_id=? AND owner_request_id=?)`)
      .bind(alias, job.id, proven.employerKey, proven.requisitionId, proven.sourceUrl,
        at, job.id, requestId)),
  ] : [];
  await db.batch([claim, insert, ...aliasWrites, update]);
  const finalRequest = await readIntake(db, requestId);
  if (finalRequest?.workflowGeneration !== generation) throw new Error("Stale manual intake generation");
  const owner = await db.prepare("SELECT owner_request_id FROM manual_intake_jobs WHERE job_id=?")
    .bind(job.id).first<{owner_request_id:string}>();
  if (owner?.owner_request_id === requestId && await existingJob(db, job.id)) {
    return { kind: "owned", requestId, jobId: job.id };
  }
  if (owner) {
    await setExistingRequest(db, requestId, generation, job.id, owner.owner_request_id,
      "already_tracked", null, at);
    return { kind: "joined", jobId: job.id, ownerRequestId: owner.owner_request_id };
  }
  const raced = await existingJob(db, job.id);
  if (raced) {
    await setExistingRequest(db, requestId, generation, job.id, null, "already_tracked", null, at);
    return { kind: "existing", jobId: job.id,
      applicationStatus: raced.application_status, notifiedAt: raced.notified_at };
  }
  const racedKnown = await knownApplications(db, job);
  if (ambiguousKnownApplication(racedKnown, job)) {
    await setExistingRequest(db, requestId, generation, job.id, null,
      "held", "ambiguous_application_identity", at);
    return { kind: "held", reason: "ambiguous_application_identity" };
  }
  if (racedKnown.length === 1) {
    await setExistingRequest(db, requestId, generation, job.id, null, "already_tracked", null, at);
    return { kind: "known_application", jobId: job.id,
      status: racedKnown[0].status, sourceJobId: racedKnown[0].source_job_id };
  }
  if (proven) {
    const owner = await db.prepare(`SELECT owner_job_id FROM discovery_job_owners
      WHERE employer_key=? AND requisition_key=?`)
      .bind(proven.employerKey, proven.requisitionId.toLowerCase())
      .first<{owner_job_id:string}>();
    const aliases = await db.prepare(`SELECT owner_job_id FROM discovery_job_aliases
      WHERE alias IN (${proven.aliases.map(() => "?").join(",")})`)
      .bind(...proven.aliases).all<{owner_job_id:string}>();
    if (owner || aliases.results.length) {
      await setExistingRequest(db, requestId, generation, job.id, null,
        "held", "alias_conflict", at);
      return { kind: "held", reason: "alias_conflict" };
    }
  }
  throw new Error("Manual job claim did not persist");
}
