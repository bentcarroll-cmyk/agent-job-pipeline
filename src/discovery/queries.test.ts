import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, candidateCriteriaVersion } from "../config/candidate";
import { BOSTON_ENGINEERING } from "../../tests/fixtures/candidates";
import { buildSearchQuery } from "../unbounded/discovery";
import { buildQueryBanks, compileQuery, selectExplorationQueries, companyQueryTemplates, type QuerySpec } from "./queries";
const open: QuerySpec = { id: "open-fixture", version: "fixture-v1", family: "open_web",
  mode: "all_terms", terms: ["careers", "software", "engineering"], hosts: [], recency: "month", employerKey: null };
describe("configured versioned queries", () => {
  it("preserves ATS baseline syntax, month filtering and page identity", async () => {
    const runtime = await loadRuntimeConfig(BOSTON_ENGINEERING);
    const banks = buildQueryBanks(runtime);
    expect(compileQuery(banks.baseline[0], 2)).toEqual({ queryId: "baseline-001", page: 2,
      q: buildSearchQuery("Software engineering"), tbs: "qdr:m" });
    expect(banks.baseline[0].version).toBe(`q-${runtime.criteriaVersion}`);
    expect(Object.isFrozen(banks.baseline[0].terms)).toBe(true);
  });
  it("retains open-web and explicit catch-up request syntax", () => {
    expect(compileQuery(open, 2)).toEqual({ queryId: "open-fixture", page: 2, q: "careers software engineering", tbs: "qdr:m" });
    expect(compileQuery({ ...open, family: "catchup", recency: "any" }, 1)).not.toHaveProperty("tbs");
  });
  it("requires registry membership and matching trusted hosts for company queries", () => {
    const employer = { key: "fixture", careerHosts: ["careers.fixture.test"], verified: true };
    const query = companyQueryTemplates(employer, ["Software engineering"])[0];
    expect(() => compileQuery(query, 1)).toThrow(/registry/i);
    expect(compileQuery(query, 1, [employer]).q).toBe("site:careers.fixture.test Software engineering");
    expect(() => compileQuery(query, 1, [{ ...employer, careerHosts: ["other.fixture.test"] }])).toThrow(/host/i);
  });
  it("rejects query operators, unsafe hosts and invalid page inputs", () => {
    expect(() => compileQuery({ ...open, terms: ["engineering site:evil.test"] }, 1)).toThrow(/term/i);
    expect(() => compileQuery({ ...open, hosts: ["careers.fixture.test/path"] }, 1)).toThrow(/host/i);
    expect(() => compileQuery({ ...open, hosts: ["careers.fixture.test OR site:evil.test"] }, 1)).toThrow(/host/i);
    expect(() => compileQuery(open, 0)).toThrow(/page/i);
    expect(() => compileQuery({ ...open, terms: [] }, 1)).toThrow(/term/i);
  });
  it.each([[7, 2], [1, 4], [3, 0], [0, 3]])("rotates unequal banks without losing or duplicating phrases (%i functions, %i open)", async (functions, opens) => {
    const candidate = structuredClone(BOSTON_ENGINEERING);
    candidate.search.functionPhrases = Array.from({ length: functions }, (_, i) => `Engineering ${i}`);
    candidate.search.openWebPhrases = Array.from({ length: opens }, (_, i) => `Careers ${i}`);
    candidate.approval.configSha256 = await candidateCriteriaVersion(candidate);
    const banks = buildQueryBanks(await loadRuntimeConfig(candidate));
    expect(banks.rotation.map(q => q.id).sort()).toEqual(banks.exploration.map(q => q.id).sort());
    const size = Math.min(2, banks.rotation.length);
    const selected = selectExplorationQueries(banks.rotation, banks.rotation.length - 1, size);
    expect(selected.queries[0]).toEqual(banks.rotation.at(-1));
    if (size === 2) expect(selected.queries[1]).toEqual(banks.rotation[0]);
    expect(() => selectExplorationQueries(banks.rotation, 0, banks.rotation.length + 1)).toThrow(/limit/i);
  });
});
