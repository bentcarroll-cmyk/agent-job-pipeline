import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { appliedApplicationForUrl, lookupKnownAtsApplication } from "../../src/db";

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
