import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { configureEnv } from "../../src/config/env";
import { BOSTON_ENGINEERING, CHICAGO_OPERATIONS } from "../fixtures/candidates";
import { configuredSources, configuredRegistry } from "../../src/config/sources";
import { candidateCriteriaVersion } from "../../src/config/candidate";
const instance = JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
const bindings = (candidate = BOSTON_ENGINEERING) => ({ CANDIDATE_CONFIG: JSON.stringify(candidate), INSTANCE_CONFIG: JSON.stringify(instance) });
describe("independent runtime entry loading", () => {
  it("loads detached immutable snapshots without mutating bindings or resource handles", async () => {
    const DB = { marker: "synthetic handle" };
    const raw = { ...bindings(), DB };
    const env = await configureEnv(raw);
    expect(env.DB).toBe(DB);
    expect(raw).not.toHaveProperty("runtime");
    expect(Object.isFrozen(env.runtime.candidate.search.sources[0])).toBe(true);
    const other = await configureEnv(bindings(CHICAGO_OPERATIONS));
    expect(env.runtime.candidate.search.baselinePhrases).toEqual(["Software engineering"]);
    expect(other.runtime.candidate.search.baselinePhrases).toEqual(["Operations"]);
  });
  it("rejects missing bindings, changed search approval, malformed JSON and draft activation", async () => {
    await expect(configureEnv({ ...bindings(), CANDIDATE_CONFIG: undefined } as any)).rejects.toThrow(/bindings/i);
    const changed = structuredClone(BOSTON_ENGINEERING); changed.search.baselinePhrases = ["Changed engineering"];
    await expect(configureEnv(bindings(changed))).rejects.toThrow(/approval/i);
    await expect(configureEnv({ ...bindings(), CANDIDATE_CONFIG: "{" })).rejects.toThrow();
    await expect(configureEnv({ ...bindings(), INSTANCE_CONFIG: JSON.stringify({ ...instance, cloudflare: { ...instance.cloudflare, databaseId: null } }) })).rejects.toThrow(/databaseId/i);
  });
  it("selects only the explicitly approved source and registry arrays", async () => {
    const candidate = structuredClone(BOSTON_ENGINEERING);
    candidate.search.registry = [{ key: "synthetic", name: "Synthetic Engineering", careerHosts: ["careers.synthetic.test"], atsHosts: [], adapter: "jobposting", boardUrl: null, evidenceUrl: "https://careers.synthetic.test/jobs/17", verifiedAt: "2026-01-02T12:00:00Z" }];
    candidate.approval.configSha256 = await candidateCriteriaVersion(candidate);
    const env = await configureEnv(bindings(candidate));
    expect(configuredSources(env.runtime)).toEqual(candidate.search.sources);
    expect(configuredRegistry(env.runtime)).toEqual(candidate.search.registry);
    const other = await configureEnv(bindings(CHICAGO_OPERATIONS));
    expect(configuredRegistry(other.runtime)).toEqual([]);
  });
});
