import { matchesWorkdayRequisition, normalizeWorkdayRequisition, sameWorkdaySite, workdayDetailUrl } from "../sources";
import { jobRefId, parseJobUrl, type JobRef } from "../unbounded/discovery";
import { normalizeJobPosting } from "./jobposting";
import { observedUrl } from "./observe";
import { SafeFetchError } from "./safe-fetch";
import type { EmployerSource, ResolutionResult, ResolverDependencies, SafePage } from "./types";

const LIMITS = { maxRequests: 4, maxRedirects: 2, maxBytes: 1_048_576, timeoutMs: 15_000 };

function held(reason: "unsupported" | "ambiguous" | "blocked" | "not_found" | "invalid_identity" | "budget_exhausted" | "transient",
  detail: string, retryable = false): ResolutionResult {
  return { kind: "held", reason, detail, retryable };
}

export function directAtsResolution(ref: JobRef): ResolutionResult {
  return { kind: "resolved", posting: { kind: "ats", jobId: jobRefId(ref), canonicalUrl: ref.url, ref },
    aliases: [observedUrl(ref.url) ?? ref.url],
    evidence: [{ url: ref.url, method: "direct_ats", employerKey: null, requisitionId: ref.postingId }] };
}

function validHost(urlText: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(urlText);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}

function links(page: SafePage): string[] {
  return [...page.body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)]
    .map(match => { try { return new URL(match[1], page.finalUrl).href; } catch { return null; } })
    .filter((url): url is string => !!url);
}

function mapFetchError(error: unknown): ResolutionResult {
  if (error instanceof SafeFetchError) return held(error.reason,
    error.message.slice(0, 180), error.reason === "transient" || error.reason === "blocked");
  return held("transient", "Employer page fetch failed", true);
}

async function verifyWorkday(ref: JobRef, originalUrl: string, page: SafePage,
  source: EmployerSource, deps: ResolverDependencies,
  native: ResolutionResult): Promise<ResolutionResult> {
  if (ref.ats !== "workday") return held("unsupported", "Observed ATS link has no verified detail adapter");
  const redirected = page.finalUrl === ref.url;
  if (!redirected) {
    if (native.kind !== "resolved" || native.posting.kind !== "employer") return native.kind === "held" ? native :
      held("invalid_identity", "Embedded Workday link lacks same-job employer identity");
    if (!matchesWorkdayRequisition(ref.url, native.posting.requisitionId)) {
      return held("invalid_identity", "Embedded Workday link conflicts with employer requisition");
    }
  }
  const detailUrl = workdayDetailUrl(ref.url);
  if (!detailUrl || !validHost(detailUrl, source.atsHosts)) return held("unsupported", "Workday detail host is not verified");
  const remaining = LIMITS.maxRequests - page.requestCount;
  if (remaining < 1) return held("budget_exhausted", "Resolver request budget exhausted", true);
  let detail: SafePage;
  try {
    detail = await deps.fetchPage(detailUrl, { ...LIMITS, maxRequests: remaining,
      maxRedirects: Math.max(0, LIMITS.maxRedirects - page.redirects.length) });
  } catch (error) { return mapFetchError(error); }
  if (page.requestCount + detail.requestCount > LIMITS.maxRequests ||
    page.redirects.length + detail.redirects.length > LIMITS.maxRedirects) {
    return held("budget_exhausted", "Resolver request budget exceeded", true);
  }
  if (!validHost(detail.finalUrl, source.atsHosts)) return held("unsupported", "Workday detail escaped verified host");
  if (detail.status === 403) return held("blocked", "Workday detail denied access", true);
  if (detail.status === 404 || detail.status === 410) return held("not_found", `Workday detail HTTP ${detail.status}`);
  if (detail.status === 429 || detail.status >= 500) return held("transient", `Workday detail HTTP ${detail.status}`, true);
  if (detail.status !== 200) return held("unsupported", `Workday detail HTTP ${detail.status}`);
  let info: Record<string, unknown>;
  try { info = (JSON.parse(detail.body) as {jobPostingInfo?: Record<string, unknown>}).jobPostingInfo ?? {}; }
  catch { return held("transient", "Workday detail response is unreadable", true); }
  // Normalized once so the URL match, the employer comparison and the alias
  // evidence all use Workday's URL form (alias evidence rejects whitespace).
  const requisition = typeof info.jobReqId === "string" ? normalizeWorkdayRequisition(info.jobReqId) : "";
  if (!requisition || !matchesWorkdayRequisition(ref.url, requisition) ||
    (native.kind === "resolved" && native.posting.kind === "employer" &&
      requisition.toLowerCase() !== native.posting.requisitionId.toLowerCase())) {
    return held("invalid_identity", "Workday detail requisition conflicts with observed posting");
  }
  if (typeof info.title !== "string" || !info.title.trim() ||
    typeof info.jobDescription !== "string" || !info.jobDescription.trim()) {
    return held("transient", "Workday detail is incomplete", true);
  }
  const external = typeof info.externalUrl === "string" ? info.externalUrl : null;
  let canonical = ref.url;
  if (external) {
    const candidate = parseJobUrl(external, info.title);
    if (!candidate || candidate.ats !== "workday" || candidate.slug !== ref.slug ||
      candidate.postingId !== ref.postingId || !sameWorkdaySite(ref.url, candidate.url) ||
      !matchesWorkdayRequisition(candidate.url, requisition)) {
      return held("invalid_identity", "Workday detail canonical URL conflicts with observed posting");
    }
    canonical = candidate.url;
  }
  const canonicalRef = parseJobUrl(canonical, info.title)!;
  const aliases = [...new Set([originalUrl, page.finalUrl, ref.url, canonical]
    .map(observedUrl).filter((url): url is string => !!url))];
  return { kind: "resolved", posting: { kind: "ats", jobId: jobRefId(canonicalRef),
    canonicalUrl: canonical, ref: canonicalRef }, aliases,
    evidence: [{ url: originalUrl, method: redirected ? "redirect" : "embedded_ats",
      employerKey: source.key, requisitionId: requisition },
    { url: detailUrl, method: "canonical", employerKey: source.key, requisitionId: requisition }] };
}

