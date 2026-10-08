import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
} }));
import fixedWorker from "../../src/index";
import unboundedWorker from "../../src/unbounded/index";
import { CHICAGO_OPERATIONS } from "../fixtures/candidates";
import { createDatabase, loadSchema } from "./harness";
import { acceptIntake } from "../../src/intake/store";

// Synthetic provider boundary: stores the durable IDs submitted by the real handlers.
class WorkflowQueue {
  ids: string[] = [];
  async create(input: { id?: string }) {
    const id = input.id ?? `automatic-${this.ids.length}`;
    if (this.ids.includes(id)) throw new Error("Instance already exists");
    this.ids.push(id); return { id };
  }
  async get(id: string) {
    return { status: async () => {
      if (!this.ids.includes(id)) throw new Error("Instance not found");
      return { status: "running" };
    } };
  }
}
const instance = () => {
  const raw = JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
  raw.schedule = { timezone: "America/New_York", discoveryLocalTimes: ["01:30"], discoveryWeekdays: [7], lifecycleLocalTime: "01:30", radarLocalTime: "01:30" };
  raw.lifecycle.enabled = true;
  return raw;
};
const tick = (at: string) => ({ cron: "*/5 * * * *", scheduledTime: Date.parse(at) }) as ScheduledEvent;

describe("scheduled Worker ownership and durable slots", () => {
  let db: D1Database, dispose: () => Promise<void>;
  let fixed: WorkflowQueue, discovery: WorkflowQueue, lifecycle: WorkflowQueue, radar: WorkflowQueue, intake: WorkflowQueue;
  const env = (raw = instance(), queue = discovery) => ({ CANDIDATE_CONFIG: JSON.stringify(CHICAGO_OPERATIONS), INSTANCE_CONFIG: JSON.stringify(raw),
    DB: db, AGENT_WORKFLOW: queue, LIFECYCLE_WORKFLOW: lifecycle, RADAR_WORKFLOW: radar, MANUAL_INTAKE_WORKFLOW: intake,
    LIFECYCLE_MODE: "live", DISCOVERY_ACCOUNTING_MODE: "off" }) as any;
  beforeEach(async () => {
    ({ db, dispose } = await createDatabase()); await loadSchema(db, "root");
    fixed = new WorkflowQueue(); discovery = new WorkflowQueue(); lifecycle = new WorkflowQueue(); radar = new WorkflowQueue(); intake = new WorkflowQueue();
  });
  afterEach(async () => { await dispose(); });

  it("does not dispatch calendar workflows outside their configured local slot", async () => {
    await fixedWorker.scheduled(tick("2026-11-01T05:25:00Z"), env(instance(), fixed));
    await unboundedWorker.scheduled(tick("2026-11-01T05:25:00Z"), env());
    expect([fixed.ids, discovery.ids, lifecycle.ids, radar.ids, intake.ids]).toEqual([[], [], [], [], []]);
  });
  it("fans discovery out to owned queues with one execution across duplicate ticks and the DST fold", async () => {
    for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
      await fixedWorker.scheduled(tick(at), env(instance(), fixed));
      await unboundedWorker.scheduled(tick(at), env());
    }
    expect(fixed.ids).toEqual(["example-instance-fixed-2026-11-01-0130"]);
    expect(discovery.ids).toEqual(["example-instance-discovery-2026-11-01-0130"]);
    expect(lifecycle.ids).toEqual(["example-instance-lifecycle-2026-11-01-0130"]);
    expect(radar.ids).toEqual([]);
  });
  it("gates disabled modules even when their calendar times are populated", async () => {
    const raw = instance(); raw.lifecycle.enabled = false;
    await unboundedWorker.scheduled(tick("2026-11-01T05:30:00Z"), env(raw));
    expect(discovery.ids).toEqual(["example-instance-discovery-2026-11-01-0130"]);
    expect(lifecycle.ids).toEqual([]); expect(radar.ids).toEqual([]);
  });
  it("keeps intake recovery on both UTC fold ticks and preserves its generation IDs", async () => {
    const id = "a".repeat(64);
    await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: "https://jobs.lever.co/example/1", now: "2026-11-01T05:00:00Z" });
    for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) await unboundedWorker.scheduled(tick(at), env());
    expect(intake.ids).toEqual([`intake-${id}-g0`]);
    expect(await db.prepare("SELECT dispatch_count,workflow_generation,next_attempt_at FROM manual_intake_requests").first()).toEqual({ dispatch_count: 2, workflow_generation: 0, next_attempt_at: Date.parse("2026-11-01T06:35:00Z") });
  });
  it("schedules enabled radar with its own durable local ID", async () => {
    const raw = instance(); raw.radar = { enabled: true, channelId: "CEXAMPLE123", monthlyBudgetUsd: 5, topics: ["Synthetic topic"] };
    for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) await unboundedWorker.scheduled(tick(at), env(raw));
    expect(radar.ids).toEqual(["example-instance-radar-2026-11-01-0130"]);
  });
  it("respects explicit lifecycle off mode before queueing", async () => {
    await unboundedWorker.scheduled(tick("2026-11-01T05:30:00Z"), { ...env(), LIFECYCLE_MODE: "off" });
    expect(lifecycle.ids).toEqual([]);
  });
  it("keeps maximum instance prefixes inside provider ID bounds and distinct across workers", async () => {
    for (const prefix of ["x".repeat(63), "x".repeat(62) + "y"]) {
      const raw = instance(); raw.instanceId = prefix;
      for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
        await fixedWorker.scheduled(tick(at), env(raw, fixed));
        await unboundedWorker.scheduled(tick(at), env(raw));
      }
    }
    expect(fixed.ids).toEqual([`${"x".repeat(63)}-fixed-2026-11-01-0130`, `${"x".repeat(62)}y-fixed-2026-11-01-0130`]);
    expect(discovery.ids).toEqual([`${"x".repeat(63)}-discovery-2026-11-01-0130`, `${"x".repeat(62)}y-discovery-2026-11-01-0130`]);
    for (const id of [...fixed.ids, ...discovery.ids, ...lifecycle.ids]) { expect(id.length).toBeLessThanOrEqual(100); expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/); }
  });
  it("awaits intake recovery before reporting an independent calendar provider failure", async () => {
    const id = "b".repeat(64);
    await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1", inputUrl: "https://jobs.lever.co/example/2", now: "2026-11-01T05:00:00Z" });
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const intakeStarted = new Promise<void>(resolve => { started = resolve; });
    const failing = { create: async () => { throw new Error("Calendar provider unavailable"); }, get: async () => ({ status: async () => { throw new Error("No confirmed instance"); } }) };
    const recovery = { create: async (input: { id?: string }) => { started(); await waiting; return intake.create(input); } };
    let settled = false;
    const outcome = unboundedWorker.scheduled(tick("2026-11-01T05:30:00Z"), { ...env(), LIFECYCLE_WORKFLOW: failing, MANUAL_INTAKE_WORKFLOW: recovery }).then(
      () => { settled = true; return "unexpected success"; }, error => { settled = true; return error.message; });
    await intakeStarted; await setImmediate();
    try { expect(settled).toBe(false); }
    finally { release(); await outcome; }
    expect(await outcome).toBe("Calendar provider unavailable");
    expect(await db.prepare("SELECT dispatch_count FROM manual_intake_requests WHERE id=?").bind(id).first()).toEqual({ dispatch_count: 1 });
    expect(discovery.ids).toEqual(["example-instance-discovery-2026-11-01-0130"]);
  });
  it("stops shadow Workers before any ledger or provider operation", async () => {
    const raw = instance(); raw.shadowMode = true;
    const input = { ...env(raw), DB: { prepare() { throw new Error("Unexpected ledger access"); } } };
    await fixedWorker.scheduled(tick("2026-11-01T05:30:00Z"), input);
    await unboundedWorker.scheduled(tick("2026-11-01T05:30:00Z"), input);
    expect([discovery.ids, lifecycle.ids, radar.ids, intake.ids]).toEqual([[], [], [], []]);
  });
});
