import type { ScheduleConfig } from "./types";

export type ScheduledSlot = { workflow: "fixed" | "discovery" | "lifecycle" | "radar" | "intake"; slotKey: string };
export const DISPATCHER_CRON = "*/5 * * * *";

/** Calendar slots share an ID across a DST fold; nonexistent spring slots never match.
 * Intake is a separate UTC tick, so a fold cannot suppress request/lease recovery. */
export function dueWorkflows(at: Date, schedule: ScheduleConfig): readonly ScheduledSlot[] {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid schedule date");
  if (at.getUTCMinutes() % 5 || at.getUTCSeconds() || at.getUTCMilliseconds()) return [];
  const parts = new Intl.DateTimeFormat("en", { timeZone: schedule.timezone,
    calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  const time = `${part("hour")}:${part("minute")}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const due: ScheduledSlot[] = [];
  const add = (workflow: ScheduledSlot["workflow"]) => due.push({ workflow, slotKey: `${workflow}-${date}-${time.replace(":", "")}` });
  if (schedule.discoveryWeekdays.includes(weekday) && schedule.discoveryLocalTimes.includes(time)) {
    add("fixed"); add("discovery");
  }
  if (schedule.lifecycleLocalTime === time) add("lifecycle");
  if (schedule.radarLocalTime === time) add("radar");
  const utc = at.toISOString();
  due.push({ workflow: "intake", slotKey: `intake-${utc.slice(0, 10)}-${utc.slice(11, 16).replace(":", "")}Z` });
  return due;
}
