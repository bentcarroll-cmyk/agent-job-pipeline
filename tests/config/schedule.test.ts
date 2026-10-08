import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dueWorkflows } from "../../src/config/schedule";
import type { ScheduleConfig } from "../../src/config/types";
import { parseInstanceConfig } from "../../src/config/instance";

const instance = () => JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
describe("five-minute schedule admission", () => {
  it.each(["discoveryLocalTimes", "lifecycleLocalTime", "radarLocalTime"])("rejects off-grid %s before activation", field => {
    const raw = instance();
    raw.schedule[field] = field === "discoveryLocalTimes" ? ["09:02"] : "09:02";
    expect(() => parseInstanceConfig(raw)).toThrow(/schedule/);
  });
});

const schedule: ScheduleConfig = { timezone: "America/New_York", discoveryLocalTimes: ["01:30", "02:30", "03:30"], discoveryWeekdays: [7], lifecycleLocalTime: "01:30", radarLocalTime: "01:30" };
const calendar = (at: string, config = schedule) => dueWorkflows(new Date(at), config).filter(slot => slot.workflow !== "intake");
describe("local calendar scheduling", () => {
  it("uses the same approved IDs in both fall-back occurrences", () => {
    const want = [{ workflow: "fixed", slotKey: "fixed-2026-11-01-0130" }, { workflow: "discovery", slotKey: "discovery-2026-11-01-0130" }, { workflow: "lifecycle", slotKey: "lifecycle-2026-11-01-0130" }, { workflow: "radar", slotKey: "radar-2026-11-01-0130" }];
    expect(calendar("2026-11-01T05:30:00Z")).toEqual(want);
    expect(calendar("2026-11-01T06:30:00Z")).toEqual(want);
    expect(calendar("2026-11-01T05:30:00Z")).toEqual(want);
  });
  it("skips nonexistent spring-forward times and resumes at the next real slot", () => {
    const day = { ...schedule, discoveryLocalTimes: ["02:30", "03:30"], lifecycleLocalTime: null, radarLocalTime: null };
    expect(calendar("2026-03-08T06:30:00Z", day)).toEqual([]);
    expect(calendar("2026-03-08T07:30:00Z", day)).toEqual([{ workflow: "fixed", slotKey: "fixed-2026-03-08-0330" }, { workflow: "discovery", slotKey: "discovery-2026-03-08-0330" }]);
  });
  it("evaluates the local date and ISO weekday in a second timezone", () => {
    const kathmandu = { ...schedule, timezone: "Asia/Kathmandu", discoveryWeekdays: [1], discoveryLocalTimes: ["00:00"], lifecycleLocalTime: null, radarLocalTime: null };
    expect(calendar("2026-10-11T18:15:00Z", kathmandu)).toEqual([{ workflow: "fixed", slotKey: "fixed-2026-10-12-0000" }, { workflow: "discovery", slotKey: "discovery-2026-10-12-0000" }]);
    expect(calendar("2026-10-12T18:15:00Z", kathmandu)).toEqual([]);
  });
  it("runs daily lifecycle/radar independently of discovery weekdays", () => {
    expect(calendar("2026-10-12T05:30:00Z")).toEqual([{ workflow: "lifecycle", slotKey: "lifecycle-2026-10-12-0130" }, { workflow: "radar", slotKey: "radar-2026-10-12-0130" }]);
  });
  it("gives intake recovery a distinct UTC slot on every tick across the fold", () => {
    expect(dueWorkflows(new Date("2026-11-01T05:30:00Z"), schedule).find(slot => slot.workflow === "intake")).toEqual({ workflow: "intake", slotKey: "intake-2026-11-01-0530Z" });
    expect(dueWorkflows(new Date("2026-11-01T06:30:00Z"), schedule).find(slot => slot.workflow === "intake")).toEqual({ workflow: "intake", slotKey: "intake-2026-11-01-0630Z" });
  });
  it("ignores off-grid tick deliveries and rejects invalid dates", () => {
    expect(dueWorkflows(new Date("2026-11-01T05:31:00Z"), schedule)).toEqual([]);
    expect(dueWorkflows(new Date("2026-11-01T05:30:01Z"), schedule)).toEqual([]);
    expect(() => dueWorkflows(new Date("invalid"), schedule)).toThrow(/date/i);
  });
});
