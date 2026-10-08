import { summarizeRun } from "../discovery/coverage";
import { missingRetryContext, readCandidateInventory } from "../discovery/candidates";
import type { DiscoveryLease } from "./leases";

// Operational fields are read at the response time. Retry and pending-delivery
// age can change after a historical run; the frozen run funnel remains separate.
export async function readDiscoveryReport(db: D1Database, runId: string, offset = 0, limit = 100) {
  if (!runId || runId.length > 200 || !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid discovery report request");
  const funnel = await summarizeRun(db, runId);
  const [run, pages, holds, holdCount, retries, delivery, resolutions, health] = await db.batch([
    db.prepare(`SELECT run_id,pipeline,code_version,query_version,registry_version,started_at,finished_at,status
      FROM discovery_runs WHERE run_id=?`).bind(runId),
    db.prepare(`SELECT query_id,page,status,raw_hits,http_status,error_code,stopped_by,started_at,finished_at
      FROM discovery_query_pages WHERE run_id=? ORDER BY query_id,page`).bind(runId),
    db.prepare(`SELECT query_id,page,ordinal,normalized_url,outcome,reason_code
      FROM discovery_url_observations WHERE run_id=? AND outcome IN ('held','unsupported')
      ORDER BY query_id,page,ordinal LIMIT ? OFFSET ?`).bind(runId, limit, offset),
    db.prepare(`SELECT count(*) AS n FROM discovery_url_observations
      WHERE run_id=? AND outcome IN ('held','unsupported')`).bind(runId),
    db.prepare(`SELECT stage,count(*) AS count,
      sum(CASE WHEN next_attempt_at<=? THEN 1 ELSE 0 END) AS due,
      min(failed_at) AS oldest_failed_at,
      min(next_attempt_at) AS earliest_next_attempt_at
      FROM discovery_retries WHERE pipeline=(SELECT pipeline FROM discovery_runs WHERE run_id=?)
      GROUP BY stage ORDER BY stage`).bind(Date.now(), runId),
    db.prepare(`SELECT count(*) AS pending_count,min(j.first_seen_at) AS oldest_first_seen_at
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
    db.prepare(`SELECT intent_id,outcome,reason_code,observed_at
      FROM discovery_run_delivery_resolutions WHERE run_id=? ORDER BY intent_id`).bind(runId),
    db.prepare(`SELECT fingerprint,state,first_run_id,last_run_id,first_seen_at,last_seen_at,report_needed
      FROM discovery_health_incidents WHERE pipeline=(SELECT pipeline FROM discovery_runs WHERE run_id=?)
      ORDER BY last_seen_at DESC`).bind(runId),
  ]);
  const totalHolds = (holdCount.results[0] as { n: number }).n;
  let missingContext: Awaited<ReturnType<typeof missingRetryContext>> | null = null;
  let candidateQueue: Awaited<ReturnType<typeof readCandidateInventory>> | null = null;
  try {
    const row = run.results[0] as {pipeline:DiscoveryLease["pipeline"]} | undefined;
    if (row) {
      missingContext = await missingRetryContext(db, row.pipeline);
      candidateQueue = await readCandidateInventory(db, row.pipeline);
    }
  } catch (error) {
    if (!/no such table: discovery_candidates/i.test(String(error))) throw error;
  }
  return {
    observedAt: new Date().toISOString(),
    run: run.results[0], funnel,
    queryPages: pages.results,
    urlHolds: { rows: holds.results, total: totalHolds, offset,
      nextOffset: offset + holds.results.length < totalHolds ? offset + holds.results.length : null },
    currentRetries: retries.results,
    missingRetryContext: missingContext,
    currentCandidateQueue: candidateQueue,
    currentDeliveryBacklog: delivery.results[0],
    deliveryResolutions: resolutions.results,
    healthIntents: health.results,
    note: "Current retry and delivery inventory may differ from the frozen run funnel.",
  };
}
