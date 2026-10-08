import { it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class { constructor(_ctx: unknown, public env: unknown) {} } }));
vi.mock("../../src/config/run-context", () => ({ admitRunConfig: vi.fn(async (_db, _id, runtime) => runtime) }));
import { admitRunConfig } from "../../src/config/run-context";
import * as radarStore from "../../src/radar/db";
import * as xProvider from "../../src/radar/x-client";
import * as editor from "../../src/radar/editor";
import * as slack from "../../src/slack";
import { RadarWorkflow, dateLabel } from "../../src/radar/workflow";
import { buildRadarProfile, configuredRadarQueries } from "../../src/radar/profile";
import { buildQueryPlan } from "../../src/radar/sources";
import { buildTriagePrompt, callTriageModel } from "../../src/radar/triage";
import { buildEditorPrompt } from "../../src/radar/editor";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { CHICAGO_OPERATIONS, BOSTON_ENGINEERING } from "../fixtures/candidates";
const base = JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
function enabled() { return {...structuredClone(base), radar: {enabled: true, channelId: "CRADAR", monthlyBudgetUsd: 10, topics: ["hands_on"]}, schedule: {...base.schedule, timezone: "America/Chicago", radarLocalTime: "13:00"}}; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("disabled radar admits criteria but touches neither provider credentials nor providers", async () => {
  const fetch = vi.fn(() => { throw new Error("unexpected provider"); }); vi.stubGlobal("fetch", fetch);
  const env = { CANDIDATE_CONFIG: JSON.stringify(CHICAGO_OPERATIONS), INSTANCE_CONFIG: JSON.stringify(base) };
  for (const key of ["TWITTERAPI_IO_KEY", "ANTHROPIC_API_KEY"]) Object.defineProperty(env, key, {get() {throw new Error("disabled feature read " + key);}});
  const step = {do: vi.fn()};
  await expect(new RadarWorkflow({} as any, env as any).run({instanceId: "disabled"} as any, step as any)).resolves.toEqual({skipped: "off"});
  expect(fetch).not.toHaveBeenCalled(); expect(step.do).not.toHaveBeenCalled(); expect(admitRunConfig).toHaveBeenCalledOnce();
});
it("profiles and actual query plans follow approved candidate, timezone and selected topics", async () => {
  const a = await loadRuntimeConfig(CHICAGO_OPERATIONS), b = await loadRuntimeConfig(BOSTON_ENGINEERING), instance = enabled();
  const first = buildRadarProfile(a, instance), second = buildRadarProfile(b, instance);
  expect(first).toContain("Alex Example"); expect(first).toContain("100000"); expect(first).toContain("America/Chicago"); expect(first).toContain("Operations");
  expect(second).toContain("Morgan Example"); expect(second).toContain("160000"); expect(second).toContain("Software engineering"); expect(second).not.toContain("Chicago, IL");
  const plan = buildQueryPlan(123, undefined, configuredRadarQueries(a, instance));
  expect(new Set(plan.map(q => q.source))).toEqual(new Set(["hiring", "hands_on"]));
  expect(plan.find(q => q.source === "hiring")?.query).toContain('"Operations manager"');
  expect(buildQueryPlan(123, undefined, configuredRadarQueries(b, instance)).find(q => q.source === "hiring")?.query).toContain('"Software engineering manager"');
  expect(buildTriagePrompt(first, instance.radar.topics)).toContain(first);
  expect(buildTriagePrompt(first, instance.radar.topics)).not.toContain("enterprise_adoption:");
  expect(buildEditorPrompt({candidates: [], contexts: [], taste: {useful: [], notUseful: []}}, second).system).toContain(second);
  expect(first).not.toContain("Morgan Example"); expect(first).not.toContain("Boston, MA");
  expect(second).not.toContain("Alex Example"); expect(second).not.toContain("Chicago, IL");
});
it("unknown enabled topic stops before provider work rather than silently using defaults", async () => {
  const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS); const instance = enabled(); instance.radar.topics = ["unrecognized"];
  expect(() => buildRadarProfile(runtime, instance)).toThrow(/RADAR_TOPIC_UNKNOWN/);
});

