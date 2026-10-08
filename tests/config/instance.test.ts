import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseInstanceConfig, parseInstanceDraft } from "../../src/config/instance";
const raw = () => JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
describe("instance config", () => {
  it("draft_instance_cannot_be_used_operationally", () => {
    const draft = raw(); draft.cloudflare.databaseId = null;
    expect(parseInstanceDraft(draft).cloudflare.databaseId).toBeNull();
    expect(() => parseInstanceConfig(draft)).toThrow(/databaseId/i);
  });
  it("parses explicit instance without personal defaults and freezes copies", () => {
    const input = raw(); const c = parseInstanceConfig(input);
    input.operator.displayName = "changed";
    expect(c.operator.displayName).toBe("Example Operator");
    expect(Object.isFrozen(c.schedule.discoveryWeekdays)).toBe(true);
  });
  it.each([
    ["missing operator", (c: any) => delete c.operator],
    ["empty authorized user", (c: any) => c.slack.allowedUserId = ""],
    ["invalid Slack identity", (c: any) => c.slack.channelId = "general"],
    ["invalid account identity", (c: any) => c.cloudflare.accountId = "not-an-id"],
    ["invalid database identity", (c: any) => c.cloudflare.databaseId = "db"],
    ["same workers", (c: any) => c.cloudflare.unboundedWorkerName = c.cloudflare.fixedWorkerName],
    ["invalid timezone", (c: any) => c.schedule.timezone = "not/a-zone"],
    ["invalid clock", (c: any) => c.schedule.discoveryLocalTimes = ["24:00"]],
    ["unsupported weekday", (c: any) => c.schedule.discoveryWeekdays = [0]],
    ["empty discovery schedule", (c: any) => c.schedule.discoveryLocalTimes = []],
    ["duplicate clock", (c: any) => c.schedule.discoveryLocalTimes = ["09:00","09:00"]],
    ["invalid date", (c: any) => c.lifecycle.since = "2026-02-30"],
    ["missing lifecycle time", (c: any) => c.lifecycle.enabled = true],
    ["missing radar channel", (c: any) => {c.radar.enabled=true;c.schedule.radarLocalTime="10:00";c.radar.topics=["AI"];c.radar.monthlyBudgetUsd=5;}],
    ["negative budget", (c: any) => c.radar.monthlyBudgetUsd = -1],
    ["non-finite budget", (c: any) => c.radar.monthlyBudgetUsd = NaN],
    ["invalid mode", (c: any) => c.screeningMode = "experimental"],
    ["missing flag", (c: any) => delete c.shadowMode],
    ["invalid email", (c: any) => c.operator.contactEmail = "operator"],
    ["unexpected credential", (c: any) => c.cloudflare.apiToken = "synthetic"],
  ])("rejects %s", (_name, mutate) => { const c = raw(); mutate(c); expect(() => parseInstanceConfig(c)).toThrow(); });
  it("validates a detached snapshot when input getters change", () => {
    const c = raw(); let reads = 0;
    Object.defineProperty(c.slack,"allowedUserId",{enumerable:true,get:()=> ++reads===1 ? "UEXAMPLE123" : ""});
    expect(parseInstanceConfig(c).slack.allowedUserId).toBe("UEXAMPLE123");
    expect(reads).toBe(1);
  });
  it("accepts IANA zones whose names contain digits", () => {
    const c = raw(); c.schedule.timezone="Etc/GMT+5";
    expect(parseInstanceConfig(c).schedule.timezone).toBe("Etc/GMT+5");
  });
  it("permits fully specified optional features", () => {
    const c = raw(); c.lifecycle.enabled=true;c.schedule.lifecycleLocalTime="10:00";
    c.radar={enabled:true,channelId:"CEXAMPLE456",monthlyBudgetUsd:5,topics:["AI"]};c.schedule.radarLocalTime="11:00";
    expect(parseInstanceConfig(c).radar.enabled).toBe(true);
  });
});
