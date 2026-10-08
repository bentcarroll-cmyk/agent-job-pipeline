import { isActiveCriteria } from "../config/run-context";
import type { NormalizedJob } from "../sources";
import type { ManualCard, SendOutcome } from "./types";
type AdvisoryRecord = { verdict: ManualCard["verdict"]; failure: string | null };

function when(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Invalid manual delivery time");
  return ms;
}

function requisitionFromJobId(id: string): string {
  try { return decodeURIComponent(id.split(":").at(-1) ?? ""); }
  catch { return ""; }
}

export async function readManualCardForDelivery(db: D1Database, deliveryId: string,
  generation: number): Promise<ManualCard | null> {
  const row = await db.prepare(`SELECT r.id,r.user_id,r.created_at,r.posting_json,
    r.advisory_json,d.job_id FROM manual_intake_deliveries d
    JOIN manual_intake_requests r ON r.id=d.request_id
    WHERE d.id=? AND d.state='sending' AND d.claim_generation=?
      AND r.workflow_generation=? AND r.state='delivering'`)
    .bind(deliveryId, generation, generation).first<{id:string;user_id:string;
      created_at:string;posting_json:string|null;advisory_json:string|null;job_id:string}>();
  if (!row?.posting_json) return null;
  let job: NormalizedJob;
  try { job = JSON.parse(row.posting_json) as NormalizedJob; }
  catch { return null; }
  if (job.id !== row.job_id) return null;
  let advisory: AdvisoryRecord | null = null;
  try { advisory = row.advisory_json ? JSON.parse(row.advisory_json) as AdvisoryRecord : null; }
  catch { return null; }
  return { requestId: row.id, job, userId: row.user_id, selectedAt: row.created_at,
    verdict: advisory?.verdict ?? null, advisoryError: advisory?.failure ?? null };
}

export async function isManualDeliveryCurrent(db: D1Database, deliveryId: string,
  generation: number, instanceId?: string, expectedVersion?: string): Promise<boolean> {
  if (!instanceId || typeof expectedVersion !== "string" || !expectedVersion) return false;
  const requisition = requisitionFromJobId(deliveryId.slice("manual:".length));
  const row = await db.prepare(`SELECT d.id FROM manual_intake_deliveries d
    JOIN manual_intake_requests r ON r.id=d.request_id
    JOIN manual_intake_jobs m ON m.job_id=d.job_id AND m.owner_request_id=r.id
    JOIN jobs j ON j.id=d.job_id
    WHERE d.id=? AND d.state='sending' AND d.claim_generation=?
      AND r.workflow_generation=? AND r.state='delivering' AND r.job_id=d.job_id
      AND j.application_status='needs_materials' AND j.application_status_source='manual'
      AND j.discovery_source='manual_add'
      AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
      AND json_extract(r.advisory_json,'$.criteriaVersion')=j.criteria_version
      AND j.criteria_version=?
      AND NOT EXISTS (SELECT 1 FROM known_applications k
        WHERE k.canonical_id=j.id OR k.posting_url=j.url OR
          (lower(trim(COALESCE(k.employer,'')))=lower(trim(j.company)) AND
            (lower(k.canonical_id)=lower(?) OR lower(k.requisition_id)=lower(?))))`)
    .bind(deliveryId, generation, generation, instanceId, expectedVersion, requisition, requisition).first();
  return !!row;
}

