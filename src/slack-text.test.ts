import { describe, expect, it } from "vitest";
import { splitSlackText } from "./slack-text";

describe("splitSlackText", () => {
  it("keeps an ordinary digest unchanged", () => {
    const text = "Run summary\n:warning: 15 posting(s) have screening on hold\n• AI Operations: https://example.test/jobs/15";
    expect(splitSlackText(text)).toEqual([text]);
  });

  it("continues large lists at row boundaries with every original URL intact", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      `• Job ${i}: https://careers.example.test/apply?jobSeqNo=${i}&tracking=${"x".repeat(3900)}`);
    const text = ["Run summary", ":warning: 15 posting(s) have screening on hold", ...rows].join("\n");
    const chunks = splitSlackText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text);
    expect(chunks.every(chunk => chunk.length <= 39_000)).toBe(true);
    for (const row of rows) expect(chunks.some(chunk => chunk.split("\n").includes(row))).toBe(true);
  });

  it("handles an exact size boundary without sending an oversized message", () => {
    const text = `${"x".repeat(39_000)}\nhttps://example.test/jobs/last`;
    expect(splitSlackText(text)).toEqual(["x".repeat(39_000), "https://example.test/jobs/last"]);
  });

  it("retains leading, intervening and trailing blank lines", () => {
    const text = `\n${"x".repeat(38_998)}\n\nhttps://example.test/jobs/last\n`;
    expect(splitSlackText(text).join("\n")).toBe(text);
  });

  it("rejects a single oversized row before any truncated chunks can be sent", () => {
    expect(() => splitSlackText(`Summary\nhttps://example.test/jobs/${"x".repeat(40_000)}`))
      .toThrow(/Slack.*line.*limit/i);
  });

  it("has no messages for empty text", () => {
    expect(splitSlackText("")).toEqual([]);
  });
});
