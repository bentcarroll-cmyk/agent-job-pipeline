import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { appliedApplicationForUrl, lookupKnownAtsApplication, lookupKnownEmployerApplication } from "../../src/db";
import { jobRefId, parseJobUrl, titleCaseSlug } from "../../src/unbounded/discovery";

let db: D1Database, dispose: () => Promise<void>;
beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
afterEach(async () => dispose());
async function known(canonicalId: string | null, url: string | null, employer = "Synthetic Co", status = "applied") {
  await db.prepare(`INSERT INTO known_applications (canonical_id,posting_url,employer,title,status,source)
    VALUES (?,?,?,'Original synthetic title',?,'synthetic')`).bind(canonicalId, url, employer, status).run();
}
describe("synthetic known-application identity", () => {
  it.each(["applied", "interviewing", "offer", "closed"])("recognizes exact ATS %s without adopting title spelling or changing the ledger", async status => {
    const url = "https://boards.greenhouse.io/synthetic/jobs/123";
    await known("greenhouse:synthetic:123", url, "Synthetic Co", status);
    const before = (await db.prepare("SELECT * FROM known_applications").all()).results;
    expect(await appliedApplicationForUrl(db, url)).toMatchObject({ status, title: "Original synthetic title" });
    expect((await db.prepare("SELECT * FROM known_applications").all()).results).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });
  });
  it("does not merge equal requisitions across employers or ATS platforms", async () => {
    await known("workday:synthetic:123", null, "Synthetic Co");
    expect(await appliedApplicationForUrl(db, "https://boards.greenhouse.io/other/jobs/123")).toBeNull();
    expect(await appliedApplicationForUrl(db, "https://careers.example.test/jobs?gh_jid=123")).toBeNull();
  });
  it("scopes Workday identity to its career site and tenant", async () => {
    await known("workday:synthetic:r123", "https://synthetic.wd5.myworkdayjobs.com/Internal/job/Boston/Engineer_R123");
    expect(await appliedApplicationForUrl(db, "https://synthetic.wd5.myworkdayjobs.com/Careers/job/Boston/Engineer_R123")).toBeNull();
    expect(await appliedApplicationForUrl(db, "https://other.wd5.myworkdayjobs.com/Internal/job/Boston/Engineer_R123")).toBeNull();
  });
  it("holds conflicting exact claims rather than picking the first application", async () => {
    const url = "https://boards.greenhouse.io/synthetic/jobs/123";
    await known("greenhouse:synthetic:123", url); await known("greenhouse:synthetic:123", url);
    expect(await lookupKnownAtsApplication(db, { jobId: "greenhouse:synthetic:123", postingId: "123", employerName: "Synthetic Co", postingUrl: url })).toEqual({ kind: "ambiguous" });
  });
  it("recognizes an embedded Greenhouse URL without treating preparation as submission", async () => {
    await known("456", "https://careers.example.test/job?gh_jid=456");
    expect(await appliedApplicationForUrl(db, "https://boards.greenhouse.io/synthetic/jobs/456")).toMatchObject({ status: "applied" });
    await known("greenhouse:synthetic:789", null, "Synthetic Co", "packet_ready");
    expect(await appliedApplicationForUrl(db, "https://boards.greenhouse.io/synthetic/jobs/789")).toBeNull();
  });
});

// The unbounded Worker's inputs for a search hit.
function searchHit(url: string) {
  const ref = parseJobUrl(url, "")!;
  return { jobId: jobRefId(ref), postingId: ref.postingId, employerName: titleCaseSlug(ref.slug), postingUrl: ref.url };
}

