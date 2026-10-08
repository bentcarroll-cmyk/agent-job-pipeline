import { hydrateFixedJob } from "../../src/screen-fixed-job";
import { previewDiscovery } from "../../src/discovery-preview";
import { describe, expect, it } from "vitest";
import * as queries from "../../src/discovery/queries";
import * as sources from "../../src/sources";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { BOSTON_ENGINEERING, CHICAGO_OPERATIONS, posting } from "../fixtures/candidates";

const banks = queries.buildQueryBanks;
describe("candidate discovery banks", () => {
  it.each([BOSTON_ENGINEERING, CHICAGO_OPERATIONS])("searches only the selected candidate phrases", async candidate => {
    const runtime = await loadRuntimeConfig(candidate);
    const selected = banks(runtime);
    expect(selected.baseline.map(q => q.terms[0])).toEqual(candidate.search.baselinePhrases);
    expect(selected.exploration.map(q => q.terms[0])).toEqual([...candidate.search.functionPhrases, ...candidate.search.openWebPhrases]);
    expect(selected.rotation.map(q => q.id).sort()).toEqual(selected.exploration.map(q => q.id).sort());
  });
  it("rejects empty phrase banks before a search starts", async () => {
    const runtime = await loadRuntimeConfig(BOSTON_ENGINEERING);
    const invalid = { ...runtime, candidate: { ...runtime.candidate, search: { ...runtime.candidate.search, baselinePhrases: [], functionPhrases: [], openWebPhrases: [] } } };
    expect(() => banks(invalid)).toThrow(/phrase|query|search/i);
  });
  it("binds fixed categories to the selected sources", () => {
    expect(sources.fixedSourceCompanyCategory(posting(), CHICAGO_OPERATIONS.search.sources)).toBe("applied AI");
    expect(sources.fixedSourceCompanyCategory(posting(), [])).toBeUndefined();
  });
});

// A source removed from the approved bank must not keep screening from a
// retained fixed-board listing, even when hydration needs no provider call.
it.each(["ashby", "lever", "amazon"])("rejects retained %s fixed jobs outside the selected source bank", async ats => {
  const job = posting({ id: `${ats}:Old Fixture:123`, company: "Old Fixture", url: ats === "amazon" ? "https://www.amazon.jobs/en/jobs/123/role" : `https://jobs.${ats === "ashby" ? "ashbyhq.com" : "lever.co"}/old-fixture/123` });
  await expect(hydrateFixedJob(job, false, CHICAGO_OPERATIONS.search.sources)).rejects.toThrow(/source|identity/i);
});
it("blocks unapproved preview phrases before discovery", async () => {
  const runtime = await loadRuntimeConfig(BOSTON_ENGINEERING);
  await expect(previewDiscovery({ runtime, maxPostings: 1, phrases: ["Operations"], apiKey: "synthetic" })).rejects.toThrow(/approval/i);
});
