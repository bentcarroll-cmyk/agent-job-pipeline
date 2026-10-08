import type { Source } from "../../src/sources";
const sources: readonly Source[] = [{ company: "Example Platform", companyCategory: "AI infrastructure", ats: "greenhouse", slug: "example-platform" }];
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { readDiscoveryApplicationState } from "../../src/discovery/application-state";

const fixturepricing = { id: "greenhouse:fixturepricing:700", company: "Fixture Pricing", title: "Senior Manager, Pricing",
  url: "https://job-boards.greenhouse.io/fixturepricing/jobs/700" };
const fixturelearning = { id: "greenhouse:fixturelearning:701", company: "Fixture Learning", title: "Chief of Staff, Content",
  url: "https://job-boards.greenhouse.io/fixturelearning/jobs/701" };
let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
afterEach(async () => dispose());
const known = (extra: { employer?: string; title?: string; status?: string; canonicalId?: string; url?: string; req?: string } = {}) =>
  db.prepare(`INSERT INTO known_applications (employer,title,status,source,canonical_id,posting_url,requisition_id)
    VALUES (?, ?, ?, 'lifecycle_email', ?, ?, ?)`).bind(extra.employer ?? "Fixture Pricing", extra.title ?? "Senior Manager, Pricing",
      extra.status ?? "applied", extra.canonicalId ?? null, extra.url ?? null, extra.req ?? null).run();
const receipt = (extra: { decision?: string; test?: number; req?: string; employer?: string; title?: string } = {}) =>
  db.prepare(`INSERT INTO lifecycle_receipts (gmail_message_id,received_at,evidence,event,employer,title,requisition_id,
    decision,test,created_at,updated_at) VALUES ('receipt-1','2026-09-30T23:48:07Z','Confirmation',
    'application_confirmation',?,?,?,?,?,'2026-10-01T11:11:31Z','2026-10-01T11:11:31Z')`)
    .bind(extra.employer ?? "Fixture Learning + Other Learning", extra.title ?? "Chief of Staff, Content", extra.req ?? null,
      extra.decision ?? "question", extra.test ?? 0).run();

