import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { acquireLease, activeRunId, releaseLease, renewLease, type DiscoveryLease, type DiscoveryPipeline } from "./leases";

// A body-free approximation of the filter return's persistence shape. This
// cannot prove how the Workflow runtime encodes a checkpoint, and a failed
// probe must never replace the original step result.
function resultProbe(value: unknown): { cloneable: boolean; jsonApproxBytes: number | null } {
  let cloneable = false;
  let jsonApproxBytes: number | null = null;
  try {
    const copied = structuredClone(value);
    cloneable = true;
    const json = JSON.stringify(copied);
    if (json !== undefined) jsonApproxBytes = new TextEncoder().encode(json).byteLength;
  } catch { /* Retain the original result and report only fixed-shape metadata. */ }
  return { cloneable, jsonApproxBytes };
}
function checkpointKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype ? "plain" : prototype === null ? "null_prototype" : "other_object";
}
function checkpointProbe(value: unknown): Record<string, string | number> {
  const item = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return { returnKind: checkpointKind(value), fieldCount: Object.keys(item).length,
    okKind: checkpointKind(item.ok), screenedKind: checkpointKind(item.screened),
    sourceJobKind: checkpointKind(item.sourceJob), itemKind: checkpointKind(item.item),
    selectionKind: checkpointKind(item.selection) };
}

// Narrow adapter for the operations used by discovery. Renewal lives INSIDE
// every actual callback, not in a separate memoized step. Replayed callbacks
// need no permission, but the next callback that does work always does.
export class DiscoverySteps {
  constructor(private raw: WorkflowStep, private db: D1Database, private lease: DiscoveryLease) {}
  do<T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  async do<T extends Rpc.Serializable<T>>(name: string, configOrCallback: WorkflowStepConfig | (() => Promise<T>), callback?: () => Promise<T>): Promise<T> {
    const config = typeof configOrCallback === "function" ? {} : configOrCallback;
    const execute = typeof configOrCallback === "function" ? configOrCallback : callback!;
    const trace = (phase: string, details?: Record<string, string | number | boolean | null>) => {
      if (/^(?:filter|recover-filter|save-assessment):/.test(name)) console.log(JSON.stringify({
        event: "screening_phase", runId: this.lease.owner, pipeline: this.lease.pipeline,
        fence: this.lease.fence, step: name, phase, ...details,
      }));
    };
    try {
      const result = await this.raw.do(name, { timeout: "10 minutes", ...config }, async () => {
        trace("lease_before_start");
        await renewLease(this.db, this.lease);
        trace("lease_before_ok");
        trace("callback_start");
        const result = await execute();
        trace("callback_ok");
        trace("lease_after_start");
        await renewLease(this.db, this.lease);
        trace("lease_after_ok");
        if (name.startsWith("filter:")) {
          try { trace("result_probe", resultProbe(result)); }
          catch { /* Diagnostics cannot change the Workflow result. */ }
        }
        return result;
      });
      if (name.startsWith("filter:")) {
        try { trace("checkpoint_probe", checkpointProbe(result)); }
        catch { /* Diagnostics cannot change the Workflow result. */ }
      }
      // This can also occur on replay: it observes the returned step, not a
      // new callback or a delivery receipt. Never include the returned payload.
      trace("step_returned");
      return result;
    } catch (error) {
      trace("step_error");
      throw error;
    }
  }
  sleep(name: string, duration: Parameters<WorkflowStep["sleep"]>[1]) { return this.raw.sleep(name, duration); }
}

export async function withDiscoveryLease<T>(db: D1Database, pipeline: DiscoveryPipeline, owner: string, raw: WorkflowStep,
  run: (step: DiscoverySteps, lease: DiscoveryLease) => Promise<T>) {
  const claim = await raw.do("claim-discovery-run", async () => {
    const lease = await acquireLease(db, pipeline, owner);
    return { lease, activeRunId: lease ? owner : await activeRunId(db, pipeline) };
  });
  if (!claim.lease) return { skipped: "already_running" as const, activeRunId: claim.activeRunId };
  try { return await run(new DiscoverySteps(raw, db, claim.lease), claim.lease); }
  finally {
    await raw.do("release-discovery-run", async () => { await releaseLease(db, claim.lease!); });
  }
}

export async function triggerDiscovery(db: D1Database, workflow: Workflow, pipeline: DiscoveryPipeline, scheduledTime?: number) {
  if (scheduledTime === undefined) {
    const active = await activeRunId(db, pipeline);
    if (active) return { id: active, reused: true };
    const instance = await workflow.create({});
    return { id: instance.id, reused: false };
  }
  const id = `${pipeline}-${scheduledTime}`;
  try { return { id: (await workflow.create({ id })).id, reused: false }; }
  catch (error) {
    // Do not disguise an API outage as a successful trigger. Confirm that
    // this exact scheduled instance really exists before accepting replay.
    const instance = await workflow.get(id);
    try { await instance.status(); } catch { throw error; }
    return { id, reused: true };
  }
}
