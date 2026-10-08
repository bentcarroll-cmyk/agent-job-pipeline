import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
} }));
import { AgentWorkflow } from "../../src/index";
import { UnboundedAgentWorkflow } from "../../src/unbounded/index";
import { ManualIntakeWorkflow } from "../../src/intake/workflow";
import { LifecycleWorkflow } from "../../src/lifecycle/workflow";
import { RadarWorkflow } from "../../src/radar/workflow";
afterEach(() => vi.restoreAllMocks());
describe("direct platform Workflow entry bindings", () => {
  it.each([["fixed", AgentWorkflow], ["unbounded", UnboundedAgentWorkflow], ["intake", ManualIntakeWorkflow], ["lifecycle", LifecycleWorkflow], ["radar", RadarWorkflow]] as const)(
    "%s requires its own candidate and instance bindings before operational work", async (_name, Workflow) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const workflow = new Workflow({} as any, { LIFECYCLE_MODE: "off", RADAR_CHANNEL_ID: "" } as any);
      await expect(workflow.run({ instanceId: "synthetic", payload: { requestId: "missing", generation: 0 } } as any, {} as any))
        .rejects.toThrow(/bindings/i);
    });
});

import fixedWorker from "../../src/index";
import unboundedWorker from "../../src/unbounded/index";
import { readFileSync } from "node:fs";
import { CHICAGO_OPERATIONS } from "../fixtures/candidates";
import { verifySlackRequest } from "../../src/slack";
it.each([undefined, "", "   ", "configured"])("protected routes fail closed for secret %s", async secret => {
  const db = { prepare: vi.fn(() => { throw new Error("Unexpected database access"); }) };
  const queue = { create: vi.fn(async () => ({ id: "synthetic" })) };
  const env = { CANDIDATE_CONFIG: JSON.stringify(CHICAGO_OPERATIONS), INSTANCE_CONFIG: readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"), DB: db, AGENT_WORKFLOW: queue, LIFECYCLE_WORKFLOW: queue, RADAR_WORKFLOW: queue, MANUAL_INTAKE_WORKFLOW: queue, TRIGGER_SECRET: secret, DISCOVERY_ACCOUNTING_MODE: "on" } as any;
  for (const worker of [fixedWorker, unboundedWorker]) for (const [path, method] of [["/", "POST"], ["/?workflow=lifecycle", "POST"], ["/?workflow=radar", "POST"], ["/discovery/report?runId=x", "GET"], ...(worker === unboundedWorker ? [["/intake/reconcile", "POST"], ["/intake/receipt", "POST"]] : [])]) {
    const response = await worker.fetch(new Request("https://example.invalid" + path, { method, headers: { authorization: secret === "configured" ? "Bearer incorrect" : `Bearer ${secret}` } }), env, {} as any);
    expect(response.status).toBe(401);
  }
  expect(db.prepare).not.toHaveBeenCalled(); expect(queue.create).not.toHaveBeenCalled();
});
it.each([undefined, "", "   "])("rejects missing Slack signature secret %s without throwing", async secret => {
  await expect(verifySlackRequest(secret as any, "v0="+"0".repeat(64), String(Math.floor(Date.now()/1000)), "body")).resolves.toBe(false);
});

it.each([fixedWorker,unboundedWorker])("valid trigger secret reaches the authorized queue",async worker=>{
 const create=vi.fn(async()=>({id:"synthetic"}));
 const env={CANDIDATE_CONFIG:JSON.stringify(CHICAGO_OPERATIONS),INSTANCE_CONFIG:readFileSync(new URL("../../examples/instance.json",import.meta.url),"utf8"),DB:{prepare:()=>({bind:()=>({first:async()=>null})})},AGENT_WORKFLOW:{create},TRIGGER_SECRET:"synthetic-authorized"} as any;
 const response=await worker.fetch(new Request("https://example.invalid/",{method:"POST",headers:{authorization:"Bearer synthetic-authorized"}}),env,{} as any);
 expect(response.status).toBe(200);expect(create).toHaveBeenCalledOnce();
});