export async function claimManualDelivery(db: D1Database, requestId: string,
  generation: number, at: string, instanceId?: string): Promise<{deliveryId:string;card:ManualCard}|null> {
  const nowMs = when(at);
  const request = await db.prepare(`SELECT r.id,r.job_id,r.user_id,r.created_at,r.posting_json,
    r.advisory_json,r.state,r.workflow_generation,
    j.criteria_version,j.url AS job_url,j.company AS job_company,j.application_status,j.application_status_source,j.discovery_source,
    m.owner_request_id FROM manual_intake_requests r
    LEFT JOIN jobs j ON j.id=r.job_id
    LEFT JOIN manual_intake_jobs m ON m.job_id=r.job_id WHERE r.id=?`)
    .bind(requestId).first<{id:string;job_id:string|null;user_id:string;created_at:string;
      posting_json:string|null;advisory_json:string|null;state:string;workflow_generation:number;
      criteria_version:string|null;job_url:string|null;job_company:string|null;application_status:string|null;application_status_source:string|null;
      discovery_source:string|null;owner_request_id:string|null}>();
  if (!request || request.workflow_generation !== generation || !request.job_id ||
    !["ready", "retry_wait"].includes(request.state)) return null;
  let advisoryVersion: string | null = null;
  try { advisoryVersion = JSON.parse(request.advisory_json ?? "null")?.criteriaVersion ?? null; }
  catch { /* Unknown/malformed provenance remains stale. */ }
  if (!instanceId || advisoryVersion !== request.criteria_version ||
    !await isActiveCriteria(db, instanceId, advisoryVersion)) {
    await db.prepare(`UPDATE manual_intake_requests SET state='held',stage='deliver',
      failure_code='criteria_changed',updated_at=? WHERE id=? AND workflow_generation=?
      AND state IN ('ready','retry_wait')`).bind(at, requestId, generation).run();
    return null;
  }
  const requisition = requisitionFromJobId(request.job_id);
  const known = await db.prepare(`SELECT canonical_id,posting_url FROM known_applications
    WHERE canonical_id=? OR posting_url=? OR
      (lower(trim(COALESCE(employer,'')))=lower(trim(?)) AND
        (lower(canonical_id)=lower(?) OR lower(requisition_id)=lower(?))) LIMIT 2`)
    .bind(request.job_id, request.job_url, request.job_company,
      requisition, requisition).all<{canonical_id:string|null;posting_url:string|null}>();
  const ambiguous = known.results.length > 1 || known.results.some(row =>
    row.posting_url !== null && row.posting_url !== request.job_url &&
    row.canonical_id !== request.job_id);
  const valid = request.owner_request_id === requestId &&
    request.application_status === "needs_materials" &&
    request.application_status_source === "manual" &&
    request.discovery_source === "manual_add" &&
    known.results.length === 0;
  if (!valid) {
    await db.prepare(`UPDATE manual_intake_requests SET state=?,stage='deliver',
      failure_code=?,updated_at=? WHERE id=? AND workflow_generation=?
      AND state IN ('ready','retry_wait')`).bind(ambiguous ? "held" : "already_tracked",
        ambiguous ? "ambiguous_application_identity" : "status_changed",
        at, requestId, generation).run();
    return null;
  }
  let job: NormalizedJob | null = null;
  try { job = request.posting_json ? JSON.parse(request.posting_json) as NormalizedJob : null; }
  catch { /* Hold malformed persisted posting below. */ }
  if (!job || job.id !== request.job_id || !job.url) {
    await db.prepare(`UPDATE manual_intake_requests SET state='held',stage='deliver',
      failure_code='posting_unavailable',updated_at=? WHERE id=? AND workflow_generation=?
      AND state IN ('ready','retry_wait')`).bind(at, requestId, generation).run();
    return null;
  }
  const deliveryId = `manual:${job.id}`;
  const batch = await db.batch([
    db.prepare(`INSERT INTO manual_intake_deliveries
      (id,request_id,job_id,state,updated_at)
      SELECT ?,r.id,r.job_id,'pending',? FROM manual_intake_requests r
      JOIN manual_intake_jobs m ON m.job_id=r.job_id AND m.owner_request_id=r.id
      JOIN jobs j ON j.id=r.job_id
      WHERE r.id=? AND r.workflow_generation=? AND r.state='ready'
        AND j.application_status='needs_materials' AND j.application_status_source='manual'
        AND j.discovery_source='manual_add'
        AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
        AND json_extract(r.advisory_json,'$.criteriaVersion')=j.criteria_version
        AND NOT EXISTS (SELECT 1 FROM known_applications k
          WHERE k.canonical_id=j.id OR k.posting_url=j.url OR
            (lower(trim(COALESCE(k.employer,'')))=lower(trim(j.company)) AND
              (lower(k.canonical_id)=lower(?) OR lower(k.requisition_id)=lower(?))))
      ON CONFLICT(id) DO NOTHING`).bind(deliveryId, at, requestId, generation,
        instanceId ?? null, requisition, requisition),
    db.prepare(`UPDATE manual_intake_deliveries SET state='sending',attempt=attempt+1,
      claim_generation=?,attempted_at=?,updated_at=?,failure_code=NULL,
      attempts_json=json_insert(attempts_json,'$[#]',json_object(
        'attempt',attempt+1,'at',?,'phase','started','code',NULL,
        'channelId',NULL,'messageTs',NULL,'authorizationReason',NULL))
      WHERE id=? AND state IN ('pending','retry_wait') AND next_attempt_at<=?
        AND attempt<5 AND EXISTS (SELECT 1 FROM manual_intake_requests r
          JOIN manual_intake_jobs m ON m.job_id=r.job_id AND m.owner_request_id=r.id
          JOIN jobs j ON j.id=r.job_id
          WHERE r.id=? AND r.workflow_generation=? AND r.job_id=manual_intake_deliveries.job_id
            AND r.state IN ('ready','retry_wait')
            AND j.application_status='needs_materials' AND j.application_status_source='manual'
            AND j.discovery_source='manual_add'
            AND j.criteria_version=(SELECT criteria_version FROM candidate_active_configs WHERE instance_id=?)
            AND json_extract(r.advisory_json,'$.criteriaVersion')=j.criteria_version
            AND NOT EXISTS (SELECT 1 FROM known_applications k
              WHERE k.canonical_id=j.id OR k.posting_url=j.url OR
                (lower(trim(COALESCE(k.employer,'')))=lower(trim(j.company)) AND
                  (lower(k.canonical_id)=lower(?) OR lower(k.requisition_id)=lower(?)))))`)
      .bind(generation, at, at, at, deliveryId, nowMs, requestId, generation,
        instanceId ?? null, requisition, requisition),
    db.prepare(`UPDATE manual_intake_requests SET state='delivering',stage='deliver',
      failure_code=NULL,next_attempt_at=0,updated_at=?
      WHERE id=? AND workflow_generation=? AND state IN ('ready','retry_wait')
        AND EXISTS (SELECT 1 FROM manual_intake_deliveries d
          WHERE d.request_id=? AND d.state='sending' AND d.claim_generation=?)`)
      .bind(at, requestId, generation, requestId, generation),
  ]);
  if (batch[1]?.meta.changes !== 1 || batch[2]?.meta.changes !== 1) {
    const stale = await db.prepare(`SELECT state,attempt FROM manual_intake_deliveries WHERE id=?`)
      .bind(deliveryId).first<{state:string;attempt:number}>();
    if (stale?.attempt && stale.attempt >= 5 && stale.state === "retry_wait") {
      await db.batch([
        db.prepare(`UPDATE manual_intake_deliveries SET state='held',
          failure_code='delivery_attempts_exhausted',updated_at=? WHERE id=? AND state='retry_wait'`)
          .bind(at, deliveryId),
        db.prepare(`UPDATE manual_intake_requests SET state='held',
          failure_code='delivery_attempts_exhausted',updated_at=?
          WHERE id=? AND workflow_generation=? AND state='retry_wait'`)
          .bind(at, requestId, generation),
      ]);
    }
    return null;
  }
  let advisory: AdvisoryRecord | null = null;
  try { advisory = request.advisory_json ? JSON.parse(request.advisory_json) as AdvisoryRecord : null; }
  catch { /* Sending claim is durable; expose unavailable advisory. */ }
  return { deliveryId, card: { requestId, job, verdict: advisory?.verdict ?? null,
    userId: request.user_id, selectedAt: request.created_at,
    advisoryError: advisory?.failure ?? null } };
}

