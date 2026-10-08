import type { Source } from "../../src/sources";
const sources: readonly Source[] = [{ company: "Example Automation", companyCategory: "applied AI", ats: "greenhouse", slug: "example-automation" }];
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { acquireLease, releaseLease } from "../../src/operations/leases";
import { selectCandidateBatch, settleCandidate, missingRetryContext } from "../../src/discovery/candidates";
import { loadClaimedFixedCandidates, persistFixedCandidate, reconcileFixedCandidateOwners } from "../../src/discovery/fixed-candidates";
import { startDiscoveryRun, summarizeRun } from "../../src/discovery/coverage";
import type { NormalizedJob } from "../../src/sources";

const observedAt = "2026-09-23T12:00:00.000Z";
const fixedJob = (suffix: string): NormalizedJob => ({
  id: `greenhouse:Example Automation:${suffix}`, company: "Example Automation", title: "Operations Lead",
  url: `https://careers.example-automation.com/jobs/${suffix}`, location: "Remote US",
  department: "Operations", isRemote: true, employmentType: "Full-time",
  postedAt: null, compensation: null, description: "Lead operations programs.",
});

describe("fixed-board candidate context", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
  afterEach(async () => { await dispose(); });

  async function seedFutureAlias() {
    const lease = (await acquireLease(db, "fixed_boards", "alias-reconciliation"))!;
    await startDiscoveryRun(db, lease, { runId: lease.owner, pipeline: lease.pipeline,
      codeVersion: "fixture", queryVersion: "fixture", registryVersion: "fixture", startedAt: observedAt });
    const listing = { ...fixedJob("123"), url: "https://job-boards.greenhouse.io/example-automation/jobs/123" };
    const ownerId = "greenhouse:example-automation:123";
    const deadline = Date.now() + 3600_000;
    await persistFixedCandidate(db, lease, listing, "greenhouse:Example Automation", observedAt, sources);
    await db.prepare(`UPDATE discovery_candidates SET status='retry_wait',next_attempt_at=?,
      failure_category='discovery_retry' WHERE candidate_key=?`).bind(deadline, listing.id).run();
    await db.prepare(`INSERT INTO discovery_retries VALUES
      ('fixed_boards',?,'filter',1,'old','provider',0,?)`).bind(listing.id, deadline).run();
    await db.prepare(`INSERT INTO jobs
      (id,company,title,url,first_seen_at,last_seen_at,application_status,notified_at)
      VALUES (?,'Example Automation','Operations Lead',?,?,?,'applied',?)`)
      .bind(ownerId, listing.url, observedAt, observedAt, observedAt).run();
    return { lease, listing, ownerId, deadline };
  }

  it.each(["unassessed", "other_requisition", "other_employer"])(
    "keeps a future alias retry when its owner is %s", async reason => {
      const { lease, listing, ownerId, deadline } = await seedFutureAlias();
      if (reason === "unassessed") await db.prepare(`UPDATE jobs SET application_status='not_applied',
        notified_at=NULL WHERE id=?`).bind(ownerId).run();
      else await db.prepare("UPDATE jobs SET url=? WHERE id=?").bind(reason === "other_requisition"
        ? "https://job-boards.greenhouse.io/example-automation/jobs/999"
        : "https://job-boards.greenhouse.io/other-fixture/jobs/123", ownerId).run();
      expect(await selectCandidateBatch(db, lease,
        { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources })).toEqual([]);
      expect(await db.prepare(`SELECT status,next_attempt_at,merged_owner_key FROM discovery_candidates
        WHERE candidate_key=?`).bind(listing.id).first())
        .toEqual({ status: "retry_wait", next_attempt_at: deadline, merged_owner_key: null });
      expect(await db.prepare("SELECT attempts,next_attempt_at FROM discovery_retries WHERE job_id=?")
        .bind(listing.id).first()).toEqual({ attempts: 1, next_attempt_at: deadline });
      expect(await db.prepare("SELECT item_id FROM discovery_run_items WHERE stage='select'").first()).toBeNull();
    });

  it("holds ambiguous owners without blocking unrelated candidates or clearing their retry", async () => {
    const { lease, listing, deadline } = await seedFutureAlias();
    await db.prepare(`INSERT INTO jobs
      (id,company,title,url,first_seen_at,last_seen_at,application_status)
      VALUES (?,'Example Automation','Operations Lead',?,?,?,'applied')`)
      .bind(listing.id, listing.url, observedAt, observedAt).run();
    await persistFixedCandidate(db, lease, fixedJob("456"), "greenhouse:Example Automation", observedAt, sources);
    expect(await selectCandidateBatch(db, lease,
      { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources }))
      .toMatchObject([{ candidateKey: fixedJob("456").id }]);
    expect(await db.prepare(`SELECT status,failure_category,merged_owner_key FROM discovery_candidates
      WHERE candidate_key=?`).bind(listing.id).first())
      .toEqual({ status: "held", failure_category: "ambiguous_ats_owner", merged_owner_key: null });
    expect(await db.prepare("SELECT attempts,next_attempt_at FROM discovery_retries WHERE job_id=?")
      .bind(listing.id).first()).toEqual({ attempts: 1, next_attempt_at: deadline });
    expect(await db.prepare("SELECT outcome FROM discovery_run_items WHERE item_id=? AND stage='select'")
      .bind(listing.id).first()).toEqual({ outcome: "identity_review" });
    expect(await db.prepare("SELECT count(*) AS n FROM jobs").first()).toEqual({ n: 2 });
  });

  it.each([[true, true], [false, true], [true, false]])(
    "preserves conflict accounting and recovers exact owner assessed=%s identityValid=%s", async (assessed, identityValid) => {
    const { lease, listing, ownerId, deadline } = await seedFutureAlias();
    await db.prepare(`UPDATE discovery_candidates SET first_run_id='prior',last_seen_run_id='prior'`).run();
    await db.prepare(`INSERT INTO jobs
      (id,company,title,url,first_seen_at,last_seen_at,application_status)
      VALUES (?,'Example Automation','Operations Lead',?,?,?,?)`)
      .bind(listing.id, listing.url, observedAt, observedAt, assessed ? "applied" : "not_applied").run();
    await reconcileFixedCandidateOwners(db, lease, Date.now(), sources);
    expect(await summarizeRun(db, lease.owner)).toMatchObject({ unionInputs: 1, identityReviewJobs: 1 });
    expect(await db.prepare(`SELECT status_at_claim,next_attempt_at_at_claim FROM discovery_run_candidate_inputs
      WHERE run_id=? AND candidate_key=?`).bind(lease.owner, listing.id).first())
      .toEqual({ status_at_claim: "retry_wait", next_attempt_at_at_claim: deadline });
    await releaseLease(db, lease);
    await db.prepare("DELETE FROM jobs WHERE id=?").bind(ownerId).run();
    if (!identityValid) {
      const other = "https://job-boards.greenhouse.io/other-fixture/jobs/123";
      await db.prepare("UPDATE discovery_candidates SET current_url=?").bind(other).run();
      await db.prepare("UPDATE jobs SET url=? WHERE id=?").bind(other, listing.id).run();
    }
    const next = (await acquireLease(db, "fixed_boards", "conflict-resolved"))!;
    await startDiscoveryRun(db, next, { runId: next.owner, pipeline: next.pipeline,
      codeVersion: "fixture", queryVersion: "fixture", registryVersion: "fixture", startedAt: observedAt });
    expect(await selectCandidateBatch(db, next,
      { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources })).toEqual([]);
    expect(await db.prepare("SELECT status,merged_owner_key FROM discovery_candidates WHERE candidate_key=?")
      .bind(listing.id).first()).toEqual({ status: assessed && identityValid ? "complete" : "held", merged_owner_key: null });
    expect(await db.prepare("SELECT attempts FROM discovery_retries WHERE job_id=?").bind(listing.id).first())
      .toEqual(assessed && identityValid ? null : { attempts: 1 });
  });

  it("commits alias accounting once when candidate selection is replayed", async () => {
    const { lease, listing, ownerId, deadline } = await seedFutureAlias();
    const options = { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources };
    expect(await selectCandidateBatch(db, lease, options)).toEqual([]);
    expect(await selectCandidateBatch(db, lease, options)).toEqual([]);
    expect((await db.prepare(`SELECT candidate_key,kind,status_at_claim,next_attempt_at_at_claim,claim_selected
      FROM discovery_run_candidate_inputs WHERE run_id=?`).bind(lease.owner).all()).results)
      .toEqual([{ candidate_key: listing.id, kind: "current", status_at_claim: "retry_wait",
        next_attempt_at_at_claim: deadline, claim_selected: 0 }]);
    expect((await db.prepare("SELECT item_id,outcome,detail FROM discovery_run_items WHERE stage='select'").all()).results)
      .toEqual([{ item_id: listing.id, outcome: "existing", detail: ownerId }]);
    expect(await db.prepare("SELECT job_id FROM discovery_retries WHERE job_id=?").bind(listing.id).first()).toBeNull();
  });

  it("preserves the frozen claim roster when manual ownership changes later in that run", async () => {
    const { lease, listing, ownerId, deadline } = await seedFutureAlias();
    await db.prepare("UPDATE jobs SET application_status='not_applied',notified_at=NULL WHERE id=?").bind(ownerId).run();
    const options = { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources };
    expect(await selectCandidateBatch(db, lease, options)).toEqual([]);
    await db.prepare("UPDATE jobs SET application_status='applied' WHERE id=?").bind(ownerId).run();
    expect(await selectCandidateBatch(db, lease, options)).toEqual([]);
    expect(await db.prepare("SELECT status,next_attempt_at FROM discovery_candidates WHERE candidate_key=?")
      .bind(listing.id).first()).toEqual({ status: "retry_wait", next_attempt_at: deadline });
    expect(await db.prepare("SELECT attempts FROM discovery_retries WHERE job_id=?").bind(listing.id).first())
      .toEqual({ attempts: 1 });
  });

  it.each(["owner_changed", "lease_lost", "canonical_owner_reappears"])("guards the atomic alias mutation when %s after lookup", async fault => {
    const { lease, listing, ownerId, deadline } = await seedFutureAlias();
    if (fault === "canonical_owner_reappears") {
      await db.prepare("UPDATE jobs SET id=? WHERE id=?").bind(listing.id, ownerId).run();
      await db.prepare(`UPDATE discovery_candidates SET status='held',failure_category='ambiguous_ats_owner'`).run();
    }
    let injected = false;
    const racingDb = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!injected) {
          injected = true;
          if (fault === "owner_changed") await db.prepare(`UPDATE jobs SET application_status='not_applied',
            notified_at=NULL WHERE id=?`).bind(ownerId).run();
          else if (fault === "canonical_owner_reappears") {
            await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,application_status)
              VALUES (?,'Example Automation','Operations Lead',?,?,?,'applied')`)
              .bind(ownerId, listing.url, observedAt, observedAt).run();
          } else {
            await db.prepare("UPDATE discovery_run_leases SET expires_at=0").run();
            await acquireLease(db, "fixed_boards", "replacement");
          }
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = reconcileFixedCandidateOwners(racingDb, lease, Date.now(), sources);
    if (fault === "lease_lost") await expect(result).rejects.toThrow(/lease/i);
    else await result;
    expect(await db.prepare("SELECT status,next_attempt_at FROM discovery_candidates WHERE candidate_key=?")
      .bind(listing.id).first()).toEqual({ status: fault === "canonical_owner_reappears" ? "held" : "retry_wait",
        next_attempt_at: deadline });
    expect(await db.prepare("SELECT attempts FROM discovery_retries WHERE job_id=?").bind(listing.id).first())
      .toEqual({ attempts: 1 });
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_run_candidate_inputs").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_run_items").first()).toEqual({ n: 0 });
  });

  it("retains a board-sourced job for a later run without another board hit", async () => {
    const first = (await acquireLease(db, "fixed_boards", "fixed-seed"))!;
    await persistFixedCandidate(db, first, fixedJob("123"), "greenhouse:Example Automation", observedAt, sources);
    await releaseLease(db, first);

    const next = (await acquireLease(db, "fixed_boards", "fixed-next"))!;
    expect(await selectCandidateBatch(db, next,
      { now: Date.parse(observedAt) + 60_000, totalLimit: 500, dueRetryLimit: 50, sources }))
      .toMatchObject([{ candidateKey: "greenhouse:Example Automation:123" }]);
    expect(await loadClaimedFixedCandidates(db, next)).toMatchObject([{
      job: { id: "greenhouse:Example Automation:123", url: fixedJob("123").url },
      observedThisRun: false,
      claim: { candidateKey: "greenhouse:Example Automation:123" },
    }]);
    expect(await db.prepare(`SELECT discovered_at,first_run_id FROM discovery_candidates
      WHERE pipeline='fixed_boards' AND candidate_key='greenhouse:Example Automation:123'`).first())
      .toEqual({ discovered_at: observedAt, first_run_id: "fixed-seed" });
  });

  it("does not classify a due fixed-board retry with stored context as missing", async () => {
    const first = (await acquireLease(db, "fixed_boards", "fixed-seed"))!;
    await persistFixedCandidate(db, first, fixedJob("124"), "greenhouse:Example Automation", observedAt, sources);
    await db.prepare(`INSERT INTO discovery_retries
      (pipeline,job_id,stage,attempts,last_run_id,last_error,failed_at,next_attempt_at)
      VALUES ('fixed_boards','greenhouse:Example Automation:124','fetch',1,'old','timeout',?,?)`)
      .bind(Date.parse(observedAt), Date.parse(observedAt)).run();
    await releaseLease(db, first);
    expect(await missingRetryContext(db, "fixed_boards", Date.parse(observedAt)))
      .toMatchObject({ total: 0, rows: [] });
  });

  it("reopens a held missing-context row only after a fresh board observation", async () => {
    const lease = (await acquireLease(db, "fixed_boards", "refresh-context"))!;
    await db.prepare(`INSERT INTO discovery_candidates
      (pipeline,candidate_key,original_url,current_url,canonical_job_id,discovered_at,
       last_seen_at,first_run_id,last_seen_run_id,source_id,status,failure_category)
      VALUES ('fixed_boards','greenhouse:Example Automation:126',?,?,?,?,?,?,?,?,
        'held','missing_fixed_context')`)
      .bind(fixedJob("126").url, fixedJob("126").url, fixedJob("126").id,
        observedAt, observedAt, "old", "old", "greenhouse:Example Automation").run();
    await persistFixedCandidate(db, lease, fixedJob("126"), "greenhouse:Example Automation", observedAt, sources);
    expect(await db.prepare(`SELECT status,failure_category,fixed_context_json FROM discovery_candidates
      WHERE candidate_key='greenhouse:Example Automation:126'`).first())
      .toMatchObject({ status: "pending", failure_category: null,
        fixed_context_json: expect.stringContaining('"greenhouse:Example Automation:126"') });
  });

  it("rejects a forged fixed-board identity before persistence", async () => {
    const lease = (await acquireLease(db, "fixed_boards", "fixed-forged"))!;
    await expect(persistFixedCandidate(db, lease,
      { ...fixedJob("125"), id: "greenhouse:Other:125" }, "greenhouse:Example Automation", observedAt, sources))
      .rejects.toThrow(/identity|source/i);
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_candidates").first()).toEqual({ n: 0 });
  });

  it.each(["ashby", "lever", "amazon"] as const)("rejects changed same-company %s source context before persistence", async ats => {
    const lease = (await acquireLease(db, "fixed_boards", `changed-${ats}`))!;
    const company = "Fixture Boards";
    const selected: Source = ats === "amazon"
      ? { ats, company, category: "new-category", companyCategory: "applied AI" }
      : { ats, company, slug: "new-board", companyCategory: "applied AI" };
    const job = { ...fixedJob("123"), company, id: `${ats}:${company}:123`,
      url: ats === "amazon" ? "https://www.amazon.jobs/en/jobs/123/role"
        : `https://jobs.${ats === "ashby" ? "ashbyhq.com" : "lever.co"}/old-board/123`,
      fixedSourceProvenance: { ats: "amazon" as const, category: "old-category" } };
    await expect(persistFixedCandidate(db, lease, job, `${ats}:${company}`, observedAt, [selected]))
      .rejects.toThrow(/identity|source/i);
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_candidates").first()).toEqual({ n: 0 });
    const valid = { ...job, url: job.url.replace("old-board", "new-board"),
      fixedSourceProvenance: { ats: "amazon" as const, category: "new-category" } };
    await persistFixedCandidate(db, lease, valid, `${ats}:${company}`, observedAt, [selected]);
    const retained = await db.prepare("SELECT fixed_context_json FROM discovery_candidates WHERE candidate_key=?")
      .bind(valid.id).first<{ fixed_context_json: string }>();
    expect(JSON.parse(retained!.fixed_context_json)).toEqual(valid);
  });

  it("persists valid Workday source identity and rejects another tenant or requisition", async () => {
    const lease = (await acquireLease(db, "fixed_boards", "workday-forged"))!;
    const listing: NormalizedJob = { ...fixedJob("123"), id: "workday:Fixture Compute:JR123",
      company: "Fixture Compute", url: "https://fixture-compute.wd5.myworkdayjobs.com/External/job/Austin/Ops_JR123" };
    const workdaySources: readonly Source[] = [{ ats: "workday", company: "Fixture Compute", companyCategory: "AI infrastructure", tenant: "fixture-compute", wdHost: "wd5", site: "External", searchTerms: ["Operations"] }];
    await persistFixedCandidate(db, lease, listing, "workday:Fixture Compute", observedAt, workdaySources);
    expect(await db.prepare("SELECT candidate_key FROM discovery_candidates WHERE candidate_key=?").bind(listing.id).first())
      .toEqual({ candidate_key: listing.id });
    listing.url = "https://other.wd5.myworkdayjobs.com/External/job/Austin/Ops_JR123";
    await expect(persistFixedCandidate(db, lease, listing, "workday:Fixture Compute", observedAt, workdaySources))
      .rejects.toThrow(/identity/i);
    listing.url = "https://fixture-compute.wd5.myworkdayjobs.com/External/job/Austin/Ops_JR999";
    await expect(persistFixedCandidate(db, lease, listing, "workday:Fixture Compute", observedAt, workdaySources))
      .rejects.toThrow(/identity/i);
  });

  it("keeps fixed-board overflow after a replayed bounded claim", async () => {
    const first = (await acquireLease(db, "fixed_boards", "fixed-cap"))!;
    await persistFixedCandidate(db, first, fixedJob("201"), "greenhouse:Example Automation", observedAt, sources);
    await persistFixedCandidate(db, first, fixedJob("202"), "greenhouse:Example Automation", observedAt, sources);
    const claimed = await selectCandidateBatch(db, first,
      { now: Date.parse(observedAt), totalLimit: 1, dueRetryLimit: 0, sources });
    expect(claimed.map(item => item.candidateKey)).toEqual(["greenhouse:Example Automation:201"]);
    expect(await selectCandidateBatch(db, first,
      { now: Date.parse(observedAt), totalLimit: 1, dueRetryLimit: 0, sources })).toEqual(claimed);
    expect(await db.prepare(`SELECT status FROM discovery_candidates
      WHERE pipeline='fixed_boards' AND candidate_key='greenhouse:Example Automation:202'`).first())
      .toEqual({ status: "pending" });
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?)`).bind(fixedJob("201").id, "Example Automation", "Operations Lead",
      fixedJob("201").url, observedAt, observedAt).run();
    await settleCandidate(db, first, claimed[0], { status: "complete" });
    await releaseLease(db, first);
    const next = (await acquireLease(db, "fixed_boards", "fixed-after-cap"))!;
    expect(await selectCandidateBatch(db, next,
      { now: Date.parse(observedAt) + 60_000, totalLimit: 1, dueRetryLimit: 0, sources }))
      .toMatchObject([{ candidateKey: "greenhouse:Example Automation:202" }]);
  });
});
