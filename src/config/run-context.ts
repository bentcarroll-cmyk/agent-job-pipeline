import { loadRuntimeConfig } from "./candidate";
import type { RuntimeConfig } from "./types";

async function checkedRuntime(runtime: RuntimeConfig): Promise<RuntimeConfig> {
  // Deliberately select only candidate data: an Env/provider/binding is never serialized.
  const checked = await loadRuntimeConfig(runtime.candidate);
  if (checked.criteriaVersion !== runtime.criteriaVersion) throw new Error("Runtime criteria version does not match approved candidate");
  return checked;
}

/** Admission is immutable and has no activation side effect, including on replay. */
export async function admitRunConfig(db: D1Database, runId: string, runtime: RuntimeConfig): Promise<RuntimeConfig> {
  if (!runId || runId.length > 256) throw new Error("Invalid candidate run identity");
  const checked = await checkedRuntime(runtime);
  await db.prepare(`INSERT INTO candidate_run_configs (run_id,criteria_version,config_json,admitted_at)
    VALUES (?,?,?,?) ON CONFLICT(run_id) DO NOTHING`)
    .bind(runId, checked.criteriaVersion, JSON.stringify(checked), new Date().toISOString()).run();
  const saved = await db.prepare("SELECT criteria_version,config_json FROM candidate_run_configs WHERE run_id=?")
    .bind(runId).first<{ criteria_version: string; config_json: string }>();
  if (!saved) throw new Error("Candidate run admission missing");
  const snapshot = await checkedRuntime(JSON.parse(saved.config_json) as RuntimeConfig);
  if (snapshot.criteriaVersion !== saved.criteria_version) throw new Error("Stored candidate run provenance is inconsistent");
  return snapshot;
}

/** In-memory projection guard. Delivery must ALSO check the separate active D1 version. */
export function isCurrentCriteria(evaluatedVersion: string, runtime: RuntimeConfig): boolean {
  return typeof evaluatedVersion === "string" && evaluatedVersion.length > 0 && evaluatedVersion === runtime.criteriaVersion;
}

export type ActiveCandidateConfig = { criteriaVersion: string; revision: number };
export async function readActiveCandidateConfig(db: D1Database, instanceId: string): Promise<ActiveCandidateConfig | null> {
  const row = await db.prepare("SELECT criteria_version,revision FROM candidate_active_configs WHERE instance_id=?")
    .bind(instanceId).first<{ criteria_version: string; revision: number }>();
  return row ? { criteriaVersion: row.criteria_version, revision: row.revision } : null;
}

/** Installer/operator-only activation. Never call from run admission or Worker replay.
 * The caller verifies the database belongs to this instance and presents the freshly
 * approved config. expectedRevision=null initializes an empty instance; updates
 * require the observed revision. Concurrent/stale activation fails closed, including
 * an ABA change back to the same hash. Re-read and obtain approval before retrying.
 */
export async function activateCandidateConfig(db: D1Database, instanceId: string, runtime: RuntimeConfig,
  expectedRevision: number | null): Promise<number> {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(instanceId)) throw new Error("Invalid instance identity");
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
    throw new Error("Activation requires a positive expected revision or null for initial activation");
  const checked = await checkedRuntime(runtime);
  const at = new Date().toISOString();
  const result = expectedRevision === null
    ? await db.prepare(`INSERT INTO candidate_active_configs (instance_id,criteria_version,revision,activated_at)
        VALUES (?,?,1,?) ON CONFLICT(instance_id) DO NOTHING`).bind(instanceId, checked.criteriaVersion, at).run()
    : await db.prepare(`UPDATE candidate_active_configs SET criteria_version=?,revision=revision+1,activated_at=?
        WHERE instance_id=? AND revision=?`).bind(checked.criteriaVersion, at, instanceId, expectedRevision).run();
  if (result.meta.changes !== 1) throw new Error("Active candidate revision changed; review current activation before retrying");
  return (expectedRevision ?? 0) + 1;
}

export async function isActiveCriteria(db: D1Database, instanceId: string, evaluatedVersion: string | null | undefined): Promise<boolean> {
  if (!evaluatedVersion) return false;
  return (await readActiveCandidateConfig(db, instanceId))?.criteriaVersion === evaluatedVersion;
}
