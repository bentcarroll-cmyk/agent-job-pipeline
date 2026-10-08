import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseCandidateConfig, candidatePolicyHash, candidateCriteriaVersion, loadRuntimeConfig } from "../../src/config/candidate";
import { CHICAGO_OPERATIONS, BOSTON_ENGINEERING, UK_REVIEW } from "../fixtures/candidates";
const clone = () => structuredClone(CHICAGO_OPERATIONS);
describe("candidate config", () => {
  it("rejects_mutated_approved_config", async () => {
    const changed = clone(); changed.policy.compensation.minimumBase = 180000;
    await expect(loadRuntimeConfig(changed)).rejects.toThrow(/approval/i);
  });
  it("rejects search mutations even when policy remains approved", async () => {
    const changed = clone(); changed.search = { ...changed.search, baselinePhrases: ["different search"] };
    await expect(loadRuntimeConfig(changed)).rejects.toThrow(/approval/i);
  });
  it("canonical_hash_ignores_key_order", async () => {
    const c = CHICAGO_OPERATIONS;
    const reordered = { approval: c.approval, search: c.search, policy: c.policy, identity: { subdivisionCode: c.identity.subdivisionCode, countryCode: c.identity.countryCode, displayName: c.identity.displayName }, schemaVersion: c.schemaVersion };
    expect(await candidateCriteriaVersion(parseCandidateConfig(reordered))).toBe(c.approval.configSha256);
    expect(await candidatePolicyHash(c.policy)).toBe(c.approval.policySha256);
  });
  it("activates independent approved examples and keeps distinct versions", async () => {
    const versions = await Promise.all([CHICAGO_OPERATIONS, BOSTON_ENGINEERING, UK_REVIEW].map(async c => (await loadRuntimeConfig(c)).criteriaVersion));
    expect(new Set(versions).size).toBe(3);
    for (const name of ["chicago-operations", "boston-engineering", "uk-review"]) {
      const c = JSON.parse(readFileSync(new URL(`../../examples/${name}.candidate.json`, import.meta.url), "utf8"));
      expect((await loadRuntimeConfig(c)).criteriaVersion).toBe(c.approval.configSha256);
    }
  });
  it("hashes an independently canonicalized policy", async () => {
    const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    expect(await candidatePolicyHash(CHICAGO_OPERATIONS.policy)).toBe(createHash("sha256").update(JSON.stringify(canonical(CHICAGO_OPERATIONS.policy))).digest("hex"));
  });
  it("returns deeply immutable copies", async () => {
    const raw = clone(); const runtime = await loadRuntimeConfig(raw);
    raw.policy.compensation.minimumBase = 1;
    expect(runtime.candidate.policy.compensation.minimumBase).toBe(100000);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.candidate.search.sources[0])).toBe(true);
    expect(() => (runtime.candidate.policy.employmentTypes as string[]).push("contract")).toThrow();
  });
  it.each([
    ["missing currency", (c: any) => delete c.policy.compensation.currency],
    ["invalid currency", (c: any) => c.policy.compensation.currency = "XYZ"],
    ["invalid pay", (c: any) => c.policy.compensation.minimumBase = "100000"],
    ["negative pay", (c: any) => c.policy.compensation.minimumBase = -1],
    ["non-finite pay", (c: any) => c.policy.compensation.minimumBase = Infinity],
    ["unsupported period", (c: any) => c.policy.compensation.period = "hour"],
    ["empty employment", (c: any) => c.policy.employmentTypes = []],
    ["empty lanes", (c: any) => c.policy.functionLanes = []],
    ["duplicate lanes", (c: any) => c.policy.functionLanes.push(c.policy.functionLanes[0])],
    ["empty search", (c: any) => { c.search.baselinePhrases=[]; c.search.functionPhrases=[]; c.search.openWebPhrases=[]; c.search.sources=[]; c.search.registry=[]; }],
    ["missing flag", (c: any) => delete c.policy.location.allowRemote],
    ["no arrangement", (c: any) => Object.assign(c.policy.location, {allowRemote:false,allowOnsite:false,allowHybrid:false})],
    ["invalid country", (c: any) => c.identity.countryCode = "ZZ"],
    ["invalid subdivision", (c: any) => c.identity.subdivisionCode = "America/Chicago"],
    ["contradictory geography", (c: any) => c.policy.location.countryCode = "GB"],
    ["empty approval", (c: any) => c.approval.policySha256 = ""],
    ["invalid approval date", (c: any) => c.approval.approvedAt = "2026-02-30T12:00:00Z"],
    ["unexpected secret", (c: any) => c.apiKey = "synthetic-key"],
    ["unsupported source", (c: any) => c.search.sources[0].ats = "unknown"],
    ["invalid category", (c: any) => c.policy.functionLanes[0].companyCategories = ["unknown"]],
    ["malformed registry", (c: any) => c.search.registry = [{key:"example"}]],
  ])("rejects %s without defaults", (_name, mutate) => { const raw = clone(); mutate(raw); expect(() => parseCandidateConfig(raw)).toThrow(); });
  it("validates a detached snapshot even if input getters change", () => {
    const c: any = clone(); let reads = 0;
    Object.defineProperty(c.identity, "displayName", {enumerable:true, get: () => ++reads === 1 ? "Alex Example" : ""});
    const parsed = parseCandidateConfig(c);
    expect(parsed.identity.displayName).toBe("Alex Example");
    expect(reads).toBe(1);
  });
  it("keeps the activation snapshot stable during async hashing", async () => {
    const c = clone(); const pending = loadRuntimeConfig(c);
    c.policy.compensation.minimumBase = 1;
    expect((await pending).candidate.policy.compensation.minimumBase).toBe(100000);
  });
  it("validates all configured source adapters and registry entries", () => {
    const c: any = clone();
    c.search.sources = [
      {company:"Example",companyCategory:"applied AI",ats:"ashby",slug:"example"},
      {company:"Example",companyCategory:"applied AI",ats:"lever",slug:"example"},
      {company:"Example",companyCategory:"applied AI",ats:"workday",tenant:"example",wdHost:"wd5",site:"Careers",searchTerms:["engineer"]},
      {company:"Example",companyCategory:"applied AI",ats:"amazon",category:"example-category"},
    ];
    c.search.registry = [{key:"example",name:"Example",careerHosts:["example.com"],atsHosts:["jobs.example.com"],evidenceUrl:"https://example.com/careers",verifiedAt:"2026-01-01T00:00:00Z",adapter:"jobposting",boardUrl:null}];
    expect(parseCandidateConfig(c).search.sources).toHaveLength(4);
  });
  it("preserves explicit unknown pay", () => expect(parseCandidateConfig(UK_REVIEW).policy.compensation.minimumBase).toBeNull());
  it("requires full approval even if policy hash is refreshed", async () => {
    const c = clone(); c.policy.compensation.minimumBase = 180000;
    c.approval.policySha256 = await candidatePolicyHash(c.policy);
    await expect(loadRuntimeConfig(c)).rejects.toThrow(/approval/i);
  });
});
