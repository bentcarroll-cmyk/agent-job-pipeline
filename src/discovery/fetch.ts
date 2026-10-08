import { isPostingIdentityConflict, normalizeAshby, normalizeGreenhouse, normalizeLever, normalizeWorkdayPosting,
  sameWorkdaySite, workdayDetailUrl, type NormalizedJob } from "../sources";
import { jobRefId, parseJobUrl, titleCaseSlug, type JobRef } from "../unbounded/discovery";
import { normalizeJobPosting } from "./jobposting";
import { SafeFetchError } from "./safe-fetch";
import type { PostingFetchResult, ResolvedPosting, ResolverDependencies, SafePage } from "./types";

const LIMITS = { maxRequests: 2, maxRedirects: 1, maxBytes: 1_048_576, timeoutMs: 15_000 };

function held(reason: "blocked" | "transient" | "unsupported" | "invalid_identity" | "incomplete",
  detail: string, sourceUrl: string, httpStatus: number | null,
  retryable = reason === "blocked" || reason === "transient" || reason === "incomplete"): PostingFetchResult {
  return { kind: "held", reason, detail, sourceUrl, httpStatus, retryable };
}

function status(page: SafePage, deps: ResolverDependencies): PostingFetchResult | null {
  if (page.status === 404 || page.status === 410) return { kind: "not_found",
    reason: page.status === 404 ? "http_404" : "http_410", sourceUrl: page.finalUrl,
    checkedAt: deps.now(), httpStatus: page.status };
  if (page.status === 403) return held("blocked", "Source denied access", page.finalUrl, page.status);
  if (page.status === 429 || page.status >= 500) return held("transient", `Source HTTP ${page.status}`, page.finalUrl, page.status);
  if (page.status !== 200) return held("unsupported", `Source HTTP ${page.status}`, page.finalUrl, page.status);
  return null;
}

