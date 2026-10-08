import type { DiscoveryPipeline } from "./leases";
import { closingDeliveryStatements } from "../discovery/coverage";

// Invoked at a scheduled entry. There is intentionally no independent
// missed-schedule watchdog: if no later schedule fires, reconciliation waits.
export async function reconcileIncompleteRuns(db: D1Database, pipeline: DiscoveryPipeline,
  workflow: Workflow, limit = 20): Promise<{ inspected: number; reconciled: number; unresolved: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid reconciliation limit");
  const { results } = await db.prepare(`SELECT run_id FROM discovery_runs
    WHERE pipeline=? AND status='running' ORDER BY COALESCE(last_checked_at,''),started_at,run_id LIMIT ?`)
    .bind(pipeline, limit).all<{run_id:string}>();
  let reconciled = 0, unresolved = 0;
  for (const { run_id: runId } of results) {
    let state: string;
    try { state = (await (await workflow.get(runId)).status()).status; }
    catch {
      await db.prepare(`UPDATE discovery_runs SET last_checked_at=? WHERE run_id=? AND status='running'`)
        .bind(new Date().toISOString(), runId).run();
      unresolved++; continue;
    }
    const terminal = state === "errored" ? { runStatus: "failed", fingerprint: "workflow_errored" }
      : state === "terminated" ? { runStatus: "interrupted", fingerprint: "workflow_terminated" }
      : state === "complete" ? { runStatus: "partial", fingerprint: "summary_missing" } : null;
    if (!terminal) {
      await db.prepare(`UPDATE discovery_runs SET last_checked_at=? WHERE run_id=? AND status='running'`)
        .bind(new Date().toISOString(), runId).run();
      unresolved++; continue;
    }
    const at = new Date().toISOString();
    await db.batch([
      ...closingDeliveryStatements(db, runId, at),
      db.prepare(`UPDATE discovery_runs SET status=?,finished_at=?,last_checked_at=?
        WHERE run_id=? AND pipeline=? AND status='running'`)
        .bind(terminal.runStatus, at, at, runId, pipeline),
      db.prepare(`INSERT INTO discovery_health_incidents
        (pipeline,fingerprint,state,first_run_id,last_run_id,first_seen_at,last_seen_at,report_needed)
        SELECT ?,?,'open',?,?,?,?,1
        WHERE EXISTS (SELECT 1 FROM discovery_runs WHERE run_id=? AND pipeline=? AND status=? AND finished_at=?)
        ON CONFLICT(pipeline,fingerprint) DO UPDATE SET
          state='open',
          first_run_id=CASE WHEN discovery_health_incidents.state='recovered' THEN excluded.first_run_id ELSE discovery_health_incidents.first_run_id END,
          first_seen_at=CASE WHEN discovery_health_incidents.state='recovered' THEN excluded.first_seen_at ELSE discovery_health_incidents.first_seen_at END,
          last_run_id=excluded.last_run_id,last_seen_at=excluded.last_seen_at,
          report_needed=CASE WHEN discovery_health_incidents.state='recovered' THEN 1 ELSE discovery_health_incidents.report_needed END`)
        .bind(pipeline, terminal.fingerprint, runId, runId, at, at,
          runId, pipeline, terminal.runStatus, at),
    ]);
    reconciled++;
  }
  return { inspected: results.length, reconciled, unresolved };
}
