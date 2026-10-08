import type { DiscoveryLease } from "../operations/leases";
import type { NormalizedJob, SourceObservation } from "../sources";
import { isExcludedCompany, jobRefId, parseJobUrl, titleCaseSlug,
  type ExclusionSet, type SearchPageEvent } from "../unbounded/discovery";
import { recordQueryPage, recordUrlObservations, type UrlObservation } from "./coverage";

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function pageErrorCode(error: string | null, httpStatus: number | null): string {
  const status = httpStatus ?? Number(/\bHTTP\s+(\d{3})\b/i.exec(error ?? "")?.[1]);
  if (Number.isSafeInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
  if (/abort|timeout|timed out|deadline/i.test(error ?? "")) return "timeout";
  if (/json|parse|organic|malformed|invalid response/i.test(error ?? "")) return "malformed_response";
  if (/blocked|forbidden|access denied/i.test(error ?? "")) return "access_blocked";
  return "provider_error";
}

// Query keys are work-record identities, not job identities. Retain
// job-specific parameters such as jobSeqNo while dropping common tracking.
export function observedUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    const icimsDisplayKeys = url.hostname.endsWith(".icims.com")
      ? new Set(["mode", "iis", "iisn", "mobile", "width", "height", "bga",
        "needsredirect", "jan1offset", "jun1offset", "in_iframe"])
      : null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["gclid", "fbclid", "token", "session", "auth", "email", "access_token", "id_token"].includes(key.toLowerCase()) ||
        icimsDisplayKeys?.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.href;
  } catch {
    return null;
  }
}

export async function observeSearchPage(db: D1Database, lease: DiscoveryLease,
  event: SearchPageEvent, exclusion: ExclusionSet, maxPages: number, phrases: readonly string[]): Promise<void> {
  const phraseIndex = phrases.indexOf(event.phrase);
  if (phraseIndex < 0) throw new Error("Unknown baseline query phrase");
  const queryId = `baseline-${String(phraseIndex + 1).padStart(3, "0")}`;
  const base = { runId: lease.owner, queryId, page: event.page,
    attemptId: `${lease.owner}:${queryId}:${event.page}:1`,
    startedAt: event.startedAt, queryHash: await sha256(event.query) };
  if (event.status === "complete") {
    const observations: UrlObservation[] = [];
    for (const [ordinal, result] of (event.results ?? []).entries()) {
      const normalizedUrl = observedUrl(result.link);
      const ref = normalizedUrl ? parseJobUrl(normalizedUrl, result.title) : null;
      const excluded = ref && isExcludedCompany(ref.ats, ref.slug, titleCaseSlug(ref.slug), exclusion);
      const outcome: UrlObservation["outcome"] = !normalizedUrl ? "malformed" :
        excluded ? "excluded" : ref ? "resolved" : "unsupported";
      observations.push({ ...base, ordinal,
        rawUrl: normalizedUrl, normalizedUrl, outcome,
        jobId: outcome === "resolved" ? jobRefId(ref!) : null,
        reasonCode: outcome === "unsupported" ? "unsupported_employer_url" : null });
    }
    await recordUrlObservations(db, lease, observations);
  }
  await recordQueryPage(db, lease, { ...base,
    finishedAt: event.finishedAt,
    status: event.status === "started" ? "uncertain" : event.status,
    rawHits: event.results?.length ?? 0,
    httpStatus: event.httpStatus,
    errorCode: event.status === "failed" ? pageErrorCode(event.error, event.httpStatus) : null,
    stoppedBy: event.status === "failed" ? "failure" :
      event.status === "complete" ? (event.results?.length === 0 ? "empty" :
        event.page >= maxPages ? "page_limit" : null) : null });
}

function sourceKey(event: SourceObservation): string {
  const source = event.source;
  return `fixed:${source.ats}:${"slug" in source ? source.slug :
    "tenant" in source ? source.tenant : source.category}`;
}

export async function observeFixedSource(db: D1Database, lease: DiscoveryLease,
  event: SourceObservation): Promise<void> {
  const queryId = sourceKey(event);
  const base = { runId: lease.owner, queryId, page: 1,
    attemptId: `${lease.owner}:${queryId}:1:1`, startedAt: event.startedAt,
    queryHash: await sha256(queryId) };
  if (event.status === "complete") {
    const observations: UrlObservation[] = [];
    for (const [ordinal, job] of event.jobs.entries()) {
      const normalizedUrl = observedUrl(job.url);
      observations.push({ ...base, ordinal,
        rawUrl: normalizedUrl, normalizedUrl,
        outcome: normalizedUrl ? "resolved" : "malformed",
        jobId: normalizedUrl ? job.id : null });
    }
    await recordUrlObservations(db, lease, observations);
  }
  await recordQueryPage(db, lease, { ...base, finishedAt: event.finishedAt,
    status: event.status === "started" ? "uncertain" : event.status,
    rawHits: event.jobs.length, httpStatus: null,
    errorCode: event.status === "failed" ? pageErrorCode(event.error, null) : null,
    stoppedBy: event.status === "failed" ? "failure" : event.status === "complete" ? "page_limit" : null });
}

// Older tests and callers may provide an aggregate result rather than source
// callbacks. Keep it visible as aggregate coverage, without inventing boards.
export async function observeFixedAggregate(db: D1Database, lease: DiscoveryLease,
  jobs: NormalizedJob[], errors: string[]): Promise<void> {
  const startedAt = new Date().toISOString();
  await observeFixedSource(db, lease, { source: { company: "Aggregate", companyCategory: "applied AI",
    ats: "greenhouse", slug: "aggregate" }, status: "started", startedAt, finishedAt: null,
    jobs: [], error: null });
  await observeFixedSource(db, lease, { source: { company: "Aggregate", companyCategory: "applied AI",
    ats: "greenhouse", slug: "aggregate" }, status: "complete", startedAt, finishedAt: new Date().toISOString(),
    jobs, error: null });
  for (const [i, error] of errors.entries()) {
    const key = `reported-error-${i + 1}`;
    const at = new Date().toISOString();
    const source = { company: key, companyCategory: "applied AI" as const,
      ats: "greenhouse" as const, slug: key };
    await observeFixedSource(db, lease, {source,status:"started",startedAt:at,finishedAt:null,jobs:[],error:null});
    await observeFixedSource(db, lease, {source,status:"failed",startedAt:at,finishedAt:new Date().toISOString(),
      jobs:[],error});
  }
}