function endpoint(ref: JobRef): string | null {
  if (ref.ats === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.slug)}/jobs/${encodeURIComponent(ref.postingId)}`;
  if (ref.ats === "lever") return `https://api.lever.co/v0/postings/${encodeURIComponent(ref.slug)}/${encodeURIComponent(ref.postingId)}`;
  if (ref.ats === "ashby") return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(ref.slug)}?includeCompensation=true`;
  return workdayDetailUrl(ref.url);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function atsJob(ref: JobRef, body: unknown, page: SafePage): PostingFetchResult {
  const sourceUrl = page.finalUrl;
  const bad = (reason: "invalid_identity" | "incomplete", detail: string) => held(reason, detail, sourceUrl, page.status);
  const company = titleCaseSlug(ref.slug);
  let raw: Record<string, unknown> | null = object(body);
  if (ref.ats === "ashby") {
    const jobs = raw?.jobs;
    if (!Array.isArray(jobs) || !jobs.length || jobs.some(item => !object(item) ||
      typeof item.id !== "string" || !item.id || typeof item.title !== "string" || !item.title)) {
      return bad("incomplete", "Ashby board is empty or malformed");
    }
    const match = jobs.find(item => String(item.id).toLowerCase() === ref.postingId);
    if (!match) {
      if (raw?.hasMore !== false || (typeof raw.total === "number" && raw.total !== jobs.length)) {
        return bad("incomplete", "Ashby board completeness is unproven");
      }
      return { kind: "not_found", reason: "absent_complete_board", sourceUrl,
        checkedAt: page.fetchedAt, httpStatus: page.status };
    }
    raw = object(match);
  }
  if (!raw) return bad("incomplete", "Posting detail is not an object");
  let job: NormalizedJob;
  try {
    if (ref.ats === "greenhouse") {
      const observed = String(raw.id ?? "");
      const canonical = typeof raw.absolute_url === "string" ? parseJobUrl(raw.absolute_url, "") : null;
      if (observed !== ref.postingId || !canonical || jobRefId(canonical) !== jobRefId(ref)) {
        return bad("invalid_identity", "Greenhouse detail conflicts with requested job");
      }
      job = normalizeGreenhouse(company, raw);
    } else if (ref.ats === "lever") {
      const canonical = typeof raw.hostedUrl === "string" ? parseJobUrl(raw.hostedUrl, "") : null;
      if (String(raw.id ?? "").toLowerCase() !== ref.postingId || !canonical ||
        jobRefId(canonical) !== jobRefId(ref)) return bad("invalid_identity", "Lever detail conflicts with requested job");
      job = normalizeLever(company, raw);
    } else if (ref.ats === "ashby") {
      const canonicalUrl = raw.jobUrl ?? raw.applyUrl;
      const canonical = typeof canonicalUrl === "string" ? parseJobUrl(canonicalUrl, "") : null;
      if (!canonical || jobRefId(canonical) !== jobRefId(ref)) return bad("invalid_identity", "Ashby detail conflicts with requested job");
      job = normalizeAshby(company, raw);
    } else {
      job = normalizeWorkdayPosting(company,
        { ats: "workday", slug: ref.slug, postingId: ref.postingId, url: ref.url }, raw);
      const info = object(raw.jobPostingInfo);
      if (typeof info?.externalUrl === "string") {
        const canonical = parseJobUrl(info.externalUrl, "");
        if (!canonical || jobRefId(canonical) !== jobRefId(ref) || !sameWorkdaySite(canonical.url, ref.url)) {
          return bad("invalid_identity", "Workday canonical URL conflicts with requested job");
        }
      }
    }
  } catch (error) {
    return bad(isPostingIdentityConflict(error) ? "invalid_identity" : "incomplete",
      "Posting detail failed identity or completeness checks");
  }
  if (!job.title || !job.description || !job.description.trim()) return bad("incomplete", "Posting lacks usable title or description");
  return { kind: "fetched", job: { ...job, id: jobRefId(ref) }, sourceUrl, fetchedAt: page.fetchedAt };
}

export async function fetchResolvedPosting(posting: ResolvedPosting,
  deps: ResolverDependencies): Promise<PostingFetchResult> {
  const sourceUrl = posting.kind === "employer" ? posting.canonicalUrl : endpoint(posting.ref);
  if (!sourceUrl) return held("unsupported", "Posting has no verified detail endpoint", posting.canonicalUrl, null, false);
  if (posting.kind === "employer") {
    let hostname: string;
    try { hostname = new URL(sourceUrl).hostname; }
    catch { return held("unsupported", "Stored employer URL is invalid", sourceUrl, null, false); }
    const source = deps.registry.find(item => item.key === posting.employerKey &&
      item.careerHosts.includes(hostname));
    if (!source) return held("unsupported", "Employer is not in the verified registry", sourceUrl, null, false);
  }
  let page: SafePage;
  try { page = await deps.fetchPage(sourceUrl, LIMITS); }
  catch (error) {
    const reason = error instanceof SafeFetchError ? error.reason : "transient";
    return held(reason === "budget_exhausted" ? "incomplete" : reason,
      "Posting fetch failed within the safe boundary", sourceUrl, null);
  }
  if (page.finalUrl !== sourceUrl || page.requestCount > LIMITS.maxRequests || page.redirects.length > LIMITS.maxRedirects) {
    return held("unsupported", "Posting detail redirected or exceeded fetch budget", sourceUrl, page.status, false);
  }
  const classified = status(page, deps);
  if (classified) return classified;
  if (posting.kind === "employer") {
    const source = deps.registry.find(item => item.key === posting.employerKey)!;
    const result = normalizeJobPosting(source, page);
    if (result.kind === "held") return held(result.reason === "invalid_identity" || result.reason === "ambiguous"
      ? "invalid_identity" : "incomplete", result.detail, sourceUrl, page.status);
    if (result.posting.kind !== "employer" || result.posting.jobId !== posting.jobId ||
      result.posting.requisitionId !== posting.requisitionId || result.posting.canonicalUrl !== posting.canonicalUrl) {
      return held("invalid_identity", "Employer posting identity changed", sourceUrl, page.status, false);
    }
    return { kind: "fetched", job: result.posting.job, sourceUrl, fetchedAt: page.fetchedAt };
  }
  let body: unknown;
  try { body = JSON.parse(page.body); }
  catch { return held("incomplete", "ATS detail is unreadable JSON", sourceUrl, page.status); }
  return atsJob(posting.ref, body, page);
}
