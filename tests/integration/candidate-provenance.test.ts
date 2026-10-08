import { baselineSources } from "../../src/discovery/baseline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { getPendingNotifications, isLegacyNotificationPending } from "../../src/db";
import { getPendingScreeningNotifications, isScreeningNotificationPending } from "../../src/screening/store";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { BOSTON_ENGINEERING, CHICAGO_OPERATIONS, posting, decision } from "../fixtures/candidates";
import { insertJobs, setApplicationStatus, type JobInsert } from "../../src/db";
import { createEvaluation, saveScreeningResult } from "../../src/screening/store";
import { createPostingSnapshot } from "../../src/screening/snapshot";
import { acquireLease } from "../../src/operations/leases";
import { vi } from "vitest";
import { acceptIntake, claimAndSaveJob, saveAdvisory } from "../../src/intake/store";
import { claimManualDelivery, isManualDeliveryCurrent } from "../../src/intake/delivery-store";
import { AgentWorkflow } from "../../src/index";
import { UnboundedAgentWorkflow } from "../../src/unbounded/index";
import { ManualIntakeWorkflow, executeManualDelivery } from "../../src/intake/workflow";
import { LifecycleWorkflow } from "../../src/lifecycle/workflow";
import { RadarWorkflow } from "../../src/radar/workflow";
import { readFileSync } from "node:fs";
import { fact } from "../fixtures/policy-postings";


let db: D1Database;
let dispose: () => Promise<void>;
beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
afterEach(async () => dispose());