describe("application-aware discovery", () => {
  it("holds the email-only Fixture Pricing application for review without inventing a posting identity", async () => {
    await known();
    const before = await db.prepare("SELECT * FROM known_applications").all();
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "review", reason: "possible_prior_application" });
    expect((await db.prepare("SELECT * FROM known_applications").all()).results).toEqual(before.results);
  });

  it("recognizes Fixture Learning's explicit composite employer as review rather than an applied posting", async () => {
    await known({ employer: "Fixture Learning + Other Learning", title: "Chief of Staff, Content" });
    expect(await readDiscoveryApplicationState(db, fixturelearning, sources)).toMatchObject({ kind: "review", reason: "possible_prior_application" });
  });

  it("uses exact normalized wording while preserving seniority and department distinctions", async () => {
    await known({ title: "Sr. Manager - Pricing" });
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "review" });
    for (const title of ["Manager, Pricing", "Senior Manager, Content", "Senior Manager, Pricing UK"]) {
      expect(await readDiscoveryApplicationState(db, { ...fixturepricing, title }, sources)).toEqual({ kind: "clear" });
    }
  });

  it("does not treat a substring employer as the same employer", async () => {
    await known({ employer: "One Fixture Pricing" });
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toEqual({ kind: "clear" });
  });

  it.each([
    { canonicalId: "greenhouse:fixturepricing:999" }, { req: "999" },
    { url: "https://job-boards.greenhouse.io/fixturepricing/jobs/999" }, { canonicalId: "unverified-import-id" },
  ])("does not hide a new requisition behind a same-title identified record %j", async extra => {
    await known(extra);
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toEqual({ kind: "clear" });
  });

  it("holds a pending live confirmation without promoting it to applied", async () => {
    await receipt();
    const before = (await db.prepare("SELECT * FROM lifecycle_receipts").all()).results;
    expect(await readDiscoveryApplicationState(db, fixturelearning, sources)).toMatchObject({ kind: "review", reason: "pending_confirmation" });
    expect((await db.prepare("SELECT * FROM lifecycle_receipts").all()).results).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 0 });
  });

  it.each([{ test: 1 }, { decision: "ignored" }, { decision: "undone" }, { decision: "answered" },
    { req: "999" }, { title: "Chief of Staff, Enterprise" }])("does not block discovery for inactive or different receipt %j", async extra => {
    await receipt(extra);
    expect(await readDiscoveryApplicationState(db, fixturelearning, sources)).toEqual({ kind: "clear" });
  });

  it.each(["passed", "applied", "needs_materials"])("protects an exact current %s job", async status => {
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,application_status,application_status_source)
      VALUES (?, 'Fixture Pricing', ?, ?, '2026-09-27', '2026-09-27', ?, 'manual')`)
      .bind(fixturepricing.id, fixturepricing.title, fixturepricing.url, status).run();
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "protected", reason: "user_disposition", status });
  });

  it("does not mislabel a saved machine match as a user decision", async () => {
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,match)
      VALUES (?, 'Fixture Pricing', ?, ?, '2026-09-27', '2026-09-27', 1)`).bind(fixturepricing.id, fixturepricing.title, fixturepricing.url).run();
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toEqual({ kind: "clear" });
  });

  it("recognizes a verified ATS application regardless of title spelling", async () => {
    await known({ canonicalId: fixturepricing.id, url: fixturepricing.url, title: "Other original spelling" });
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "protected", reason: "known_application", status: "applied" });
  });

  it("holds conflicting application claims rather than choosing one", async () => {
    await known({ canonicalId: fixturepricing.id }); await known({ canonicalId: fixturepricing.id });
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "review", reason: "ambiguous_application_identity" });
  });

  it.each([
    ["greenhouse:example-platform:123", "greenhouse:Example Platform:123"],
    ["greenhouse:Example Platform:123", "greenhouse:example-platform:123"],
  ])("recognizes applied identity %s when discovery uses %s", async (canonicalId, id) => {
    await known({ employer: "Example Platform", title: "Original application title", canonicalId });
    expect(await readDiscoveryApplicationState(db, { id, company: "Example Platform", title: "AI Operations",
      url: "https://boards.greenhouse.io/example-platform/jobs/123" }, sources))
      .toMatchObject({ kind: "protected", reason: "known_application", status: "applied" });
  });

  it("retains conflicting claims across fixed and canonical application IDs", async () => {
    await known({ employer: "Example Platform", canonicalId: "greenhouse:example-platform:123" });
    await known({ employer: "Example Platform", canonicalId: "greenhouse:Example Platform:123" });
    expect(await readDiscoveryApplicationState(db, { id: "greenhouse:example-platform:123", company: "Example Platform",
      title: "AI Operations", url: "https://boards.greenhouse.io/example-platform/jobs/123" }, sources))
      .toMatchObject({ kind: "review", reason: "ambiguous_application_identity" });
  });

  it("checks an applied ledger record owned by a proven URL alias", async () => {
    const owner = "employer:fixturepricing:700";
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
      VALUES (?, 'Fixture Pricing', ?, 'https://fixturepricing.com/careers/pricing','2026-09-27','2026-09-27')`)
      .bind(owner, fixturepricing.title).run();
    await db.prepare(`INSERT INTO discovery_job_aliases (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
      VALUES (?, ?, 'fixturepricing','700','https://fixturepricing.com/careers/pricing','2026-09-27')`)
      .bind(fixturepricing.url, owner).run();
    await known({ canonicalId: owner, title: "Original application title" });
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources))
      .toMatchObject({ kind: "protected", reason: "known_application", status: "applied" });
  });

  it("keeps Workday requisitions scoped to their tenant", async () => {
    await known({ employer: "Fixture Network", title: "Product Line Manager", req: "R702",
      url: "https://other.wd5.myworkdayjobs.com/Careers/job/Ottawa/Product-Line-Manager_R702" });
    expect(await readDiscoveryApplicationState(db, { id: "workday:fixture-network:r702", company: "Fixture Network", title: "Product Line Manager",
      url: "https://fixture-network.wd5.myworkdayjobs.com/Careers/job/Ottawa/Product-Line-Manager_R702" }, sources)).toEqual({ kind: "clear" });
  });
  it("does not merge Workday career sites through a shared canonical ID", async () => {
    await known({ employer: "Fixture Network", title: "Product Line Manager", canonicalId: "workday:fixture-network:r702",
      url: "https://fixture-network.wd5.myworkdayjobs.com/Internal/job/Ottawa/Product-Line-Manager_R702" });
    expect(await readDiscoveryApplicationState(db, { id: "workday:fixture-network:r702", company: "Fixture Network", title: "Product Line Manager",
      url: "https://fixture-network.wd5.myworkdayjobs.com/Careers/job/Ottawa/Product-Line-Manager_R702" }, sources)).toEqual({ kind: "clear" });
  });

  it("uses proven URL alias ownership without rewriting a passed owner's record", async () => {
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,application_status,application_status_source)
      VALUES ('employer:fixturepricing:700', 'Fixture Pricing', ?, 'https://fixturepricing.com/careers/pricing',
        '2026-09-27','2026-09-27','passed','manual')`).bind(fixturepricing.title).run();
    await db.prepare(`INSERT INTO discovery_job_aliases (alias,owner_job_id,employer_key,requisition_id,source_url,verified_at)
      VALUES (?, 'employer:fixturepricing:700','fixturepricing','700','https://fixturepricing.com/careers/pricing','2026-09-27')`)
      .bind(fixturepricing.url).run();
    expect(await readDiscoveryApplicationState(db, fixturepricing, sources)).toMatchObject({ kind: "protected", status: "passed",
      records: ["employer:fixturepricing:700"] });
    expect(await db.prepare("SELECT application_status FROM jobs WHERE id='employer:fixturepricing:700'").first())
      .toEqual({ application_status: "passed" });
  });

});
