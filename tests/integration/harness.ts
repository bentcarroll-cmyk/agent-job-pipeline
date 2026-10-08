import { Miniflare } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createDatabase() {
  const root = await mkdtemp(join(tmpdir(), "job-search-d1-"));
  const mf = new Miniflare({
    host: "127.0.0.1", port: 0, cf: false, logRequests: false, telemetry: { enabled: false },
    resourcePersistencePath: join(root, "storage"), resourceTmpPath: join(root, "tmp"),
    workers: [{ config: {
      type: "worker", name: "test", compatibilityDate: "2026-09-01",
      manifest: { mainModule: "index.mjs", modulesRoot: root, modules: { "index.mjs": {
        type: "esm", contents: 'export default { fetch() { return new Response("local test"); } };',
      } } },
      env: { DB: { type: "d1", id: "test" } }, exports: {},
    }, dev: { rootPath: root, unsafeRegisterWorker: false } }],
  });
  const dispose = async () => { try { await mf.dispose(); } finally { await rm(root, { recursive: true, force: true }); } };
  try { return { db: await mf.getD1Database("DB", "test") as unknown as D1Database, dispose }; }
  catch (error) { await dispose(); throw error; }
}

export async function loadSchema(db: D1Database, variant: "root" | "fixed-baseline-migration" | "candidate-config-migration" | "pre-lifecycle" | "lifecycle-migration" | "discovery-controls-migration" | "discovery-coverage-migration" | "discovery-query-migration" | "discovery-alias-migration" | "discovery-candidates-migration" | "discovery-fixed-candidates-migration" | "durable-manual-intake-migration" | "release-receipts-migration" | "radar-migration") {
  const paths = { "fixed-baseline-migration": "../../schema.fixed-baseline-migration.sql", "candidate-config-migration": "../../schema.candidate-config-migration.sql", "release-receipts-migration": "../../schema.release-receipts-migration.sql", root: "../../schema.sql", "pre-lifecycle": "./fixtures/pre-lifecycle.sql", "lifecycle-migration": "../../schema.lifecycle-migration.sql", "discovery-controls-migration": "../../schema.discovery-controls-migration.sql", "discovery-coverage-migration": "../../schema.discovery-coverage-migration.sql", "discovery-query-migration": "../../schema.discovery-query-migration.sql", "discovery-alias-migration": "../../schema.discovery-alias-migration.sql", "discovery-candidates-migration": "../../schema.discovery-candidates-migration.sql", "discovery-fixed-candidates-migration": "../../schema.discovery-fixed-candidates-migration.sql", "durable-manual-intake-migration": "../../schema.durable-manual-intake-migration.sql", "radar-migration": "../../schema.radar-migration.sql" };
  const sql = await readFile(new URL(paths[variant], import.meta.url), "utf8");
  // Only the checked-in simple DDL: no triggers, block comments or quoted
  // semicolons. Use a SQL parser if future migrations need those constructs.
  const statements = sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
  await db.batch(statements.map(s => db.prepare(s)));
}

export async function loadFixture(db: D1Database, name: "mixed-history") {
  if (name !== "mixed-history") throw new Error(`Unknown fixture ${name}`);
  await db.batch([
    db.prepare("INSERT INTO known_applications (id, employer, title, status, source, source_job_id) VALUES (1,'Fixture Co','AI Operations','applied','codex_pipeline','FIXTURE-1'), (2,'Prepared Co','Strategy','packet_ready','codex_pipeline','FIXTURE-2')"),
    db.prepare("INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,is_known_application,known_application_source,application_status) VALUES ('mirror','Fixture Co','AI Operations','https://example.test/1','2026-09-21','2026-09-21',1,'FIXTURE-1','applied'), ('prepared','Prepared Co','AI Adoption','https://example.test/2','2026-09-21','2026-09-21',0,NULL,'materials_ready'), ('unreviewed','Other Co','AI Ops','https://example.test/3','2026-09-21','2026-09-21',0,NULL,'not_applied')"),
  ]);
}
