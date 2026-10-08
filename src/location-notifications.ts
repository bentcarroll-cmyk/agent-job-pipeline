import type { CandidatePolicy } from "./config/types";
import { MAX_MATERIALS_CHARS } from "./description";
import { resolveLocationEligibility } from "./location";
import { type Source, fetchPosting, fetchCompanyBoard, type NormalizedJob } from "./sources";
import { jobRefId, parseJobUrl } from "./unbounded/discovery";
import { screeningNotificationSource, type PendingScreeningNotification } from "./screening/store";
import { recordFailure } from "./operations/retries";
import { LeaseLostError, type DiscoveryLease } from "./operations/leases";
import type { DiscoverySteps } from "./operations/discovery-run";
import { jsonToStream, streamToJson } from "./step-stream";
import { parseVerdict } from "./criteria";
import { readDiscoveryApplicationState } from "./discovery/application-state";

type Held = { jobId: string; intentId: string; reason: string };

function completeContext(job: NormalizedJob): boolean {
  const body = job.description, observed = job.contentProvenance?.description;
  const arrangementObserved = !/^(?:ashby|lever|workday):/.test(job.id) || !!job.locationMetadata;
  return typeof body === "string" && body.trim().length > 0 && arrangementObserved &&
    observed?.provided === true && observed.truncated === false && observed.originalChars === body.length &&
    observed.retainedChars === body.length && !!observed.sourceFields.length &&
    !job.contentProvenance!.coverageGaps.some(gap => !gap.startsWith("compensation:")) && !/\[(?:middle of posting|snapshot text) omitted\]/i.test(body);
}

function validateQueuedDecision(item: PendingScreeningNotification): void {
  if (item.decision && !["match", "needs_review"].includes(item.decision.state)) throw new Error("Queued screening decision is not deliverable");
  if (!item.decision && !item.verdict.match) throw new Error("Queued legacy decision is not a match");
  parseVerdict(JSON.stringify(item.verdict));
  if (item.verdict.match && /recovered from malformed model output/i.test(item.verdict.reason)) throw new Error("Historical positive decision came from malformed model output");
}

function needsRefresh(source: NormalizedJob | undefined, jobId: string, policy: CandidatePolicy): boolean {
  return !source || source.id !== jobId || !completeContext(source) || !!source.locationMetadata?.coverageGaps.length ||
    resolveLocationEligibility(source, policy).state !== "eligible";
}

export function isLocationNotificationReady(item: PendingScreeningNotification, policy: CandidatePolicy): boolean {
  try { validateQueuedDecision(item); return completeContext(item.job) && resolveLocationEligibility(item.job, policy).state === "eligible"; }
  catch { return false; }
}