describe("candidate provenance", () => {
  it("treats existing null provenance as stale in both list and actual send checks", async () => {
    await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,match)
      VALUES ('old','Synthetic','Operations','https://example.test/old','2026-01-01','2026-01-01',1)`).run();
    expect(await getPendingNotifications(db, "fixed_board", 10)).toEqual([]);
    expect(await getPendingScreeningNotifications(db, "fixed_board", 10)).toEqual([]);
    expect(await isLegacyNotificationPending(db, "old", "fixed_boards")).toBe(false);
    expect(await isScreeningNotificationPending(db, "old", undefined, "fixed_boards")).toBe(false);
  });
});


const instanceId = "synthetic-instance";
async function configs() {
  return { a: await loadRuntimeConfig(CHICAGO_OPERATIONS), b: await loadRuntimeConfig(BOSTON_ENGINEERING) };
}
function row(criteriaVersion: string, id = "greenhouse:Example Automation:123"): JobInsert {
  return { job: posting({ id }), criteriaVersion, firstSeenAt: "2026-01-01T00:00:00Z",
    isKnownApplication: false, knownApplicationSource: null,
    verdict: { match: true, lane: "A", hard_exclude: null, reason: "Synthetic fit" },
    applicationStatus: "not_applied", applicationStatusSource: "pipeline", deferNotifiedAt: true };
}

describe("immutable admission versus explicit current activation", () => {
  it("pins A on replay under B while old Worker A cannot deliver A as current B", async () => {
    const { admitRunConfig, activateCandidateConfig, readActiveCandidateConfig, isCurrentCriteria } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    const pinned = await admitRunConfig(db, "run-A", a);
    expect(await activateCandidateConfig(db, instanceId, a, null)).toBe(1);
    await insertJobs(db, [row(pinned.criteriaVersion)]);
    expect((await getPendingNotifications(db, "fixed_board", 10, null, instanceId)).map(item => item.job.id)).toEqual(["greenhouse:Example Automation:123"]);
    const before = await db.prepare("SELECT * FROM candidate_run_configs WHERE run_id='run-A'").first();
    expect(await activateCandidateConfig(db, instanceId, b, 1)).toBe(2);
    const replay = await admitRunConfig(db, "run-A", b);
    expect(replay.criteriaVersion).toBe("d5c13c7f8c8abbc3dc82f607241ac34aa14b2b0b5f4fb212944fa8e72406f7e6");
    expect(replay.candidate.policy.compensation.minimumBase).toBe(100000);
    expect(Object.isFrozen(replay.candidate.policy)).toBe(true);
    expect(await db.prepare("SELECT * FROM candidate_run_configs WHERE run_id='run-A'").first()).toEqual(before);
    expect(isCurrentCriteria(replay.criteriaVersion, b)).toBe(false);
    expect(isCurrentCriteria(null as unknown as string, replay)).toBe(false);
    expect(await readActiveCandidateConfig(db, instanceId)).toMatchObject({ criteriaVersion: b.criteriaVersion, revision: 2 });
    expect(await getPendingNotifications(db, "fixed_board", 10, null, instanceId)).toEqual([]);
    expect(await isLegacyNotificationPending(db, row(a.criteriaVersion).job.id, "fixed_boards", instanceId)).toBe(false);
    expect(await getPendingScreeningNotifications(db, "fixed_board", 10, null, instanceId)).toEqual([]);
  });

  it("serializes only approved candidate data and rejects a falsified runtime hash", async () => {
    const { admitRunConfig } = await import("../../src/config/run-context");
    const { a } = await configs();
    await admitRunConfig(db, "safe", { ...a, DB: db, AI: { secret: "fake-secret-do-not-store" } } as typeof a);
    const saved = await db.prepare("SELECT config_json FROM candidate_run_configs").first<{config_json:string}>();
    expect(Object.keys(JSON.parse(saved!.config_json)).sort()).toEqual(["candidate", "criteriaVersion"]);
    expect(saved!.config_json).not.toContain("fake-secret");
    await expect(admitRunConfig(db, "invalid", { ...a, criteriaVersion: "x".repeat(64) })).rejects.toThrow(/version/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM candidate_run_configs").first()).toEqual({ n: 1 });
  });

  it("admits exactly one snapshot when deployments race and never activates from admission", async () => {
    const { admitRunConfig, readActiveCandidateConfig } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    const admitted = await Promise.all([admitRunConfig(db, "race", a), admitRunConfig(db, "race", b)]);
    expect(admitted[0].criteriaVersion).toBe(admitted[1].criteriaVersion);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM candidate_run_configs").first()).toEqual({ n: 1 });
    expect(await readActiveCandidateConfig(db, instanceId)).toBeNull();
  });

  it("requires the exact active revision for activation and scopes currentness by instance", async () => {
    const { activateCandidateConfig, readActiveCandidateConfig } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    await activateCandidateConfig(db, instanceId, a, null);
    const results = await Promise.allSettled([activateCandidateConfig(db, instanceId, b, 1), activateCandidateConfig(db, instanceId, a, 1)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(activateCandidateConfig(db, instanceId, a, null)).rejects.toThrow(/changed|revision/);
    await expect(activateCandidateConfig(db, instanceId, b, 0)).rejects.toThrow(/revision/);
    expect((await readActiveCandidateConfig(db, instanceId))?.revision).toBe(2);
    await insertJobs(db, [row(a.criteriaVersion)]);
    expect(await getPendingNotifications(db, "fixed_board", 10, null, "another-instance")).toEqual([]);
  });

  it("retains immutable A evidence while an old replay cannot replace B projection or pending cards", async () => {
    const { activateCandidateConfig, admitRunConfig } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    await activateCandidateConfig(db, instanceId, a, null);
    await admitRunConfig(db, "run-A", a);
    const job = posting();
    const snapshot = await createPostingSnapshot(job, "applied AI");
    const ea = await createEvaluation({ jobId: job.id, runId: "run-A", snapshot,
      decision: decision({ state: "match", criteriaVersion: a.criteriaVersion }), evaluatedAt: "2026-01-01T00:00:00Z" });
    await saveScreeningResult(db, row(a.criteriaVersion), ea, undefined, instanceId);
    expect((await getPendingScreeningNotifications(db, "fixed_board", 10, null, instanceId)).map(item => item.evaluationId)).toEqual([ea.id]);
    await activateCandidateConfig(db, instanceId, b, 1);
    expect(await isScreeningNotificationPending(db, job.id, ea.id, "fixed_boards", instanceId)).toBe(false);
    const eb = await createEvaluation({ jobId: job.id, runId: "run-B", snapshot,
      decision: decision({ state: "no_match", criteriaVersion: b.criteriaVersion }), evaluatedAt: "2026-01-02T00:00:00Z" });
    await saveScreeningResult(db, row(b.criteriaVersion), eb, undefined, instanceId);
    const replay = await admitRunConfig(db, "run-A", b);
    const lateA = await createEvaluation({ jobId: job.id, runId: "late-A", snapshot,
      decision: decision({ state: "match", criteriaVersion: replay.criteriaVersion }), evaluatedAt: "2026-01-03T00:00:00Z" });
    await saveScreeningResult(db, row(replay.criteriaVersion), lateA, undefined, instanceId);
    expect(await db.prepare("SELECT evaluation_id FROM job_screening_current").first()).toEqual({ evaluation_id: eb.id });
    expect(await db.prepare("SELECT match,criteria_version FROM jobs").first()).toEqual({ match: 0, criteria_version: b.criteriaVersion });
    expect(await db.prepare("SELECT criteria_version FROM job_evaluations WHERE id=?").bind(ea.id).first()).toEqual({ criteria_version: a.criteriaVersion });
    expect(await getPendingScreeningNotifications(db, "fixed_board", 10, null, instanceId)).toEqual([]);
  });

  it.each(["applied", "interviewing", "offer", "passed", "not_pursuing", "needs_materials"])("preserves the latest %s disposition across policy change and replay", async status => {
    const { activateCandidateConfig } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    await activateCandidateConfig(db, instanceId, a, null);
    await insertJobs(db, [row(a.criteriaVersion)]);
    const id = row(a.criteriaVersion).job.id;
    await setApplicationStatus(db, id, status, "manual", "2026-01-02");
    const before = await db.prepare("SELECT application_status,application_status_source,application_status_updated_at,notified_at FROM jobs").first();
    await activateCandidateConfig(db, instanceId, b, 1);
    await insertJobs(db, [row(b.criteriaVersion)]);
    const snapshot = await createPostingSnapshot(posting(), "applied AI");
    const evaluation = await createEvaluation({ jobId: id, runId: "new-policy", snapshot, decision: decision({ state: "no_match", criteriaVersion: b.criteriaVersion }) });
    await saveScreeningResult(db, row(b.criteriaVersion), evaluation, undefined, instanceId);
    expect(await db.prepare("SELECT application_status,application_status_source,application_status_updated_at,notified_at FROM jobs").first()).toEqual(before);
    expect(await getPendingNotifications(db, "fixed_board", 10, null, instanceId)).toEqual([]);
  });
});

it("fences a memoized manual card after active policy changes without downgrading its selection", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  const id = "a".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, a, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at, undefined, a.criteriaVersion);
  await saveAdvisory(db, id, 0, row(a.criteriaVersion).verdict, null, at, a.criteriaVersion);
  const prepared = await claimManualDelivery(db, id, 0, at, instanceId);
  expect(prepared?.deliveryId).toBe(`manual:${posting().id}`);
  expect(await isManualDeliveryCurrent(db, prepared!.deliveryId, 0, instanceId, a.criteriaVersion)).toBe(true);
  await activateCandidateConfig(db, instanceId, b, 1);
  expect(await isManualDeliveryCurrent(db, prepared!.deliveryId, 0, instanceId, a.criteriaVersion)).toBe(false);
  expect(await db.prepare("SELECT application_status,application_status_source FROM jobs").first()).toEqual({ application_status: "needs_materials", application_status_source: "manual" });
});

it("holds a historical manual advisory without provenance", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a } = await configs();
  const id = "b".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, a, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at);
  await saveAdvisory(db, id, 0, row(a.criteriaVersion).verdict, null, at);
  expect(await claimManualDelivery(db, id, 0, at, instanceId)).toBeNull();
});

it("lets an active B assessment replace stale A even when historical timestamps are ahead", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  const snapshot = await createPostingSnapshot(posting(), "applied AI");
  await activateCandidateConfig(db, instanceId, a, null);
  const ea = await createEvaluation({ jobId: posting().id, runId: "future-A", snapshot,
    decision: decision({ state: "match", criteriaVersion: a.criteriaVersion }), evaluatedAt: "2026-12-01T00:00:00Z" });
  await saveScreeningResult(db, row(a.criteriaVersion), ea, undefined, instanceId);
  await activateCandidateConfig(db, instanceId, b, 1);
  const eb = await createEvaluation({ jobId: posting().id, runId: "current-B", snapshot,
    decision: decision({ state: "no_match", criteriaVersion: b.criteriaVersion }), evaluatedAt: "2026-01-01T00:00:00Z" });
  await saveScreeningResult(db, row(b.criteriaVersion), eb, undefined, instanceId);
  expect(await db.prepare("SELECT evaluation_id FROM job_screening_current").first()).toEqual({ evaluation_id: eb.id });
});

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
} }));
const instance = { ...JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8")), instanceId };
const immediateSteps = { do: async (_name: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(), sleep: async () => {} };
const rawBindings = (candidate = CHICAGO_OPERATIONS) => ({ DB: db, CANDIDATE_CONFIG: JSON.stringify(candidate), INSTANCE_CONFIG: JSON.stringify(instance),
  SCREENING_MODE: "legacy", SHADOW_MODE: "false", SLACK_CHANNEL_ID: "CEXAMPLE123", SLACK_BOT_TOKEN: "synthetic-token", AI_GATEWAY_ID: "synthetic",
  LIFECYCLE_MODE: "off", RADAR_CHANNEL_ID: "", SERPER_API_KEY: "synthetic-key" });

it.each([["fixed", AgentWorkflow], ["unbounded", UnboundedAgentWorkflow], ["intake", ManualIntakeWorkflow], ["lifecycle", LifecycleWorkflow], ["radar", RadarWorkflow]] as const)(
  "%s independently admits and replays policy without changing active B", async (name, Workflow) => {
    const { activateCandidateConfig, readActiveCandidateConfig } = await import("../../src/config/run-context");
    const { a, b } = await configs();
    const event = { instanceId: `entry-${name}`, payload: { requestId: "missing", generation: 0 } };
    const stoppedSteps = { do: async () => { throw new Error("test stops at operational boundary"); } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = new Workflow({} as any, rawBindings() as any).run(event as any, stoppedSteps as any);
      if (["fixed", "unbounded"].includes(name)) await expect(first).rejects.toThrow(/operational boundary/);
      else await first;
      const admitted = await db.prepare("SELECT criteria_version,config_json,admitted_at FROM candidate_run_configs WHERE run_id=?").bind(event.instanceId).first();
      expect(admitted).toMatchObject({ criteria_version: a.criteriaVersion });
      await activateCandidateConfig(db, instanceId, b, null);
      const replay = new Workflow({} as any, rawBindings(BOSTON_ENGINEERING) as any).run(event as any, stoppedSteps as any);
      if (["fixed", "unbounded"].includes(name)) await expect(replay).rejects.toThrow(/operational boundary/);
      else await replay;
      expect(await db.prepare("SELECT criteria_version,config_json,admitted_at FROM candidate_run_configs WHERE run_id=?").bind(event.instanceId).first()).toEqual(admitted);
      expect(await readActiveCandidateConfig(db, instanceId)).toEqual({ criteriaVersion: b.criteriaVersion, revision: 1 });
    } finally { vi.restoreAllMocks(); }
  });

it.each([
  ["Chicago operations", CHICAGO_OPERATIONS, "Chicago, IL", "Operations manager", "Annual base salary USD 110,000 - USD 120,000", "Lead operations and improve workflows."],
  ["Boston engineering", BOSTON_ENGINEERING, "Boston, MA", "Engineering manager", "Annual base salary USD 170,000 - USD 190,000", "Build software and lead engineering delivery."],
])("runs the complete fixed workflow for %s through fake source/model/Slack and Miniflare D1", async (label, candidate, location, title, salary, body) => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const runtime = await loadRuntimeConfig(candidate);
  await activateCandidateConfig(db, instanceId, runtime, null);
  // Discovery already has a baseline; the next source posting takes the normal screening journey.
  await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
    VALUES ('baseline','Synthetic','Baseline','https://example.test/base','2026-01-01','2026-01-01')`).run();
  await db.prepare("INSERT INTO fixed_baselines VALUES (?,?,?)").bind(instanceId, baselineSources(CHICAGO_OPERATIONS.search.sources), "2026-01-01").run();
  const sourceJob = { id: 123, title, absolute_url: "https://boards.greenhouse.io/example-automation/jobs/123",
    location: { name: location }, departments: [{ name: title }], updated_at: "2026-01-01T00:00:00Z",
    content: `<p>${body} This role is full-time employment.</p><p>${salary}</p>` };
  const cards: unknown[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs/123")) return Response.json(sourceJob);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs?")) return Response.json({ jobs: [sourceJob] });
    if (url === "https://slack.com/api/chat.postMessage") { const message = JSON.parse(init!.body as string); if (message.blocks) cards.push(message); return Response.json({ ok: true, channel: "CEXAMPLE123", ts: "123.456" }); }
    throw new Error(`Unexpected external request: ${url}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const env = { ...rawBindings(candidate), AI: { run: async (_model: string, input: {messages:Array<{content:string}>}) => {
      expect(input.messages[0].content).toContain(candidate.policy.functionLanes[0].description);
      return { choices: [{ message: { tool_calls: [{ function: { name: "record_verdict", arguments: JSON.stringify({ match: true, lane: "A", hard_exclude: null, reason: "Synthetic role fits approved candidate." }) } }] }, finish_reason: "tool_calls" }] };
    } } };
    await new AgentWorkflow({} as any, env as any).run({ instanceId: `journey-${label}`, payload: {} } as any, immediateSteps as any);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain(title);
    expect(await db.prepare("SELECT criteria_version,match,application_status,notified_at FROM jobs WHERE id='greenhouse:Example Automation:123'").first()).toMatchObject({ criteria_version: runtime.criteriaVersion, match: 1, application_status: "not_applied", notified_at: expect.any(String) });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 0 });
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it.each(["legacy", "evidence"])("rejects a cached %s A notification callback after deployment and active policy become B", async mode => {
  const { activateCandidateConfig, readActiveCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  await activateCandidateConfig(db, instanceId, a, null);
  await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
    VALUES ('baseline','Synthetic','Baseline','https://example.test/base','2026-01-01','2026-01-01')`).run();
  await db.prepare("INSERT INTO fixed_baselines VALUES (?,?,?)").bind(instanceId, baselineSources(CHICAGO_OPERATIONS.search.sources), "2026-01-01").run();
  const job = { id: 123, title: "Operations manager", absolute_url: "https://boards.greenhouse.io/example-automation/jobs/123",
    location: { name: "Chicago, IL" }, departments: [{ name: "Operations" }],
    content: "<p>Lead operations and improve workflows. This role is full-time employment.</p><p>Annual base salary USD 110,000 - USD 120,000</p>" };
  let cards = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs/123")) return Response.json(job);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs?")) return Response.json({ jobs: [job] });
    if (url === "https://slack.com/api/chat.postMessage") { if (JSON.parse(init!.body as string).blocks) cards++; return Response.json({ ok: true, channel: "CEXAMPLE123", ts: "123.456" }); }
    throw new Error(`Unexpected external request: ${url}`);
  });
  const checkpoints = new Map<string, { stream?: string; value?: unknown }>();
  let paused = true;
  const step = { do: async (name: string, ...args: unknown[]) => {
    // Model a worker interruption before send, with its lease still live.
    if (paused && name.startsWith("notify:")) throw new Error("synthetic interruption before send");
    if (name === "release-discovery-run") return paused ? undefined : (args.at(-1) as () => Promise<unknown>)();
    const saved = checkpoints.get(name);
    if (saved) return saved.stream !== undefined ? new Response(saved.stream).body : structuredClone(saved.value);
    const result = await (args.at(-1) as () => Promise<unknown>)();
    if (result instanceof ReadableStream) { const json = await new Response(result).text(); checkpoints.set(name, { stream: json }); return new Response(json).body; }
    checkpoints.set(name, { value: structuredClone(result) }); return result;
  }, sleep: async () => {} };
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const AI = { run: async () => ({ choices: [{ message: { tool_calls: [{ function: mode === "legacy"
      ? { name: "record_verdict", arguments: JSON.stringify({ match: true, lane: "A", hard_exclude: null, reason: "Synthetic fit." }) }
      : { name: "record_screening_decision", arguments: JSON.stringify({ state: "match", lane: "A", hardExclude: "none", reason: "Synthetic fit.", gaps: [], evidence: [fact("function", "description", "Lead operations and improve workflows."), fact("location", "location", "Chicago, IL")] }) } }] }, finish_reason: "tool_calls" }] }) };
    const event = { instanceId: `cached-${mode}`, payload: {} };
    await expect(new AgentWorkflow({} as any, { ...rawBindings(), INSTANCE_CONFIG: JSON.stringify({...JSON.parse(rawBindings().INSTANCE_CONFIG),screeningMode:mode}), SCREENING_MODE: mode, AI } as any).run(event as any, step as any)).rejects.toThrow(/interruption before send/);
    expect(checkpoints.has("load-pending-notifications")).toBe(true);
    const history = (await db.prepare("SELECT * FROM job_evaluations").all()).results;
    await activateCandidateConfig(db, instanceId, b, 1);
    paused = false;
    await new AgentWorkflow({} as any, { ...rawBindings(BOSTON_ENGINEERING), INSTANCE_CONFIG: JSON.stringify({...JSON.parse(rawBindings(BOSTON_ENGINEERING).INSTANCE_CONFIG),screeningMode:mode}), SCREENING_MODE: mode, AI } as any).run(event as any, step as any);
    expect(cards).toBe(0);
    expect(await readActiveCandidateConfig(db, instanceId)).toEqual({ criteriaVersion: b.criteriaVersion, revision: 2 });
    expect(await db.prepare("SELECT criteria_version,notified_at,application_status FROM jobs WHERE id='greenhouse:Example Automation:123'").first()).toEqual({ criteria_version: a.criteriaVersion, notified_at: null, application_status: "not_applied" });
    expect((await db.prepare("SELECT * FROM job_evaluations").all()).results).toEqual(history);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it("uses pinned A for unfinished screening after the Worker binding changes to B", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  await activateCandidateConfig(db, instanceId, a, null);
  await db.prepare(`INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at)
    VALUES ('baseline','Synthetic','Baseline','https://example.test/base','2026-01-01','2026-01-01')`).run();
  await db.prepare("INSERT INTO fixed_baselines VALUES (?,?,?)").bind(instanceId, baselineSources(CHICAGO_OPERATIONS.search.sources), "2026-01-01").run();
  const event = { instanceId: "unfinished-A", payload: {} };
  const interruptedStep = { do: async (name: string, ...args: unknown[]) => {
    if (name === "fetch-new-postings") throw new Error("synthetic interruption before sources");
    if (name === "release-discovery-run") return;
    return (args.at(-1) as () => Promise<unknown>)();
  } };
  const AI = { run: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "record_verdict", arguments: JSON.stringify({ match: true, lane: "A", hard_exclude: null, reason: "Synthetic positive." }) } }] }, finish_reason: "tool_calls" }] }) };
  const job = { id: 123, title: "Operations manager", absolute_url: "https://boards.greenhouse.io/example-automation/jobs/123", location: { name: "Chicago, IL" }, departments: [{ name: "Operations" }], content: "<p>Lead operations. This role is full-time employment.</p><p>Annual base salary USD 110,000 - USD 120,000</p>" };
  let cards = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs/123")) return Response.json(job);
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/example-automation/jobs?")) return Response.json({ jobs: [job] });
    if (url === "https://slack.com/api/chat.postMessage") { if (JSON.parse(init!.body as string).blocks) cards++; return Response.json({ ok: true }); }
    throw new Error(`Unexpected external request: ${url}`);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(new AgentWorkflow({} as any, { ...rawBindings(), AI } as any).run(event as any, interruptedStep as any)).rejects.toThrow(/interruption before sources/);
    await activateCandidateConfig(db, instanceId, b, 1);
    await new AgentWorkflow({} as any, { ...rawBindings(BOSTON_ENGINEERING), AI } as any).run(event as any, immediateSteps as any);
    expect(await db.prepare("SELECT criteria_version,match,notified_at FROM jobs WHERE id='greenhouse:Example Automation:123'").first()).toEqual({ criteria_version: a.criteriaVersion, match: 1, notified_at: null });
    expect(cards).toBe(0);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it("does not let an old manual Worker with runtime A send a B advisory", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { b } = await configs();
  const id = "c".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, b, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at, undefined, b.criteriaVersion);
  await saveAdvisory(db, id, 0, row(b.criteriaVersion).verdict, null, at, b.criteriaVersion);
  let cards = 0;
  vi.stubGlobal("fetch", async () => { cards++; return Response.json({ ok: true, channel: "CEXAMPLE123", ts: "123.456" }); });
  try {
    await new ManualIntakeWorkflow({} as any, rawBindings() as any).run({ instanceId: "old-manual-A", payload: { requestId: id, generation: 0 } } as any, immediateSteps as any);
    expect(cards).toBe(0);
    expect(await db.prepare("SELECT state FROM manual_intake_requests WHERE id=?").bind(id).first()).toEqual({ state: "ready" });
  } finally { vi.unstubAllGlobals(); }
});

