import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, loadSchema } from "./harness";
import { acceptIntake, claimAndSaveJob, saveAdvisory, readIntake } from "../../src/intake/store";
import { dispatchIntake, reconcileIntakes } from "../../src/intake/dispatch";
import { claimManualDelivery } from "../../src/intake/delivery-store";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { activateCandidateConfig } from "../../src/config/run-context";
import { CHICAGO_OPERATIONS } from "../fixtures/candidates";
import type { WorkflowControl } from "../../src/intake/types";

const now = Date.parse("2026-09-22T22:00:00.000Z");
const id = "a".repeat(64);
const instanceId = `intake-${id}-g0`;

describe("independent manual intake recovery", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;
  beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); });
  afterEach(async () => { await dispose(); });

  async function accepted() {
    await acceptIntake(db, { id, teamId: "T1", userId: "U1", channelId: "C1",
      inputUrl: "https://careers.example.test/jobs/synthetic-1", now: new Date(now).toISOString() });
  }

  it("starts a saved request after the immediate kick was lost", async () => {
    await accepted();
    const create = vi.fn(async ({ id }: {id:string}) => ({ id }));
    const status = vi.fn(async () => "not_found" as const);
    const control = { create, status } as WorkflowControl;
    expect(await reconcileIntakes(db, control, now)).toMatchObject({ examined: 1, created: 1 });
    expect(create).toHaveBeenCalledWith({ id: instanceId, params: { requestId: id, generation: 0 } });
    expect(await readIntake(db, id)).toMatchObject({ workflowId: instanceId });
  });

  it("checks exact instance status after a lost create response", async () => {
    await accepted();
    const control: WorkflowControl = {
      create: vi.fn(async () => { throw new Error("timeout"); }),
      status: vi.fn(async () => "running" as const),
    };
    expect(await dispatchIntake(db, control, id, now)).toBe("exists");
    expect(control.status).toHaveBeenCalledWith(instanceId);
    expect((await readIntake(db, id))?.workflowGeneration).toBe(0);
  });

  it("keeps one generation when neither create nor status can be confirmed", async () => {
    await accepted();
    const control: WorkflowControl = {
      create: vi.fn(async () => { throw new Error("timeout"); }),
      status: vi.fn(async () => { throw new Error("status unavailable"); }),
    };
    expect(await dispatchIntake(db, control, id, now)).toBe("unknown");
    expect(await readIntake(db, id)).toMatchObject({ workflowGeneration: 0,
      workflowId: instanceId, failureCode: "dispatch_unknown" });
    expect(await dispatchIntake(db, control, id, now + 1000)).toBe("deferred");
  });

  it("retries the same ID after an uncertain create once backoff is due", async () => {
    await accepted();
    let attempts = 0;
    const control: WorkflowControl = {
      create: vi.fn(async input => {
        attempts++;
        if (attempts === 1) throw new Error("timeout");
        return { id: input.id };
      }),
      status: vi.fn(async () => "unknown" as const),
    };
    expect(await dispatchIntake(db, control, id, now)).toBe("unknown");
    expect(await dispatchIntake(db, control, id, now + 60_000)).toBe("created");
    expect(control.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(control.create).mock.calls.map(call => call[0].id)).toEqual([instanceId, instanceId]);
    expect((await readIntake(db, id))?.workflowGeneration).toBe(0);
  });

  it("recovers a verified errored instance once and fences its old generation", async () => {
    await accepted();
    await db.prepare("UPDATE manual_intake_requests SET dispatch_count=1 WHERE id=?").bind(id).run();
    const control: WorkflowControl = {
      create: vi.fn(async ({ id }) => ({ id })),
      status: vi.fn(async () => "errored" as const),
    };
    expect(await dispatchIntake(db, control, id, now)).toBe("created");
    expect(control.create).toHaveBeenCalledWith({ id: `intake-${id}-g1`,
      params: { requestId: id, generation: 1 } });
    expect(await readIntake(db, id)).toMatchObject({ workflowGeneration: 1,
      workflowId: `intake-${id}-g1` });
  });

  it("uses due filtering before its bounded batch", async () => {
    await accepted();
    await db.prepare("UPDATE manual_intake_requests SET next_attempt_at=? WHERE id=?")
      .bind(now + 60_000, id).run();
    const control: WorkflowControl = { create: vi.fn(), status: vi.fn() };
    expect(await reconcileIntakes(db, control, now)).toMatchObject({ examined: 0 });
    expect(control.create).not.toHaveBeenCalled();
  });

  it("keeps one deterministic ID when reconcilers race", async () => {
    await accepted();
    const instances = new Set<string>();
    const control: WorkflowControl = {
      create: vi.fn(async input => {
        if (instances.has(input.id)) throw new Error("duplicate");
        instances.add(input.id); return { id: input.id };
      }),
      status: vi.fn(async instance => instances.has(instance) ? "running" as const : "not_found" as const),
    };
    await Promise.all([dispatchIntake(db, control, id, now), dispatchIntake(db, control, id, now)]);
    expect([...instances]).toEqual([instanceId]);
    expect((await readIntake(db, id))?.workflowGeneration).toBe(0);
  });

  it("holds after three verified recovery generations", async () => {
    await accepted();
    await db.prepare(`UPDATE manual_intake_requests SET workflow_generation=3,
      workflow_id=?,dispatch_count=1 WHERE id=?`).bind(`intake-${id}-g3`, id).run();
    const control: WorkflowControl = { create: vi.fn(), status: vi.fn(async () => "errored" as const) };
    expect(await reconcileIntakes(db, control, now)).toMatchObject({ exhausted: 1 });
    expect(await readIntake(db, id)).toMatchObject({ state: "held",
      failureCode: "recovery_exhausted", workflowGeneration: 3 });
    expect(control.create).not.toHaveBeenCalled();
  });

  it("marks a stranded sending claim unknown without creating another Workflow", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    await activateCandidateConfig(db, "synthetic-instance", runtime, null);
    await accepted();
    await claimAndSaveJob(db, id, 0, { id: "lever:acme:abc", company: "Acme",
      title: "Director", url: "https://jobs.lever.co/acme/abc", location: "Remote US",
      department: "Operations", isRemote: true, employmentType: "Full time",
      postedAt: null, compensation: null, description: "Lead operations." }, new Date(now).toISOString(), undefined, runtime.criteriaVersion);
    await saveAdvisory(db, id, 0, null, "provider_error", new Date(now).toISOString(), runtime.criteriaVersion);
    expect(await claimManualDelivery(db, id, 0, new Date(now).toISOString(), "synthetic-instance")).not.toBeNull();
    expect(await db.prepare("SELECT state FROM manual_intake_deliveries").first()).toEqual({ state: "sending" });
    await db.prepare("UPDATE manual_intake_requests SET dispatch_count=1 WHERE id=?")
      .bind(id).run();
    const control: WorkflowControl = { create: vi.fn(), status: vi.fn(async () => "errored" as const) };
    expect(await dispatchIntake(db, control, id, now)).toBe("deferred");
    expect(await readIntake(db, id)).toMatchObject({ state: "delivery_unknown" });
    expect(await db.prepare("SELECT state,attempts_json FROM manual_intake_deliveries")
      .first()).toMatchObject({ state: "unknown",
        attempts_json: expect.stringContaining("workflow_interrupted") });
    expect(control.create).not.toHaveBeenCalled();
  });
});