// Queue rows intentionally omit source bodies. Keep each verification in its
// own durable step; a slow provider must not turn fifty fetches into one long
// callback. Ashby has no detail API, so share its board checkpoint per run.
export async function prepareLocationNotifications(
  step: DiscoverySteps, db: D1Database, lease: DiscoveryLease,
  pending: PendingScreeningNotification[], sources: readonly Source[], policy: CandidatePolicy, currentJobs: Map<string, NormalizedJob> = new Map(),
): Promise<{ ready: PendingScreeningNotification[]; held: Held[]; applicationHeld: PendingScreeningNotification[] }> {
  const ready: PendingScreeningNotification[] = [], held: Held[] = [], applicationHeld: PendingScreeningNotification[] = [];
  const boards = new Map<string, Promise<NormalizedJob[]>>();
  const board = (company: string, slug: string) => {
    const key = `${slug}:${company}`;
    if (!boards.has(key)) boards.set(key, (async () => {
      const checkpoint = await step.do(`location-board:ashby:${key}`, async () => {
        try {
          const jobs = await fetchCompanyBoard("ashby", company, slug, MAX_MATERIALS_CHARS);
          // Do not persist an entire employer catalog for a small delivery queue.
          const wanted = new Set(pending.map(item => item.job.id.split(":").at(-1)!.toLowerCase()));
          return jsonToStream({ ok: true as const, jobs: jobs.filter(job => wanted.has(job.id.split(":").at(-1)!.toLowerCase())) });
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          return { ok: false as const, error: error instanceof Error ? error.message.slice(0, 250) : "Board retrieval failed" };
        }
      });
      const result = checkpoint instanceof ReadableStream
        ? await streamToJson<{ ok: true; jobs: NormalizedJob[] }>(checkpoint) : checkpoint;
      if (!result.ok) throw new Error(result.error);
      return result.jobs;
    })());
    return boards.get(key)!;
  };

  async function reacquire(job: NormalizedJob): Promise<NormalizedJob> {
    const configured = sources.find(source => source.company === job.company && job.id.startsWith(`${source.ats}:${source.company}:`));
    let detail: NormalizedJob | null;
    if (configured && configured.ats !== "amazon") {
      const postingId = job.id.slice(`${configured.ats}:${configured.company}:`.length);
      if (!postingId || postingId.includes(":")) throw new Error("Unsupported fixed-source posting identity");
      if (configured.ats === "ashby") {
        detail = (await board(job.company, configured.slug)).find(item => item.id === job.id) ?? null;
      } else if (configured.ats === "workday") {
        const ref = parseJobUrl(job.url, job.title);
        const url = new URL(job.url);
        if (ref?.ats !== "workday" || ref.slug !== configured.tenant ||
          url.hostname !== `${configured.tenant}.${configured.wdHost}.myworkdayjobs.com` ||
          !url.pathname.split("/").includes(configured.site)) throw new Error("Workday source identity mismatch");
        detail = await fetchPosting({ ...ref, ats: "workday" }, job.company, MAX_MATERIALS_CHARS);
        if (detail && detail.id.toLowerCase() !== job.id.toLowerCase()) throw new Error("Workday posting identity mismatch");
      } else {
        if (configured.ats === "greenhouse" && !/^\d+$/.test(postingId)) throw new Error("Greenhouse posting identity mismatch");
        detail = await fetchPosting({ ats: configured.ats, slug: configured.slug, postingId, url: job.url }, job.company, MAX_MATERIALS_CHARS);
        if (detail && detail.id !== job.id) throw new Error("Posting identity mismatch");
      }
    } else {
      const ref = parseJobUrl(job.url, job.title);
      if (!ref || jobRefId(ref) !== job.id) throw new Error("Unsupported queued source identity; location needs review");
      if (ref.ats === "ashby") {
        detail = (await board(job.company, ref.slug)).find(item => item.id.split(":").at(-1)!.toLowerCase() === ref.postingId) ?? null;
      } else {
        detail = await fetchPosting({ ats: ref.ats, slug: ref.slug, postingId: ref.postingId, url: ref.url }, job.company, MAX_MATERIALS_CHARS);
        if (detail && ref.ats !== "workday" && detail.id.split(":").at(-1)!.toLowerCase() !== ref.postingId) throw new Error("Posting identity mismatch");
        if (detail && ref.ats === "workday") {
          const returned = parseJobUrl(detail.url, detail.title);
          if (!returned || jobRefId(returned) !== job.id) throw new Error("Workday posting identity mismatch");
        }
      }
    }
    if (!detail) throw new Error("Posting unavailable; location could not be reverified");
    return { ...detail, id: job.id };
  }

  for (const item of pending) {
    const notificationId = item.evaluationId ?? item.job.id;
    const application = await step.do(`verify-notification-application:${notificationId}`,
      async () => readDiscoveryApplicationState(db, item.job, sources));
    if (application.kind !== "clear") { applicationHeld.push(item); continue; }
    let retained = currentJobs.get(item.job.id);
    if (!retained && item.evaluationId) retained = await step.do(`load-notification-source:${item.evaluationId}`,
      async () => screeningNotificationSource(db, item.job.id, item.evaluationId!)) ?? undefined;
    // Resolve the shared board checkpoint outside the per-posting callback;
    // Workflow steps must not be nested. A cached board error is recorded for
    // each affected posting inside its own guarded verification step below.
    if (needsRefresh(retained, item.job.id, policy)) {
      const configured = sources.find(source => source.ats === "ashby" && source.company === item.job.company && item.job.id.startsWith(`ashby:${source.company}:`));
      const ref = parseJobUrl(item.job.url, item.job.title);
      const slug = configured?.ats === "ashby" ? configured.slug
        : ref?.ats === "ashby" && jobRefId(ref) === item.job.id ? ref.slug : null;
      if (slug) { try { await board(item.job.company, slug); } catch (error) { if (error instanceof LeaseLostError) throw error; } }
    }
    const result = await step.do(`verify-notification-location:${notificationId}`, async () => {
      try {
        validateQueuedDecision(item);
        let source = retained;
        if (needsRefresh(source, item.job.id, policy)) source = await reacquire(item.job);
        if (!source) throw new Error("Posting context is unavailable");
        if (!completeContext(source)) throw new Error("Complete posting/location source coverage is unavailable");
        const location = resolveLocationEligibility(source, policy);
        if (location.state !== "eligible") throw new Error(location.reason);
        return { ready: { ...item, job: source } };
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        const reason = `Location delivery held: ${error instanceof Error ? error.message : "Location verification failed"}`.slice(0, 500);
        // Preserve the old assessment and notification receipt. Projecting a
        // retry onto an existing job would remove it from both delivery queues.
        await recordFailure(db, lease, item.job.id, "fetch", reason);
        return { held: { jobId: item.job.id, intentId: notificationId, reason } };
      }
    });
    if (result.ready) ready.push(result.ready);
    else held.push(result.held);
  }
  return { ready, held, applicationHeld };
}

export function locationHoldMessage(held: Held[]): string {
  return `${held.length} queued posting(s) held for location verification; saved decisions and delivery receipts remain unchanged. ` +
    held.slice(0, 3).map(item => `${item.jobId}: ${item.reason.slice(0, 160)}`).join("; ") +
    (held.length > 3 ? `; ${held.length - 3} additional hold(s) recorded in run errors.` : "");
}