it("keeps provenance/evidence persistence transactional under a superseded discovery lease", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a } = await configs();
  await activateCandidateConfig(db, instanceId, a, null);
  const lease = (await acquireLease(db, "fixed_boards", "old-run"))!;
  await db.prepare("UPDATE discovery_run_leases SET expires_at=0 WHERE pipeline='fixed_boards'").run();
  const successor = (await acquireLease(db, "fixed_boards", "new-run"))!;
  expect(successor.fence).toBeGreaterThan(lease.fence);
  const snapshot = await createPostingSnapshot(posting(), "applied AI");
  const evaluation = await createEvaluation({ jobId: posting().id, runId: lease.owner, snapshot,
    decision: decision({ state: "match", criteriaVersion: a.criteriaVersion }) });
  await expect(saveScreeningResult(db, row(a.criteriaVersion), evaluation, lease, instanceId)).rejects.toThrow(/lease lost/i);
  for (const table of ["jobs", "posting_snapshots", "job_evaluations", "job_screening_current", "screening_deliveries"]) {
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).toEqual({ n: 0 });
  }
});

it("checks the expected cached legacy version and active D1 version in the same read", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  await activateCandidateConfig(db, instanceId, b, null);
  await insertJobs(db, [row(b.criteriaVersion)]);
  expect(await isLegacyNotificationPending(db, posting().id, "fixed_boards", instanceId, a.criteriaVersion)).toBe(false);
  expect(await isLegacyNotificationPending(db, posting().id, "fixed_boards", instanceId, b.criteriaVersion)).toBe(true);
});

