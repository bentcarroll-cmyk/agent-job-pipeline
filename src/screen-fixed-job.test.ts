import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateFixedJob } from "./screen-fixed-job";
import { fetchAllPostings, fixedSourceCompanyCategory, type Source } from "./sources";
import { posting } from "../tests/fixtures/candidates";
afterEach(() => vi.unstubAllGlobals());
const company = "Fixture Boards";
const source = (ats: "ashby" | "lever"): Source => ({ ats, company, slug: "selected-board", companyCategory: "applied AI" });
const listing = (ats: "ashby" | "lever", slug = "selected-board", id = "abc") => posting({
  id: `${ats}:${company}:abc`, company, url: `https://jobs.${ats === "ashby" ? "ashbyhq.com" : "lever.co"}/${slug}/${id}` });
const amazon: Source = { ats: "amazon", company, category: "selected-category", companyCategory: "applied AI" };
describe("selected fixed-board identity", () => {
  it.each(["ashby", "lever"] as const)("accepts a proven %s board without refresh", async ats => {
    await expect(hydrateFixedJob(listing(ats), false, [source(ats)])).resolves.toEqual(listing(ats));
  });
  it.each([...[false, true].map(refresh => ["lever", refresh] as const), ["ashby", false] as const])(
    "rejects a changed same-company %s board before provider work (refresh=%s)", async (ats, refresh) => {
      const fetch = vi.fn(async () => { throw new Error("Unexpected provider call"); }); vi.stubGlobal("fetch", fetch);
      const job = listing(ats, "old-board");
      expect(fixedSourceCompanyCategory(job, [source(ats)])).toBeUndefined();
      await expect(hydrateFixedJob(job, refresh, [source(ats)])).rejects.toThrow(/source|identity/i);
      expect(fetch).not.toHaveBeenCalled();
    });
  it.each(["ashby", "lever"] as const)("rejects a mismatched %s posting identity without refresh", async ats => {
    await expect(hydrateFixedJob(listing(ats, "selected-board", "other-id"), false, [source(ats)])).rejects.toThrow(/source|identity/i);
  });
  it("retains Amazon facet provenance from the selected catalog and rejects a newly selected facet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [{ id: 123, title: "Operations", job_path: "/en/jobs/123/operations" }], hits: 1 })));
    const result = await fetchAllPostings([amazon]);
    expect(result.errors).toEqual([]);
    expect(result.jobs[0]).toHaveProperty("fixedSourceProvenance", { ats: "amazon", category: "selected-category" });
    await expect(hydrateFixedJob(result.jobs[0], false, [amazon])).resolves.toEqual(result.jobs[0]);
    const changed: Source = { ...amazon, category: "new-category" };
    expect(fixedSourceCompanyCategory(result.jobs[0], [changed])).toBeUndefined();
    await expect(hydrateFixedJob(result.jobs[0], false, [changed])).rejects.toThrow(/source|identity/i);
  });
  it("holds unsupported old Amazon contexts without facet provenance", async () => {
    const job = posting({ id: `amazon:${company}:123`, company, url: "https://www.amazon.jobs/en/jobs/123/operations" });
    await expect(hydrateFixedJob(job, false, [amazon])).rejects.toThrow(/source|identity/i);
  });
  it("reacquires Greenhouse detail from the selected board while preserving custom employer URLs", async () => {
    const greenhouse: Source = { ats: "greenhouse", company, slug: "selected-board", companyCategory: "applied AI" };
    const url = "https://careers.fixture.test/role?gh_jid=123";
    const job = posting({ id: `greenhouse:${company}:123`, company, url });
    const fetch = vi.fn(async () => Response.json({ id: 123, title: "Operations", absolute_url: url, content: "Complete synthetic posting" }));
    vi.stubGlobal("fetch", fetch);
    const detail = await hydrateFixedJob(job, false, [greenhouse]);
    expect(detail).toMatchObject({ id: job.id, company, url });
    expect(fetch).toHaveBeenCalledWith("https://boards-api.greenhouse.io/v1/boards/selected-board/jobs/123", expect.any(Object));
  });
});