export async function cancelManualDelivery(db: D1Database, deliveryId: string,
  generation: number, at: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE manual_intake_deliveries SET state='cancelled',
      failure_code='status_changed',updated_at=? WHERE id=? AND state='sending'
      AND claim_generation=?`).bind(at, deliveryId, generation),
    db.prepare(`UPDATE manual_intake_requests SET state='already_tracked',stage='deliver',
      failure_code='status_changed',updated_at=? WHERE id=(SELECT request_id
      FROM manual_intake_deliveries WHERE id=?) AND workflow_generation=?
      AND state='delivering' AND EXISTS (SELECT 1 FROM manual_intake_deliveries
        WHERE id=? AND state='cancelled')`).bind(at, deliveryId, generation, deliveryId),
  ]);
}

export async function finishManualDelivery(db: D1Database, deliveryId: string,
  generation: number, outcome: SendOutcome, at: string): Promise<void> {
  const nowMs = when(at);
  if (outcome.kind === "accepted" && (!outcome.receipt.channelId ||
    !/^\d+\.\d+$/.test(outcome.receipt.messageTs))) throw new Error("Invalid manual Slack receipt");
  const state = outcome.kind === "accepted" ? "delivered" :
    outcome.kind === "retryable_rejection" ? "retry_wait" :
      outcome.kind === "rejected" ? "held" : "unknown";
  const phase = outcome.kind === "accepted" ? "accepted" :
    outcome.kind === "unknown" ? "unknown" : "rejected";
  const reason = outcome.kind === "accepted" ? null : outcome.code;
  const next = outcome.kind === "retryable_rejection" ? nowMs + outcome.retryAfterMs : 0;
  const channel = outcome.kind === "accepted" ? outcome.receipt.channelId : null;
  const ts = outcome.kind === "accepted" ? outcome.receipt.messageTs : null;
  const requestState = outcome.kind === "unknown" ? "delivery_unknown" : state;
  await db.batch([
    db.prepare(`UPDATE manual_intake_deliveries SET state=?,channel_id=?,message_ts=?,
      failure_code=?,next_attempt_at=?,updated_at=?,
      attempts_json=json_insert(attempts_json,'$[#]',json_object(
        'attempt',attempt,'at',?,'phase',?,'code',?,
        'channelId',?,'messageTs',?,'authorizationReason',NULL))
      WHERE id=? AND state='sending' AND claim_generation=?`)
      .bind(state, channel, ts, reason, next, at, at, phase, reason,
        channel, ts, deliveryId, generation),
    db.prepare(`UPDATE manual_intake_requests SET state=?,stage='deliver',
      failure_code=?,next_attempt_at=?,updated_at=?
      WHERE id=(SELECT request_id FROM manual_intake_deliveries WHERE id=?)
        AND workflow_generation=? AND state='delivering'
        AND EXISTS (SELECT 1 FROM manual_intake_deliveries
          WHERE id=? AND state=? AND claim_generation=?)`)
      .bind(requestState, reason, next, at, deliveryId, generation,
        deliveryId, state, generation),
    db.prepare(`UPDATE jobs SET notified_at=COALESCE(notified_at,?)
      WHERE id=(SELECT job_id FROM manual_intake_deliveries WHERE id=?)
        AND EXISTS (SELECT 1 FROM manual_intake_deliveries d
          JOIN manual_intake_requests r ON r.id=d.request_id
          WHERE d.id=? AND d.state='delivered' AND d.claim_generation=?
            AND r.state='delivered' AND r.workflow_generation=?)`)
      .bind(at, deliveryId, deliveryId, generation, generation),
  ]);
}

export type VerifiedManualReceipt = { requestId:string;jobId:string;channelId:string;
  messageTs:string;observedMarker:string;verificationNote:string;at:string };

// The caller must independently inspect the Slack message's marker, job
// button, channel and timestamp. This function checks that attestation
// against the durable request; it does not claim Slack history access.
export async function recordVerifiedManualReceipt(db: D1Database,
  input: VerifiedManualReceipt): Promise<boolean> {
  when(input.at);
  if (!/^[a-f0-9]{64}$/.test(input.requestId) || !input.jobId ||
    input.observedMarker !== `manual_intake_${input.requestId}` ||
    !/^[A-Z0-9]{2,32}$/.test(input.channelId) ||
    !/^\d+\.\d+$/.test(input.messageTs) ||
    input.verificationNote.length < 10 || input.verificationNote.length > 200) {
    throw new Error("Verified manual receipt requires exact message evidence");
  }
  const deliveryId = `manual:${input.jobId}`;
  const updates = await db.batch([
    db.prepare(`UPDATE manual_intake_deliveries SET state='delivered',
      channel_id=?,message_ts=?,failure_code=NULL,updated_at=?,
      attempts_json=json_insert(attempts_json,'$[#]',json_object(
        'attempt',attempt,'at',?,'phase','accepted','code','operator_verified',
        'channelId',?,'messageTs',?,'authorizationReason',?))
      WHERE id=? AND request_id=? AND job_id=? AND state='unknown'
        AND EXISTS (SELECT 1 FROM manual_intake_requests r
          WHERE r.id=? AND r.job_id=? AND r.state='delivery_unknown')`)
      .bind(input.channelId, input.messageTs, input.at, input.at,
        input.channelId, input.messageTs, input.verificationNote,
        deliveryId, input.requestId, input.jobId, input.requestId, input.jobId),
    db.prepare(`UPDATE manual_intake_requests SET state='delivered',
      failure_code=NULL,updated_at=? WHERE id=? AND job_id=?
        AND state='delivery_unknown' AND EXISTS
        (SELECT 1 FROM manual_intake_deliveries d WHERE d.id=?
          AND d.state='delivered' AND d.channel_id=? AND d.message_ts=?)`)
      .bind(input.at, input.requestId, input.jobId, deliveryId,
        input.channelId, input.messageTs),
    db.prepare(`UPDATE jobs SET notified_at=COALESCE(notified_at,?)
      WHERE id=? AND EXISTS (SELECT 1 FROM manual_intake_requests r
        JOIN manual_intake_deliveries d ON d.request_id=r.id
        WHERE r.id=? AND r.state='delivered' AND d.id=? AND d.state='delivered'
          AND d.channel_id=? AND d.message_ts=?)`)
      .bind(input.at, input.jobId, input.requestId, deliveryId,
        input.channelId, input.messageTs),
  ]);
  return updates[0]?.meta.changes === 1 && updates[1]?.meta.changes === 1;
}