it("checks the expected manual runtime and active D1 version in the same read", async () => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { a, b } = await configs();
  const id = "d".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, b, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at, undefined, b.criteriaVersion);
  await saveAdvisory(db, id, 0, row(b.criteriaVersion).verdict, null, at, b.criteriaVersion);
  const prepared = await claimManualDelivery(db, id, 0, at, instanceId);
  expect(await isManualDeliveryCurrent(db, prepared!.deliveryId, 0, instanceId, a.criteriaVersion)).toBe(false);
  expect(await isManualDeliveryCurrent(db, prepared!.deliveryId, 0, instanceId, b.criteriaVersion)).toBe(true);
});


it.each([undefined, null, ""])("denies legacy actual-send checks without pinned provenance: %s", async missingVersion => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { b } = await configs();
  await activateCandidateConfig(db, instanceId, b, null);
  await insertJobs(db, [row(b.criteriaVersion)]);
  expect(await getPendingNotifications(db, "fixed_board", 10, null, instanceId)).toHaveLength(1);
  expect(await isLegacyNotificationPending(db, posting().id, "fixed_boards", instanceId, missingVersion as any)).toBe(false);
});

it.each([undefined, null, ""])("denies evidence actual-send checks without pinned provenance: %s", async missingVersion => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { b } = await configs();
  await activateCandidateConfig(db, instanceId, b, null);
  const snapshot = await createPostingSnapshot(posting(), "applied AI");
  const evaluation = await createEvaluation({ jobId: posting().id, runId: "evidence-omission", snapshot,
    decision: decision({ state: "match", criteriaVersion: b.criteriaVersion }) });
  await saveScreeningResult(db, row(b.criteriaVersion), evaluation, undefined, instanceId);
  expect(await getPendingScreeningNotifications(db, "fixed_board", 10, null, instanceId)).toHaveLength(1);
  expect(await isScreeningNotificationPending(db, posting().id, evaluation.id, "fixed_boards", instanceId, b.criteriaVersion)).toBe(true);
  expect(await isScreeningNotificationPending(db, posting().id, evaluation.id, "fixed_boards", instanceId, missingVersion as any)).toBe(false);
});

