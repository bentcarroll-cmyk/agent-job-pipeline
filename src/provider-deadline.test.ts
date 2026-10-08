import { afterEach, expect, it, vi } from "vitest";
import { fetchPosting, fetchCompanyBoard } from "./sources";
import { searchSerper } from "./unbounded/discovery";
import { postText } from "./slack";
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function hang(body: boolean) {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(5));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (body) return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
    } }));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }));
}
const ref = { ats: "workday" as const, slug: "fixture", postingId: "r1", url: "https://fixture.wd1.myworkdayjobs.com/Careers/job/DC/AI_R1" };
it.each([false, true])("bounds a stalled Workday request including response body=%s", async (body) => {
  hang(body); await expect(fetchPosting(ref, "Fixture")).rejects.toThrow(/timeout/i);
}, 500);
it("bounds a stalled Ashby board response body", async () => {
  hang(true); await expect(fetchCompanyBoard("ashby", "Fixture", "fixture")).rejects.toThrow(/timeout/i);
}, 500);
it("bounds stalled search and Slack requests", async () => {
  hang(true);
  await expect(searchSerper("fixture", "query", 1, "qdr:m")).rejects.toThrow(/timeout/i);
  await expect(postText({ SLACK_BOT_TOKEN: "fixture", SLACK_CHANNEL_ID: "fixture" }, "text")).rejects.toThrow(/timeout/i);
}, 500);
