import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
} }));
import { baselineSources } from "../../src/discovery/baseline";
import { AgentWorkflow } from "../../src/index";
import { createDatabase, loadSchema } from "./harness";
import { acquireLease, releaseLease } from "../../src/operations/leases";
import { persistFixedCandidate } from "../../src/discovery/fixed-candidates";
import { candidateCriteriaVersion } from "../../src/config/candidate";
import { CHICAGO_OPERATIONS, posting } from "../fixtures/candidates";
import type { Source } from "../../src/sources";
const at = "2026-01-02T12:00:00Z";
const oldSource: Source = { ats: "amazon", company: "Fixture Boards", category: "old-category", companyCategory: "applied AI" };
describe("durable unsupported fixed-source holds", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
  afterEach(async () => { vi.unstubAllGlobals(); await dispose(); });
  it.each(["changed_category", "missing_provenance", "known_application"])("handles retained Amazon %s before board refresh retry classification", async reason => {
    const job = { ...posting(), id: "amazon:Fixture Boards:123", company: "Fixture Boards", url: "https://www.amazon.jobs/en/jobs/123/role",
      fixedSourceProvenance: { ats: "amazon" as const, category: "old-category" } };
    const prior = (await acquireLease(db, "fixed_boards", "prior"))!;
    await persistFixedCandidate(db, prior, job, "amazon:Fixture Boards", at, [oldSource]);
    const retained = await db.prepare("SELECT fixed_context_json FROM discovery_candidates WHERE candidate_key=?")
      .bind(job.id).first<{ fixed_context_json: string }>();
    expect(JSON.parse(retained!.fixed_context_json).fixedSourceProvenance).toEqual(job.fixedSourceProvenance);
    if (reason !== "changed_category") {
      const { fixedSourceProvenance: _provenance, ...legacy } = job;
      await db.prepare("UPDATE discovery_candidates SET fixed_context_json=? WHERE candidate_key=?").bind(JSON.stringify(legacy), job.id).run();
    }
    await releaseLease(db, prior);
    // Unrelated rows do not establish fixed-board baseline completion.
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
      VALUES ('unrelated','Fixture Other','Baseline','https://fixture.test/job',?,?)`).bind(at, at).run();
    if (reason === "known_application") await db.prepare(`INSERT INTO known_applications
      (employer,title,status,source,canonical_id,posting_url) VALUES ('Fixture Boards','Operations','applied','fixture',?,?)`).bind(job.id, job.url).run();
    const candidate = structuredClone(CHICAGO_OPERATIONS);
    candidate.search.sources = [{ ...oldSource, category: reason === "changed_category" ? "new-category" : "old-category" }];
    candidate.approval.configSha256 = await candidateCriteriaVersion(candidate);
    await db.prepare("INSERT INTO fixed_baselines VALUES (?,?,?)").bind("example-instance", baselineSources(candidate.search.sources), at).run();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.startsWith("https://www.amazon.jobs/en/search.json")) return Response.json({ jobs: [], hits: 0 });
      if (input === "https://slack.com/api/chat.postMessage") return Response.json({ ok: true, ts: "synthetic" });
      throw new Error(`Unexpected provider: ${input}`);
    }));
    const env = { DB: db, CANDIDATE_CONFIG: JSON.stringify(candidate),
      INSTANCE_CONFIG: readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"), CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111" }, DISCOVERY_ACCOUNTING_MODE: "on", DISCOVERY_QUEUE_MODE: "on", SCREENING_MODE: "legacy",
      SLACK_BOT_TOKEN: "synthetic", SLACK_CHANNEL_ID: "CEXAMPLE123" };
    const steps = { do: async (_name: string, ...args: any[]) => args.at(-1)(), sleep: async () => {} };
    const workflow = new AgentWorkflow({} as any, env as any);
    await workflow.run({ instanceId: "current", payload: {} } as any, steps as any);
    const state = await db.prepare("SELECT status,failure_category,next_attempt_at FROM discovery_candidates WHERE candidate_key=?")
      .bind(job.id).first();
    expect(state).toEqual(reason === "known_application" ? { status: "complete", failure_category: null, next_attempt_at: 0 }
      : { status: "held", failure_category: "source_identity_review", next_attempt_at: 0 });
    if (reason === "known_application") expect(await db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(job.id).first())
      .toEqual({ application_status: "applied" });
    else expect(await db.prepare("SELECT id FROM jobs WHERE id=?").bind(job.id).first()).toBeNull();
  });
});
