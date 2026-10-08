import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { acceptIntake, claimAndSaveJob, readIntake } from "../../src/intake/store";
import type { Admission } from "../../src/intake/types";
import type { NormalizedJob } from "../../src/sources";
import type { ResolutionResult } from "../../src/discovery/types";

const at = "2026-09-22T22:00:00.000Z";
const url = "https://jobs.lever.co/acme/abc";
const admission = (id: string, inputUrl = url): Admission => ({ id: id.repeat(64),
  teamId: "T1", userId: "U1", channelId: "C1", inputUrl, now: at });
const posting = (jobUrl = url): NormalizedJob => ({ id: "lever:acme:abc", company: "Acme",
  title: "Director of Operations", url: jobUrl, location: "Remote US", department: "Operations",
  isRemote: true, employmentType: "Full time", postedAt: null, compensation: null,
  description: "Lead operations." });

describe("durable manual intake store", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
  afterEach(async () => { await dispose(); });

  it("reuses the persisted request rather than replacing it on Slack replay", async () => {
    const input = admission("a");
    const first = await acceptIntake(db, input);
    const replay = await acceptIntake(db, { ...input, now: "2026-09-22T22:01:00.000Z" });
    expect(replay.id).toBe(first.id);
    expect(replay.createdAt).toBe(first.createdAt);
    expect(replay).toMatchObject({ state: "accepted", stage: "resolve",
      workflowId: `intake-${input.id}-g0` });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_requests").first())
      .toEqual({ n: 1 });
    await expect(acceptIntake(db, { ...input, inputUrl: "https://jobs.lever.co/other/xyz" }))
      .rejects.toThrow(/conflict/i);
    expect((await readIntake(db, input.id))?.inputUrl).toBe(url);
  });

  it("claims and saves one selected job before any advisory work", async () => {
    const input = admission("b");
    await acceptIntake(db, input);
    expect(await claimAndSaveJob(db, input.id, 0, posting(), at)).toEqual({
      kind: "owned", requestId: input.id, jobId: "lever:acme:abc",
    });
    expect(await db.prepare(`SELECT application_status,application_status_source,
      discovery_source,match,notified_at FROM jobs WHERE id='lever:acme:abc'`).first())
      .toEqual({ application_status: "needs_materials", application_status_source: "manual",
        discovery_source: "manual_add", match: null, notified_at: null });
    expect(await readIntake(db, input.id)).toMatchObject({ state: "saved", stage: "screen",
      jobId: "lever:acme:abc", ownerRequestId: input.id });
    expect(await claimAndSaveJob(db, input.id, 0, posting(), at)).toMatchObject({ kind: "owned" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_jobs").first()).toEqual({ n: 1 });
  });

  it("joins the first owner across two observed URLs without duplicating a job", async () => {
    const first = admission("c");
    const second = admission("d", "https://careers.acme.test/jobs/abc");
    await acceptIntake(db, first); await acceptIntake(db, second);
    const results = await Promise.all([
      claimAndSaveJob(db, first.id, 0, posting(), at),
      claimAndSaveJob(db, second.id, 0, posting("https://careers.acme.test/jobs/abc"), at),
    ]);
    expect(results.map(row => row.kind).sort()).toEqual(["joined", "owned"]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id='lever:acme:abc'").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_jobs").first()).toEqual({ n: 1 });
  });

  it("reports an existing user decision and receipt without changing them", async () => {
    const input = admission("e");
    await acceptIntake(db, input);
    await db.prepare(`INSERT INTO jobs
      (id,company,title,url,first_seen_at,last_seen_at,application_status,
        application_status_source,application_status_updated_at,notified_at)
      VALUES ('lever:acme:abc','Acme','Director',?,'2026-09-20','2026-09-20',
        'applied','manual','2026-09-21','2026-09-20')`).bind(url).run();
    const before = await db.prepare("SELECT * FROM jobs WHERE id='lever:acme:abc'").first();
    await db.prepare(`INSERT INTO posting_snapshots
      (id,job_id,content_hash,normalized_json,normalizer_version)
      VALUES ('manual-existing-snapshot','lever:acme:abc','hash',
        '{"id":"lever:acme:abc"}','fixture')`).run();
    await db.prepare(`INSERT INTO job_evaluations
      (id,job_id,run_id,snapshot_id,state,decision_json,criteria_version,prompt_version,model,evaluated_at)
      VALUES ('manual-existing-evaluation','lever:acme:abc','prior','manual-existing-snapshot','match',
        '{"state":"match","criteriaVersion":"c1","promptVersion":"p1","model":"fixture"}',
        'c1','p1','fixture','2026-09-20')`).run();
    await db.prepare(`INSERT INTO screening_deliveries
      (evaluation_id,job_id,status,delivered_at)
      VALUES ('manual-existing-evaluation','lever:acme:abc','delivered','2026-09-20')`).run();
    const deliveryBefore = await db.prepare("SELECT * FROM screening_deliveries").first();
    expect(await claimAndSaveJob(db, input.id, 0, posting(), at)).toEqual({
      kind: "existing", jobId: "lever:acme:abc", applicationStatus: "applied",
      notifiedAt: "2026-09-20",
    });
    expect(await db.prepare("SELECT * FROM jobs WHERE id='lever:acme:abc'").first()).toEqual(before);
    expect(await db.prepare("SELECT * FROM screening_deliveries").first()).toEqual(deliveryBefore);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_jobs").first()).toEqual({ n: 0 });
  });

  it("preserves every existing disposition, including unassessed not_applied", async () => {
    const statuses = ["applied", "passed", "not_pursuing", "packet_ready",
      "materials_ready", "not_applied"];
    for (const [index, status] of statuses.entries()) {
      const id = `lever:acme:${index}`;
      const link = `https://jobs.lever.co/acme/${index}`;
      const input = admission(String(index), link);
      await acceptIntake(db, input);
      await db.prepare(`INSERT INTO jobs
        (id,company,title,url,first_seen_at,last_seen_at,application_status,
          application_status_source,application_status_updated_at,notified_at)
        VALUES (?,'Acme','Director',?,'2026-09-20','2026-09-20',?,
          'manual','2026-09-21','2026-09-20')`).bind(id, link, status).run();
      const before = await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first();
      expect(await claimAndSaveJob(db, input.id, 0,
        { ...posting(link), id }, at)).toMatchObject({ kind: "existing",
        applicationStatus: status, notifiedAt: "2026-09-20" });
      expect(await db.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first()).toEqual(before);
    }
  });

  it("rolls back an ownership claim if the job insert fails", async () => {
    const input = admission("9");
    await acceptIntake(db, input);
    await db.prepare(`CREATE TRIGGER fail_manual_job BEFORE INSERT ON jobs
      WHEN NEW.id='lever:acme:abc' BEGIN SELECT RAISE(ABORT,'simulated insert failure'); END`).run();
    await expect(claimAndSaveJob(db, input.id, 0, posting(), at))
      .rejects.toThrow(/simulated insert failure/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_jobs").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT id FROM jobs WHERE id='lever:acme:abc'").first()).toBeNull();
    expect(await readIntake(db, input.id)).toMatchObject({ state: "accepted", jobId: null });
  });

  it("holds ambiguous imported applications and rejects a stale generation without a job write", async () => {
    const input = admission("f");
    await acceptIntake(db, input);
    await db.prepare(`INSERT INTO known_applications
      (canonical_id,employer,title,status,source,source_job_id) VALUES
      ('abc','Acme','Director','applied','fixture','app-1'),
      ('abc','Acme','Director','applied','fixture','app-2')`).run();
    await expect(claimAndSaveJob(db, input.id, 1, posting(), at)).rejects.toThrow(/generation/i);
    expect(await claimAndSaveJob(db, input.id, 0, posting(), at)).toMatchObject({
      kind: "held", reason: "ambiguous_application_identity",
    });
    expect(await readIntake(db, input.id)).toMatchObject({ state: "held",
      failureCode: "ambiguous_application_identity" });
    expect(await db.prepare("SELECT id FROM jobs WHERE id='lever:acme:abc'").first()).toBeNull();
  });

  it("holds an applied employer and requisition with an alternate posting URL", async () => {
    const input = admission("f");
    await acceptIntake(db, input);
    await db.prepare(`INSERT INTO known_applications
      (canonical_id,employer,title,requisition_id,posting_url,status,source,source_job_id)
      VALUES ('imported-abc','Acme','Director','abc',?, 'applied','fixture','app-abc')`)
      .bind("https://careers.acme.example/roles/abc").run();
    expect(await claimAndSaveJob(db, input.id, 0, posting(), at))
      .toEqual({ kind: "held", reason: "ambiguous_application_identity" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });
    expect(await readIntake(db, input.id)).toMatchObject({state:"held",
      failureCode:"ambiguous_application_identity"});
  });

  it("does not save a manual job when a proven alias already belongs to another owner", async () => {
    const input = admission("8");
    await acceptIntake(db, input);
    await db.prepare(`INSERT INTO discovery_job_aliases
      (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
      VALUES (?, 'employer:other:xyz', 'other','xyz',?,?)`).bind(url,url,at).run();
    const proof: Extract<ResolutionResult,{kind:"resolved"}> = {
      kind:"resolved", posting:{kind:"employer",jobId:"lever:acme:abc",
        canonicalUrl:url,employerKey:"acme",requisitionId:"abc",job:posting()},
      aliases:[url],evidence:[{url,method:"jobposting",employerKey:"acme",requisitionId:"abc"}],
    };
    expect(await claimAndSaveJob(db,input.id,0,posting(),at,proof))
      .toEqual({kind:"held",reason:"alias_conflict"});
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({n:0});
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_jobs").first()).toEqual({n:0});
  });

  it("holds a resumed owner if freshly fetched content changed", async () => {
    const input = admission("7");
    await acceptIntake(db,input);
    expect((await claimAndSaveJob(db,input.id,0,posting(),at)).kind).toBe("owned");
    await db.prepare(`UPDATE manual_intake_requests SET workflow_generation=1,
      workflow_id=? WHERE id=?`).bind(`intake-${input.id}-g1`,input.id).run();
    expect(await claimAndSaveJob(db,input.id,1,
      {...posting(),location:"Hybrid, Purchase NY",isRemote:false},at))
      .toEqual({kind:"held",reason:"posting_changed"});
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({n:1});
    expect(await readIntake(db,input.id)).toMatchObject({state:"held",failureCode:"posting_changed"});
  });

  it("installs D2 aliases before M1 intake on a pre-alias schema", async () => {
    await db.batch([
      db.prepare("DROP TABLE manual_intake_deliveries"),
      db.prepare("DROP TABLE manual_intake_jobs"),
      db.prepare("DROP TABLE manual_intake_requests"),
      db.prepare("DROP TABLE discovery_job_aliases"),
      db.prepare("DROP TABLE discovery_job_owners"),
    ]);
    await loadSchema(db,"discovery-alias-migration");
    await loadSchema(db,"durable-manual-intake-migration");
    const input = admission("6");
    await acceptIntake(db,input);
    const proof: Extract<ResolutionResult,{kind:"resolved"}> = {
      kind:"resolved",posting:{kind:"employer",jobId:"lever:acme:abc",
        canonicalUrl:url,employerKey:"acme",requisitionId:"abc",job:posting()},
      aliases:[url],evidence:[{url,method:"jobposting",employerKey:"acme",requisitionId:"abc"}],
    };
    expect((await claimAndSaveJob(db,input.id,0,posting(),at,proof)).kind).toBe("owned");
    expect(await db.prepare("SELECT owner_job_id FROM discovery_job_aliases WHERE alias=?")
      .bind(url).first()).toEqual({owner_job_id:"lever:acme:abc"});
  });
});
