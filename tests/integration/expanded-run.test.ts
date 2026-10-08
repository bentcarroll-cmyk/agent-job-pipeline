import { loadRuntimeConfig } from "../../src/config/candidate";
import { BOSTON_ENGINEERING, CHICAGO_OPERATIONS } from "../fixtures/candidates";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { acquireLease } from "../../src/operations/leases";
import { startDiscoveryRun } from "../../src/discovery/coverage";
import { runExpandedSearch } from "../../src/discovery/expanded-run";
import { buildExclusionSet } from "../../src/unbounded/discovery";
import { persistSearchPageHits } from "../../src/discovery/queue-integration";
import { candidateKeyFor } from "../../src/discovery/candidates";

describe("expanded search page orchestration", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
  afterEach(async () => { await dispose(); });

  it("freezes query rotation, records unsupported employer URLs and replays without provider calls", async () => {
    const lease = (await acquireLease(db, "unbounded_discovery", "expanded-1"))!;
    await startDiscoveryRun(db, lease, { runId: lease.owner, pipeline: lease.pipeline,
      codeVersion: "fixture", queryVersion: "discovery-q1", registryVersion: "none",
      startedAt: "2026-09-22T12:00:00Z" });
    const checkpoints = new Map<string, unknown>();
    const checkpoint = async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
      if (checkpoints.has(name)) return checkpoints.get(name) as T;
      const value = await callback(); checkpoints.set(name, value); return value;
    };
    let calls = 0;
    const provider = async (_key: string, request: {queryId:string;page:number}) => {
      calls++;
      return request.queryId === "open-001" && request.page === 1 ? { status: "complete" as const, results: [
        { link: "https://jobs.lever.co/fixture/abc", title: "Director" },
        { link: "https://careers.unknown.test/jobs/director", title: "Director" },
      ] } : { status: "complete" as const, results: [] };
    };
    const exclusion = buildExclusionSet([], []);
    const input = { db, lease, runtime: await loadRuntimeConfig(BOSTON_ENGINEERING), apiKey: "SYNTHETIC-QUERY-KEY", exclusion,
      checkpoint, provider, onPageHits: async ({ queryId, page, hits }: {
        queryId: string; page: number; hits: { status: "complete"; results: Array<{link:string;title:string}> } }) => {
        await persistSearchPageHits(db, lease, { queryId, page, hits: hits.results,
          discoveredAt: "2026-09-22T12:00:00Z", exclusion });
      } };
    const first = await runExpandedSearch(input);
    expect(first.refs.map(ref => ref.postingId)).toEqual(["abc"]);
    expect(first.report.usage).toEqual({ baselinePages: 1, explorationPages: 3 });
    expect(await db.prepare(`SELECT outcome,reason_code FROM discovery_url_observations
      WHERE normalized_url='https://careers.unknown.test/jobs/director'`).first())
      .toEqual({ outcome: "unsupported", reason_code: "unsupported_employer_url" });
    expect(await db.prepare(`SELECT status,source_id FROM discovery_candidates WHERE candidate_key=?`)
      .bind(await candidateKeyFor("https://careers.unknown.test/jobs/director", null)).first())
      .toEqual({ status: "pending", source_id: "open-001:1" });
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_candidates").first()).toEqual({ n: 2 });
    expect(calls).toBe(4);
    const replay = await runExpandedSearch(input);
    expect(replay.refs).toEqual(first.refs);
    expect(calls).toBe(4);
    expect(await db.prepare("SELECT count(*) AS n FROM discovery_candidates").first()).toEqual({ n: 2 });
    await expect(runExpandedSearch({ ...input, runtime: await loadRuntimeConfig(CHICAGO_OPERATIONS) })).rejects.toThrow(/configuration|version/i);
    expect(calls).toBe(4);
  });
});
