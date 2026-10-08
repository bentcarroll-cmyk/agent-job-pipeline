import { fencedBatch, type DiscoveryLease, type DiscoveryPipeline } from "./leases";

const BASE_DELAY = 6 * 3600_000;
const CHUNK = 50;

export async function recordFailure(db: D1Database, lease: DiscoveryLease, id: string, stage: "fetch" | "filter", error: string, at = Date.now(), extraStatements: D1PreparedStatement[] = []): Promise<void> {
  const trace = (phase: string) => {
    if (stage === "filter") console.log(JSON.stringify({ event: "screening_phase", runId: lease.owner,
      pipeline: lease.pipeline, fence: lease.fence, jobId: id, phase }));
  };
  trace("retry_write_start");
  try {
  await fencedBatch(db, lease, [db.prepare(`INSERT INTO discovery_retries
    (pipeline, job_id, stage, attempts, last_run_id, last_error, failed_at, next_attempt_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(pipeline, job_id) DO UPDATE SET
      stage = excluded.stage,
      attempts = discovery_retries.attempts + 1,
      last_run_id = excluded.last_run_id,
      last_error = excluded.last_error,
      failed_at = excluded.failed_at,
      next_attempt_at = excluded.failed_at + ? * (1 << MIN(discovery_retries.attempts, 3))
    WHERE discovery_retries.last_run_id <> excluded.last_run_id`)
    .bind(lease.pipeline, id, stage, lease.owner, error.slice(0, 1000), at, at + BASE_DELAY, BASE_DELAY), ...extraStatements]);
    trace("retry_write_ok");
  } catch (failure) {
    trace("retry_write_error");
    throw failure;
  }
}

export async function getCoolingDownIds(db: D1Database, pipeline: DiscoveryPipeline, ids: string[], at = Date.now()): Promise<Set<string>> {
  const cooling = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db.prepare(`SELECT job_id FROM discovery_retries
      WHERE pipeline = ? AND next_attempt_at > ? AND job_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(pipeline, at, ...chunk).all<{ job_id: string }>();
    for (const row of results) cooling.add(row.job_id);
  }
  return cooling;
}

export async function clearFailures(db: D1Database, lease: DiscoveryLease, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await fencedBatch(db, lease, [db.prepare(`DELETE FROM discovery_retries
      WHERE pipeline = ? AND job_id IN (${chunk.map(() => "?").join(",")})`).bind(lease.pipeline, ...chunk)]);
  }
}