it("enabled run admits approved config but an exhausted data budget starts no X or Anthropic calls", async () => {
  vi.spyOn(radarStore, "otherRunInProgress").mockResolvedValue(false);
  vi.spyOn(radarStore, "lastCollectStart").mockResolvedValue(null);
  vi.spyOn(radarStore, "monthSpend").mockResolvedValue(1000);
  vi.spyOn(radarStore, "startRun").mockResolvedValue(undefined);
  vi.spyOn(radarStore, "finishRun").mockResolvedValue(undefined);
  vi.spyOn(slack, "postText").mockResolvedValue(undefined);
  const x = vi.spyOn(xProvider, "createXClient"), anthropic = vi.spyOn(editor, "createEditorClient");
  const step = {do: vi.fn(async (_name, ...args) => args.at(-1)())};
  const env = {CANDIDATE_CONFIG: JSON.stringify(CHICAGO_OPERATIONS), INSTANCE_CONFIG: JSON.stringify(enabled()), DB: {}};
  const result = await new RadarWorkflow({} as any, env as any).run({instanceId: "budget"} as any, step as any);
  expect(result).toMatchObject({notice: expect.stringContaining("monthly data budget is spent")});
  expect(admitRunConfig).toHaveBeenCalledOnce(); expect(x).not.toHaveBeenCalled(); expect(anthropic).not.toHaveBeenCalled();
});
it("real triage/editor calls receive selected profile and preserve source-grounded draft constraints", async () => {
  const original=console.log, telemetry:unknown[]=[];
  vi.spyOn(console,"log").mockImplementation((...args)=>{let value;try{value=JSON.parse(String(args[0]));}catch{original(...args);return;}if(args.length===1&&value.event==="model_attempt"){expect(value).toMatchObject({attempt:expect.any(Number),outcome:"valid"});telemetry.push(value);return;}original(...args);});
  const runtime = await loadRuntimeConfig(BOSTON_ENGINEERING), instance = enabled(), profile = buildRadarProfile(runtime, instance);
  const ai = vi.fn().mockResolvedValue({choices: [{message: {tool_calls: [{function: {name: "record_triage", arguments: JSON.stringify({results: [{id: "synthetic", kind: "practice", topic: "hands_on", score: 2, reason: "A supplied method"}]})}}]}}]});
  const post = {id: "synthetic", text: "Synthetic method", quotedText: null, authorHandle: "example", authorName: null, authorBio: null, authorFollowers: null, authorCreatedAt: null, likes: 0, reposts: 0, replies: 0, quotes: 0, foundBy: ["hands_on:0"]};
  expect(await callTriageModel({runtime, AI: {run: ai}, AI_GATEWAY_ID: "synthetic"} as any, [post], profile, instance.radar.topics)).toHaveLength(1);
  expect(ai.mock.calls[0][1].messages[0].content).toContain(profile);
  expect(telemetry).toHaveLength(1);
  const create = vi.fn().mockResolvedValue({usage: {input_tokens: 1, output_tokens: 1}, stop_reason: "end_turn", content: [{type: "text", text: JSON.stringify({hiring: [], developments: [], practice: [{post_ids: ["synthetic"], headline: "Synthetic method", why: "A supplied method for review", angle: ""}], debates: []})}]});
  expect((await editor.runEditor(async () => ({messages: {create}}) as any, {candidates: [{...post, kind: "practice", topic: "hands_on", score: 2, reason: "A supplied method", ageHours: 1, rank: 2, url: "https://example.test"} as any], contexts: [], taste: {useful: [], notUseful: []}}, profile)).fallback).toBe(false);
  expect(create.mock.calls[0][0].system).toContain(profile);
  expect(create.mock.calls[0][0].system).toContain("Never imply personal experience");
  expect(dateLabel("2026-01-02T02:00:00Z", "America/Chicago")).toBe("Thu, Jan 1");
  expect(dateLabel("2026-01-02T02:00:00Z", "Asia/Tokyo")).toBe("Fri, Jan 2");
});
