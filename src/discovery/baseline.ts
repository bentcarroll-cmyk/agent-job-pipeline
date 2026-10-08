import type { Source } from "../sources";
import { fencedBatch, type DiscoveryLease } from "../operations/leases";
// Source objects have a bounded flat schema; canonicalize key and source order.
export function baselineSources(sources: readonly Source[]): string {
  return JSON.stringify(sources.map(source => JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a],[b]) => a.localeCompare(b))))).sort());
}
export async function hasFixedBaseline(db: D1Database, instanceId: string, sources: readonly Source[]): Promise<boolean> {
  return !!await db.prepare("SELECT completed_at FROM fixed_baselines WHERE instance_id=? AND sources_json=?")
    .bind(instanceId, baselineSources(sources)).first();
}
export async function completeFixedBaseline(db: D1Database, lease: DiscoveryLease, instanceId: string, sources: readonly Source[]): Promise<void> {
  await fencedBatch(db, lease, [db.prepare("INSERT INTO fixed_baselines (instance_id,sources_json,completed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
    .bind(instanceId, baselineSources(sources), new Date().toISOString())]);
}
