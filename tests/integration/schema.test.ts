import { afterEach, expect, it } from "vitest";
import { createDatabase, loadSchema, loadFixture } from "./harness";

const active: Array<Awaited<ReturnType<typeof createDatabase>>> = [];
afterEach(async () => { for (const instance of active.splice(0)) await instance.dispose(); });
it("preserves unknown submission dates, distinct statuses and one owner per mirrored application through the Gmail migration", async () => {
  const instance = await createDatabase(); active.push(instance);
  const { db } = instance;
  await loadSchema(db, "pre-lifecycle");
  await loadFixture(db, "mixed-history");
  await loadSchema(db, "lifecycle-migration");
  expect(await db.prepare("SELECT applied_at FROM known_applications WHERE id = 1").first()).toEqual({ applied_at: null });
  expect((await db.prepare("SELECT owner_id, status, applied_at FROM applications ORDER BY owner_id").all()).results).toEqual([
    { owner_id: "1", status: "applied", applied_at: null },
    { owner_id: "2", status: "packet_ready", applied_at: null },
    { owner_id: "prepared", status: "materials_ready", applied_at: null },
  ]);
  await db.prepare("INSERT INTO lifecycle_receipts (gmail_message_id, received_at, evidence, decision, created_at, updated_at) VALUES ('fixture1','2026-09-21','fixture','not_job','2026-09-21','2026-09-21')").run();
  expect(await db.prepare("SELECT attempts, test, scheduled_for FROM lifecycle_receipts").first()).toEqual({ attempts: 0, test: 0, scheduled_for: null });
  await db.prepare("INSERT INTO interview_rounds (owner_table, owner_id, round, invited_at, scheduled_for, created_at) VALUES ('known_applications','1',2,'2026-09-21','2026-09-24T15:00:00Z','2026-09-21')").run();
  expect(await db.prepare("SELECT interview_round FROM applications WHERE owner_id = '1'").first()).toEqual({ interview_round: 2 });
});
it("gives fresh and migrated databases the same tables, columns, indexes and application view", async () => {
  const fresh = await createDatabase(); active.push(fresh);
  const migrated = await createDatabase(); active.push(migrated);
  await loadSchema(fresh.db, "root");
  await loadSchema(migrated.db, "pre-lifecycle");
  await loadSchema(migrated.db, "lifecycle-migration");
  await loadSchema(migrated.db, "discovery-controls-migration");
  await loadSchema(migrated.db, "discovery-coverage-migration");
  await loadSchema(migrated.db, "discovery-query-migration");
  await loadSchema(migrated.db, "discovery-alias-migration");
  await loadSchema(migrated.db, "discovery-candidates-migration");
  await loadSchema(migrated.db, "discovery-fixed-candidates-migration");
  await loadSchema(migrated.db, "durable-manual-intake-migration");
  await loadSchema(migrated.db, "release-receipts-migration");
  await loadSchema(migrated.db, "radar-migration");
  await loadSchema(migrated.db, "candidate-config-migration");
  await loadSchema(migrated.db, "fixed-baseline-migration");
  const names = ["fixed_baselines","posting_snapshots", "job_evaluations", "job_screening_current", "screening_deliveries", "candidate_run_configs", "candidate_active_configs","schema_release_receipts", "jobs", "known_applications", "pipeline_runs", "search_rotation", "lifecycle_checkpoints", "lifecycle_receipts", "interview_rounds", "applications", "discovery_run_leases", "discovery_retries", "discovery_runs", "discovery_query_pages", "discovery_page_attempts", "discovery_url_observations", "discovery_run_items", "discovery_run_inputs", "discovery_run_delivery_resolutions", "discovery_delivery_attempts", "discovery_health_incidents", "discovery_query_page_results", "discovery_job_owners", "discovery_job_aliases", "discovery_candidates", "discovery_candidate_url_owners", "discovery_candidate_claim_budgets", "discovery_run_candidate_inputs", "manual_intake_requests", "manual_intake_jobs", "manual_intake_deliveries", "radar_posts", "radar_authors", "radar_runs"];
  for (const table of names) {
    expect((await migrated.db.prepare(`PRAGMA table_info(${table})`).all()).results).toEqual((await fresh.db.prepare(`PRAGMA table_info(${table})`).all()).results);
    expect((await migrated.db.prepare(`PRAGMA index_list(${table})`).all()).results).toEqual((await fresh.db.prepare(`PRAGMA index_list(${table})`).all()).results);
  }
  const view = async (db: D1Database) => (await db.prepare("SELECT sql FROM sqlite_master WHERE name='applications'").first<{sql: string}>())?.sql.replace(/\s+/g, " ");
  expect(await view(migrated.db)).toBe(await view(fresh.db));
  // table_info leaves out CHECK constraints, such as radar_posts' list of
  // triage kinds, so the radar tables are compared whole: schema.sql and
  // schema.radar-migration.sql must define them identically.
  const definition = async (db: D1Database, table: string) =>
    (await db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").bind(table).first<{ sql: string }>())?.sql;
  for (const table of ["radar_posts", "radar_authors", "radar_runs", "candidate_run_configs", "candidate_active_configs", "posting_snapshots", "job_evaluations", "job_screening_current", "screening_deliveries"]) {
    expect(await definition(fresh.db, table)).toContain(`CREATE TABLE ${table}`);
    expect(await definition(migrated.db, table)).toBe(await definition(fresh.db, table));
  }
});

it("adds fixed context to an existing D3 queue and visibly holds rows without it", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "pre-lifecycle");
  await loadSchema(db, "lifecycle-migration");
  await loadSchema(db, "discovery-controls-migration");
  await loadSchema(db, "discovery-coverage-migration");
  await loadSchema(db, "discovery-query-migration");
  await loadSchema(db, "discovery-alias-migration");
  await loadSchema(db, "discovery-candidates-migration");
  await db.prepare(`INSERT INTO discovery_candidates
    (pipeline,candidate_key,original_url,current_url,canonical_job_id,discovered_at,
     last_seen_at,first_run_id,last_seen_run_id,source_id,status)
    VALUES ('fixed_boards','greenhouse:fixture:1','https://example.test/1',
      'https://example.test/1','greenhouse:fixture:1','2026-09-20','2026-09-20',
      'old','old','greenhouse:fixture','pending')`).run();
  await loadSchema(db, "discovery-fixed-candidates-migration");
  expect(await db.prepare(`SELECT status,failure_category,first_run_id,fixed_context_json
    FROM discovery_candidates WHERE candidate_key='greenhouse:fixture:1'`).first())
    .toEqual({ status: "held", failure_category: "missing_fixed_context",
      first_run_id: "old", fixed_context_json: null });
});