it.each([undefined, null, ""])("denies manual actual-send checks without pinned provenance: %s", async missingVersion => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { b } = await configs();
  const id = "e".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, b, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at, undefined, b.criteriaVersion);
  await saveAdvisory(db, id, 0, row(b.criteriaVersion).verdict, null, at, b.criteriaVersion);
  const prepared = await claimManualDelivery(db, id, 0, at, instanceId);
  expect(prepared).not.toBeNull();
  expect(await isManualDeliveryCurrent(db, prepared!.deliveryId, 0, instanceId, missingVersion as any)).toBe(false);
});

it.each([undefined, null])("stops manual execution before claims or sends without an admitted runtime: %s", async missingRuntime => {
  const { activateCandidateConfig } = await import("../../src/config/run-context");
  const { b } = await configs();
  const id = "f".repeat(64), at = "2026-01-01T00:00:00Z";
  await activateCandidateConfig(db, instanceId, b, null);
  await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: posting().url, now: at });
  await claimAndSaveJob(db, id, 0, posting(), at, undefined, b.criteriaVersion);
  await saveAdvisory(db, id, 0, row(b.criteriaVersion).verdict, null, at, b.criteriaVersion);
  let cards = 0;
  await executeManualDelivery(db, { requestId: id, generation: 0 }, immediateSteps as any,
    async () => { cards++; return { kind: "accepted", receipt: { channelId: "C1", messageTs: "123.456" } }; },
    () => at, undefined, instanceId, missingRuntime as any);
  expect(cards).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_intake_deliveries").first()).toEqual({ n: 0 });
  expect(await db.prepare("SELECT state FROM manual_intake_requests WHERE id=?").bind(id).first()).toEqual({ state: "ready" });
  await executeManualDelivery(db, { requestId: id, generation: 0 }, immediateSteps as any,
    async () => { cards++; return { kind: "accepted", receipt: { channelId: "C1", messageTs: "123.456" } }; },
    () => at, undefined, instanceId, b);
  expect(cards).toBe(1);
  expect(await db.prepare("SELECT state FROM manual_intake_requests WHERE id=?").bind(id).first()).toEqual({ state: "delivered" });
});
