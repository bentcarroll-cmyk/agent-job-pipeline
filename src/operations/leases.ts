export type DiscoveryPipeline = "fixed_boards" | "unbounded_discovery";
export type DiscoveryLease = { pipeline: DiscoveryPipeline; owner: string; fence: number };

// Greater than the longest discovery step attempt (10 minutes). Renewal is
// per executing callback, so a multi-hour run does not need a multi-hour lock.
const LEASE_MS = 20 * 60_000;
const DB_NOW = "(unixepoch('now') * 1000)";

export class LeaseLostError extends Error {
  constructor() { super("Discovery run lease lost; this instance must stop"); this.name = "LeaseLostError"; }
}

export async function acquireLease(db: D1Database, pipeline: DiscoveryPipeline, owner: string): Promise<DiscoveryLease | null> {
  return db.prepare(`INSERT INTO discovery_run_leases (pipeline, owner, fence, expires_at)
    VALUES (?, ?, 1, ${DB_NOW} + ?)
    ON CONFLICT(pipeline) DO UPDATE SET
      owner = excluded.owner,
      fence = CASE WHEN discovery_run_leases.owner = excluded.owner AND discovery_run_leases.expires_at > ${DB_NOW}
                   THEN discovery_run_leases.fence ELSE discovery_run_leases.fence + 1 END,
      expires_at = excluded.expires_at
    WHERE discovery_run_leases.expires_at <= ${DB_NOW} OR discovery_run_leases.owner = excluded.owner
    RETURNING pipeline, owner, fence`).bind(pipeline, owner, LEASE_MS).first<DiscoveryLease>();
}

export async function activeRunId(db: D1Database, pipeline: DiscoveryPipeline): Promise<string | null> {
  const row = await db.prepare(`SELECT owner FROM discovery_run_leases WHERE pipeline = ? AND expires_at > ${DB_NOW}`)
    .bind(pipeline).first<{ owner: string }>();
  return row?.owner ?? null;
}

export async function renewLease(db: D1Database, lease: DiscoveryLease): Promise<void> {
  const result = await db.prepare(`UPDATE discovery_run_leases SET expires_at = ${DB_NOW} + ?
    WHERE pipeline = ? AND owner = ? AND fence = ? AND expires_at > ${DB_NOW}`)
    .bind(LEASE_MS, lease.pipeline, lease.owner, lease.fence).run();
  if (result.meta.changes !== 1) throw new LeaseLostError();
}

export async function releaseLease(db: D1Database, lease: DiscoveryLease): Promise<void> {
  // Retain the row so fencing epochs never reset. An old finalizer cannot
  // release a replacement owner's claim.
  await db.prepare("UPDATE discovery_run_leases SET expires_at = 0 WHERE pipeline = ? AND owner = ? AND fence = ?")
    .bind(lease.pipeline, lease.owner, lease.fence).run();
}

export async function fencedBatch(db: D1Database, lease: DiscoveryLease | undefined, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  if (!lease) return db.batch(statements);
  // D1 batch is transactional. A missing, expired or superseded lease makes
  // the scalar subquery NULL and violates expires_at NOT NULL, aborting the
  // ENTIRE batch. A valid assertion preserves the current expiry. Checking
  // ownership in a separate query would allow takeover between check/write.
  const assertion = db.prepare(`INSERT INTO discovery_run_leases (pipeline, owner, fence, expires_at)
    VALUES (?, ?, ?, (SELECT expires_at FROM discovery_run_leases
      WHERE pipeline = ? AND owner = ? AND fence = ? AND expires_at > ${DB_NOW}))
    ON CONFLICT(pipeline) DO UPDATE SET expires_at = excluded.expires_at`)
    .bind(lease.pipeline, lease.owner, lease.fence, lease.pipeline, lease.owner, lease.fence);
  try { return (await db.batch([assertion, ...statements])).slice(1); }
  catch (error) {
    if (String(error).includes("NOT NULL constraint failed: discovery_run_leases.expires_at")) throw new LeaseLostError();
    throw error;
  }
}