describe("known application identity by requisition and employer", () => {
  const postingUrl = "https://fixtureiota.wd5.myworkdayjobs.com/External/job/Remote/Operations-Manager_R1234";
  const shortLink = "https://to.indeed.com/aaexample0001";
  // An application recorded by its requisition number alone, as an import
  // from Indeed or an employer email leaves it.
  const recorded = (employer: string, url: string | null, extra: { canonicalId?: string; sourceJobId?: string } = {}) =>
    db.prepare(`INSERT INTO known_applications (canonical_id,employer,title,status,source,source_job_id,posting_url,requisition_id)
      VALUES (?,?,'Operations Manager','applied','synthetic',?,?,'R1234')`)
      .bind(extra.canonicalId ?? null, employer, extra.sourceJobId ?? "FIXTURE-1", url).run();
  const matched = { kind: "matched", application: { status: "applied", source_job_id: "FIXTURE-1" } };

  it.each([shortLink, "https://www.google.com/search?q=fixtureiota+operations+manager"])(
    "matches a requisition recorded with a link that names no posting: %s", async url => {
      await recorded("FixtureIota", url);
      expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toMatchObject(matched);
    });

  it.each(["FixtureIota / Fixture Iota Group", "Fixture Iota Group / FixtureIota", "FixtureIota, Inc."])(
    "matches a requisition whose employer is recorded as %s", async employer => {
      await recorded(employer, null);
      expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toMatchObject(matched);
    });

  it("matches a posting that names the employer by the other half of its recorded name", async () => {
    await recorded("FixtureIota / Fixture Iota Group", null);
    expect(await lookupKnownAtsApplication(db, { ...searchHit(postingUrl), employerName: "Fixture Iota Group" }))
      .toMatchObject(matched);
  });

  it("answers /job for an application recorded under two names with a short link", async () => {
    await recorded("FixtureIota / Fixture Iota Group", shortLink);
    expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toMatchObject(matched);
    expect(await appliedApplicationForUrl(db, postingUrl)).toMatchObject({ status: "applied",
      employer: "FixtureIota / Fixture Iota Group", title: "Operations Manager" });
  });

  it.each(["Other Employer", "FixtureIota Partners", "Other Employer / Somebody Else"])(
    "does not match the requisition at another employer: %s", async employer => {
      await recorded(employer, shortLink);
      expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toEqual({ kind: "none" });
    });

  it.each([
    "https://fixtureiota.wd5.myworkdayjobs.com/Other_Site/job/Remote/Operations-Manager_R1234",
    "https://job-boards.greenhouse.io/fixtureiota/jobs/1001",
    "https://www.fixtureiota.example.com/careers?gh_jid=1001",
  ])("does not match a requisition recorded with a link naming another posting: %s", async url => {
    await recorded("FixtureIota / Fixture Iota Group", url);
    expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toEqual({ kind: "none" });
  });

  // The identity an employer careers page resolves to.
  const employerPosting = { ownerJobId: "employer:fixtureiota:R1234", employerKey: "fixtureiota", employerName: "FixtureIota",
    requisitionId: "R1234", aliases: ["https://www.fixtureiota.example.com/careers/jobs/R1234"] };

  it.each(["FixtureIota / Fixture Iota Group", "Fixture Iota Group / FixtureIota", "FixtureIota, Inc."])(
    "matches an employer page's requisition recorded as %s", async employer => {
      await recorded(employer, shortLink);
      expect(await lookupKnownEmployerApplication(db, employerPosting))
        .toEqual({ kind: "matched", application: { status: "applied", source_job_id: "FIXTURE-1" } });
    });

  it.each(["Other Employer", "FixtureIota Partners", "Other Employer / Somebody Else"])(
    "does not match an employer page's requisition at another employer: %s", async employer => {
      await recorded(employer, shortLink);
      expect(await lookupKnownEmployerApplication(db, employerPosting)).toEqual({ kind: "none" });
    });

  it("matches an employer page by its owner id or a proven alias whatever the employer is called", async () => {
    await recorded("Somebody Else", null, { canonicalId: employerPosting.ownerJobId });
    expect(await lookupKnownEmployerApplication(db, employerPosting)).toMatchObject(matched);
    await db.prepare("DELETE FROM known_applications").run();
    await recorded("Somebody Else", employerPosting.aliases[0]);
    expect(await lookupKnownEmployerApplication(db, employerPosting)).toMatchObject(matched);
  });

  it("matches an employer whose whole name is words the ledger drops", async () => {
    await recorded("The Company", null);
    expect(await lookupKnownAtsApplication(db, { ...searchHit(postingUrl), employerName: "The Company" }))
      .toMatchObject(matched);
    expect(await lookupKnownEmployerApplication(db, { ...employerPosting, employerKey: "company", employerName: "The Company" }))
      .toMatchObject(matched);
  });

  it("asks for review when the employer's two names each claim the requisition", async () => {
    await recorded("FixtureIota", null);
    await recorded("FixtureIota / Fixture Iota Group", shortLink, { sourceJobId: "FIXTURE-2" });
    expect(await lookupKnownAtsApplication(db, searchHit(postingUrl))).toEqual({ kind: "ambiguous" });
    expect(await lookupKnownEmployerApplication(db, employerPosting)).toEqual({ kind: "ambiguous" });
  });
});