it("adds discovery accounting twice without changing existing application records", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "pre-lifecycle");
  await loadFixture(db, "mixed-history");
  await loadSchema(db, "lifecycle-migration");
  await loadSchema(db, "discovery-controls-migration");
  const protectedTables = ["jobs", "known_applications", "applications", "pipeline_runs", "lifecycle_receipts"];
  const snapshot = async () => Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const before = await snapshot();
  await loadSchema(db, "discovery-coverage-migration");
  await loadSchema(db, "discovery-coverage-migration");
  expect(await snapshot()).toEqual(before);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM discovery_runs").first()).toEqual({ n: 0 });
});

it("replays discovery migration without changing a delivered screening receipt", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "root");
  await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
    VALUES ('screened','Fixture','Director','https://example.test/screened','2026-09-21','2026-09-21')`).run();
  await db.prepare(`INSERT INTO posting_snapshots
    (id,job_id,content_hash,normalized_json,normalizer_version)
    VALUES ('snapshot','screened','hash','{"id":"screened"}','fixture')`).run();
  await db.prepare(`INSERT INTO job_evaluations
    (id,job_id,run_id,snapshot_id,state,decision_json,criteria_version,prompt_version,model,evaluated_at)
    VALUES ('evaluation','screened','prior','snapshot','match',
      '{"state":"match","criteriaVersion":"c1","promptVersion":"p1","model":"fixture"}',
      'c1','p1','fixture','2026-09-21')`).run();
  await db.prepare(`INSERT INTO screening_deliveries
    (evaluation_id,job_id,status,delivered_at)
    VALUES ('evaluation','screened','delivered','2026-09-21')`).run();
  const before = (await db.prepare("SELECT * FROM screening_deliveries").all()).results;
  await loadSchema(db, "discovery-coverage-migration");
  await loadSchema(db, "discovery-coverage-migration");
  expect((await db.prepare("SELECT * FROM screening_deliveries").all()).results).toEqual(before);
});

it("adds discovery controls idempotently without changing existing application or Gmail data", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "pre-lifecycle"); await loadFixture(db, "mixed-history"); await loadSchema(db, "lifecycle-migration");
  await db.prepare("INSERT INTO lifecycle_receipts (gmail_message_id,received_at,evidence,decision,created_at,updated_at) VALUES ('mail','unknown','fixture','test','now','now')").run();
  const tables = ["jobs", "known_applications", "applications", "lifecycle_receipts", "pipeline_runs"];
  const snapshot = async () => Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const before = await snapshot();
  await loadSchema(db, "discovery-controls-migration"); await loadSchema(db, "discovery-controls-migration");
  expect(await snapshot()).toEqual(before);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM discovery_retries").first()).toEqual({ n: 0 });
});

it("replays durable manual intake schema without changing jobs, applications, or receipts", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "root");
  await db.prepare(`INSERT INTO jobs
    (id,company,title,url,first_seen_at,last_seen_at,application_status,notified_at)
    VALUES ('existing','Fixture','Director','https://example.test/job',
      '2026-09-20','2026-09-20','passed','2026-09-21')`).run();
  const before = (await db.prepare("SELECT * FROM jobs").all()).results;
  await loadSchema(db, "durable-manual-intake-migration");
  await loadSchema(db, "durable-manual-intake-migration");
  expect((await db.prepare("SELECT * FROM jobs").all()).results).toEqual(before);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_requests").first())
    .toEqual({ n: 0 });
});

it("records exact release provenance without backfilling unknown migration history", async () => {
  const instance = await createDatabase(); active.push(instance);
  await loadSchema(instance.db, "root");
  expect(await instance.db.prepare("SELECT COUNT(*) AS n FROM schema_release_receipts").first()).toEqual({ n: 0 });
  const record = () => instance.db.prepare(`INSERT INTO schema_release_receipts
    (migration_id,sha256,source_commit,applied_at) VALUES (?,?,?,?)`)
    .bind("coverage-d0", "a".repeat(64), "b".repeat(40), "2026-09-23T22:00:00Z").run();
  await record();
  await expect(record()).rejects.toThrow();
  expect(await instance.db.prepare("SELECT COUNT(*) AS n FROM schema_release_receipts").first()).toEqual({ n: 1 });
});

it("adds the radar tables without touching existing rows, and can be applied twice", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "pre-lifecycle");
  await loadFixture(db, "mixed-history");
  const before = (await db.prepare("SELECT * FROM known_applications ORDER BY id").all()).results;
  await loadSchema(db, "radar-migration");
  await db.prepare("INSERT INTO radar_runs (id, started_at, status) VALUES ('r1','2026-09-26T18:30:00Z','running')").run();
  await loadSchema(db, "radar-migration");
  expect((await db.prepare("SELECT * FROM known_applications ORDER BY id").all()).results).toEqual(before);
  expect(await db.prepare("SELECT status, collect_ok, est_cost_usd, editor_fallback FROM radar_runs").first())
    .toEqual({ status: "running", collect_ok: 0, est_cost_usd: 0, editor_fallback: 0 });
});

it("adds provenance without rewriting application owners, aliases, leases or delivered evidence", async () => {
  const instance = await createDatabase(); active.push(instance); const { db } = instance;
  await loadSchema(db, "root");
  // Remove only the new additive objects to model the immediately preceding root schema.
  await db.batch([db.prepare("DROP TABLE candidate_run_configs"), db.prepare("DROP TABLE candidate_active_configs"), db.prepare("ALTER TABLE jobs DROP COLUMN criteria_version")]);
  await loadFixture(db, "mixed-history");
  await db.prepare("UPDATE jobs SET application_status='offer',application_status_source='manual',application_status_updated_at='2026-01-01',match=1,notified_at='2026-01-01' WHERE id='mirror'").run();
  await db.prepare(`INSERT INTO discovery_job_aliases (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
    VALUES ('https://example.test/alias','mirror','fixture','1','https://example.test/1','2026-01-01')`).run();
  await db.prepare(`INSERT INTO discovery_run_leases (pipeline,owner,fence,expires_at) VALUES ('fixed_boards','old',7,123456789)`).run();
  await db.prepare(`INSERT INTO posting_snapshots (id,job_id,content_hash,normalized_json,normalizer_version)
    VALUES ('old-snapshot','mirror','hash','{"id":"mirror"}','synthetic')`).run();
  await db.prepare(`INSERT INTO job_evaluations (id,job_id,run_id,snapshot_id,state,decision_json,criteria_version,prompt_version,model,evaluated_at)
    VALUES ('old-evaluation','mirror','old','old-snapshot','match',
    '{"state":"match","criteriaVersion":"old","promptVersion":"synthetic","model":"synthetic"}', 'old','synthetic','synthetic','2026-01-01')`).run();
  await db.prepare(`INSERT INTO screening_deliveries (evaluation_id,job_id,status,delivered_at) VALUES ('old-evaluation','mirror','delivered','2026-01-01')`).run();
  const protectedTables = ["known_applications", "applications", "discovery_job_aliases", "discovery_run_leases", "posting_snapshots", "job_evaluations", "screening_deliveries"];
  const before = await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const oldJobs = (await db.prepare("SELECT * FROM jobs ORDER BY id").all()).results;
  await loadSchema(db, "candidate-config-migration");
  expect(await Promise.all(protectedTables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results))).toEqual(before);
  expect((await db.prepare("SELECT * FROM jobs ORDER BY id").all()).results).toEqual(oldJobs.map(job => ({ ...job, criteria_version: null })));
  expect(await db.prepare("SELECT COUNT(*) AS n FROM candidate_run_configs").first()).toEqual({ n: 0 });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM candidate_active_configs").first()).toEqual({ n: 0 });
});
