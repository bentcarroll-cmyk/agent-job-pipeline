import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterJob as rawFilterJob, type FilterEnv } from "./filter";
import { parseVerdict } from "./criteria";
import { evaluateJob, parseScreeningResponse } from "./screening/evaluate";
import { loadRuntimeConfig } from "./config/candidate";
import { createPostingSnapshot as rawCreatePostingSnapshot } from "./screening/snapshot";
import { CHICAGO_OPERATIONS } from "../tests/fixtures/candidates";
import { completePosting, fact } from "../tests/fixtures/policy-postings";
const positive = { match: true, lane: "A", hard_exclude: null, reason: "Operations fit." };
const response = (args: string, name = "record_verdict") => ({ choices: [{ message: { tool_calls: [{ function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] });
async function env(run: (...args: unknown[]) => Promise<unknown>): Promise<FilterEnv> {
  return { runtime: await loadRuntimeConfig(CHICAGO_OPERATIONS), AI_GATEWAY_ID: "synthetic", AI: { run } as unknown as Ai };
}
let telemetry: Record<string,unknown>[];
beforeEach(()=>{telemetry=[];const original=console.log;vi.spyOn(console,"log").mockImplementation((...args)=>{try{const value=JSON.parse(String(args[0]));if(args.length===1&&value.event==="model_attempt"){expect(value).toMatchObject({jobId:expect.any(String),attempt:expect.any(Number),outcome:expect.any(String)});telemetry.push(value);return;}}catch{}original(...args);throw new Error("Unexpected model diagnostic");});});
afterEach(() => vi.restoreAllMocks());

describe("synthetic model response regressions", () => {
  it.each([
    '{"match":true,"lane":"A",',
    JSON.stringify({ ...positive, hard_exclude: "3" }),
    JSON.stringify({ ...positive, reason: "" }),
    JSON.stringify({ ...positive, lane: null }),
  ])("rejects malformed or contradictory positive verdicts: %s", args => {
    expect(() => parseVerdict(args)).toThrow();
  });
  it.each(['{"match":false,"reason":"unterminated', '{"match":false}', JSON.stringify({match:false,lane:null,hard_exclude:"99",reason:"Unknown pay"}), JSON.stringify({match:false,lane:"C",hard_exclude:null,reason:"Unknown"})])("retries invalid negative output: %s", async args => {
    expect(() => parseVerdict(args)).toThrow();
    const run = vi.fn(async () => response(args));
    await expect(filterJob(await env(run), completePosting())).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("requires complete posting context for a no-function-fit decision", async () => {
    const run = async () => response(JSON.stringify({match:false,lane:null,hard_exclude:null,reason:"No function fit"}));
    await expect(filterJob(await env(run), completePosting({description:null}))).rejects.toThrow(/context|review/);
  });
  it("normalizes the provider's literal null only in the binary contract", () => {
    expect(parseVerdict(JSON.stringify({ ...positive, hard_exclude: "null" }))).toEqual(positive);
  });
  it.each(["wrong_tool", "duplicate"])("rejects %s tool output", async kind => {
    const result = response(JSON.stringify(positive), kind === "wrong_tool" ? kind : "record_verdict");
    if (kind === "duplicate") result.choices[0].message.tool_calls.push(result.choices[0].message.tool_calls[0]);
    await expect(filterJob(await env(async () => result), completePosting())).rejects.toThrow(/unexpected screening tool/);
  });
  it("resamples truncated output and recovers a complete decision", async () => {
    const run = vi.fn().mockResolvedValueOnce({ choices: [{ message: {}, finish_reason: "length" }], usage: { completion_tokens: 4000 } }).mockResolvedValueOnce(response(JSON.stringify(positive)));
    expect(await filterJob(await env(run), completePosting())).toEqual(positive);
    expect(run).toHaveBeenCalledTimes(2);
    expect(telemetry).toHaveLength(2);
    expect(run.mock.calls[0][0]).toBe("@cf/zai-org/glm-5.3-flash");
  });
  it("does not invent a rejection when no tool call comes back", async () => {
    const run = vi.fn().mockResolvedValue({ choices: [{ message: {}, finish_reason: "length" }], usage: { completion_tokens: 4000 } });
    await expect(filterJob(await env(run), completePosting())).rejects.toThrow(/no tool call returned/);
    expect(run).toHaveBeenCalledTimes(2);
    expect(telemetry).toHaveLength(2);
  });
  it("records runtime provenance on transport retries", async () => {
    const result = await evaluateJob(await env(async () => { throw new Error("synthetic transport failure"); }), completePosting());
    expect(result.decision).toMatchObject({ state: "retry", criteriaVersion: "d5c13c7f8c8abbc3dc82f607241ac34aa14b2b0b5f4fb212944fa8e72406f7e6" });
  });
  it("requires explicit wire enums and anchored positive evidence", async () => {
    const snapshot = await createPostingSnapshot(completePosting());
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const raw = { state: "match", lane: "A", hardExclude: "none", reason: "Fit", gaps: [], evidence: [fact("function", "description", "Lead operations and improve workflows."), fact("location", "location", "Chicago, IL")] };
    expect(parseScreeningResponse(JSON.stringify(raw), snapshot, runtime).state).toBe("match");
    expect(() => parseScreeningResponse(JSON.stringify({ ...raw, hardExclude: null }), snapshot, runtime)).toThrow(/wire enums/);
    expect(() => parseScreeningResponse('{"state":"match",', snapshot, runtime)).toThrow();
    expect(parseScreeningResponse(JSON.stringify({ ...raw, evidence: [] }), snapshot, runtime).state).toBe("needs_review");
  });
});

const filterJob: typeof rawFilterJob = (env,job,category="applied AI",options) => rawFilterJob(env,job,category,options);

const createPostingSnapshot: typeof rawCreatePostingSnapshot = (job,category="applied AI") => rawCreatePostingSnapshot(job,category);