export async function resolvePostingUrl(input: { url: string; titleHint?: string },
  deps: ResolverDependencies): Promise<ResolutionResult> {
  const directRef = parseJobUrl(input.url, input.titleHint ?? "");
  if (directRef) return directAtsResolution(directRef);
  let parsed: URL;
  try { parsed = new URL(input.url); }
  catch { return held("unsupported", "Invalid URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    return held("unsupported", "URL is outside the HTTPS fetch boundary");
  }
  const source = deps.registry.find(item => item.careerHosts.includes(parsed.hostname));
  if (!source) return held("unsupported", "Employer host is not in the verified registry");
  let page: SafePage;
  try { page = await deps.fetchPage(input.url, LIMITS); }
  catch (error) { return mapFetchError(error); }
  if (page.requestCount > LIMITS.maxRequests || page.redirects.length > LIMITS.maxRedirects ||
    !validHost(page.finalUrl, [...source.careerHosts, ...source.atsHosts])) {
    return held("unsupported", "Fetched page exceeded the verified source boundary");
  }
  if (page.status === 403) return held("blocked", "Employer page denied access", true);
  if (page.status === 404 || page.status === 410) return held("not_found", `Employer page HTTP ${page.status}`);
  if (page.status === 429 || page.status >= 500) return held("transient", `Employer page HTTP ${page.status}`, true);
  if (page.status !== 200) return held("unsupported", `Employer page HTTP ${page.status}`);
  const native = validHost(page.finalUrl, source.careerHosts)
    ? normalizeJobPosting(source, page)
    : held("unsupported", "Redirected ATS page requires identity verification");
  const observed = [page.finalUrl, ...links(page)]
    .filter(url => validHost(url, source.atsHosts))
    .map(url => parseJobUrl(url, input.titleHint ?? ""))
    .filter((ref): ref is JobRef => !!ref);
  const unique = [...new Map(observed.map(ref => [jobRefId(ref), ref])).values()];
  if (unique.length > 1) return held("ambiguous", "Employer page links to incompatible ATS postings");
  if (unique.length === 1) return verifyWorkday(unique[0], input.url, page, source, deps, native);
  return native;
}
