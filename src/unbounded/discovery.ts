import { fetchWithDeadline } from "../operations/fetch";
export type AtsPlatform = "greenhouse" | "ashby" | "lever" | "workday";

const ATS_HOST_MAP: Record<string, AtsPlatform> = {
  "boards.greenhouse.io": "greenhouse",
  "job-boards.greenhouse.io": "greenhouse",
  "jobs.ashbyhq.com": "ashby",
  "jobs.lever.co": "lever",
};

export type JobRef = {
  ats: AtsPlatform;
  slug: string;
  postingId: string;
  url: string;
  title: string;
};

// Path segments that are never a posting id — real search results include
// apply/application URLs, and taking the last segment would collapse every
// one of them onto the same identity.
const NON_ID_SEGMENTS = new Set(["application", "apply"]);

// Workday gives every customer its own host — {tenant}.{wdN}.myworkdayjobs.com
// — so it cannot use the exact-match host table above. Anchored at both ends:
// a substring match could accept an attacker-controlled host suffix.
const WORKDAY_HOST = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/i;
// Optional locale segment, e.g. /en-US/ before the career-site name.
const WORKDAY_LOCALE = /^[a-z]{2}-[a-z]{2}$/i;
// Public paths end in the requisition id after an underscore:
// .../job/Location/Role_REQ-123
const WORKDAY_REQ_ID = /_([A-Za-z0-9][A-Za-z0-9-]*)$/;

export function parseJobUrl(url: string, title: string): JobRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  const workday = WORKDAY_HOST.exec(parsed.hostname);
  if (workday) return parseWorkdayUrl(parsed, workday[1], url, title);

  const ats = ATS_HOST_MAP[parsed.hostname];
  if (!ats) return null;

  let segments: string[];
  try {
    segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null; // malformed percent-encoding
  }

  const slug = segments[0];
  if (!slug) return null;

  // Greenhouse posting URLs are /{slug}/jobs/{id}; Ashby and Lever are
  // /{slug}/{id}, optionally followed by /application or /apply.
  const postingId = ats === "greenhouse" ? (segments[1] === "jobs" ? segments[2] : undefined) : segments[1];
  if (!postingId || NON_ID_SEGMENTS.has(postingId.toLowerCase())) return null;

  return { ats, slug: slug.toLowerCase(), postingId: postingId.toLowerCase(), url, title };
}

// The requisition id is the only stable identifier in a Workday URL — the
// rest of the path is a slugified title and location that change when the
// posting is edited. The full URL is kept because the JSON detail endpoint
// is derived from it (see fetchPosting): the career-site name and external
// path cannot be reconstructed from tenant and requisition alone.
function parseWorkdayUrl(parsed: URL, tenant: string, url: string, title: string): JobRef | null {
  const rawSegments = parsed.pathname.split("/").filter(Boolean);
  let segments: string[];
  try {
    segments = rawSegments.map(decodeURIComponent);
  } catch {
    return null;
  }
  const localeOffset = segments.length > 0 && WORKDAY_LOCALE.test(segments[0]) ? 1 : 0;
  segments = segments.slice(localeOffset);

  // A link copied from the application form ends in /apply, sometimes with a
  // mode after it (/apply/applyManually). The detail endpoint rejects that
  // path, so both the segments and the kept URL stop at the posting itself.
  const applyAt = segments.findIndex((segment, i) => i >= 3 && segment.toLowerCase() === "apply");
  if (applyAt !== -1) {
    segments = segments.slice(0, applyAt);
    url = `${parsed.origin}/${rawSegments.slice(0, localeOffset + applyAt).join("/")}`;
  }

  // [site, "job", ...location/title segments]
  if (segments.length < 3 || segments[1].toLowerCase() !== "job") return null;

  const requisition = WORKDAY_REQ_ID.exec(segments[segments.length - 1]);
  if (!requisition) return null;

  return { ats: "workday", slug: tenant.toLowerCase(), postingId: requisition[1].toLowerCase(), url, title };
}

export function jobRefId(ref: JobRef): string {
  return `${ref.ats}:${ref.slug}:${ref.postingId}`;
}

const SITE_FILTER = "(site:boards.greenhouse.io OR site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com OR site:jobs.lever.co OR site:myworkdayjobs.com)";

export function buildSearchQuery(phrase: string): string {
  return `${SITE_FILTER} "${phrase}"`;
}

export function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface ExclusionSet {
  slugs: Set<string>;
  companyNames: Set<string>;
}

export function buildExclusionSet(
  sources: ReadonlyArray<{ company: string; ats: string; slug?: string; tenant?: string }>,
  unresolvedCompanies: readonly string[],
): ExclusionSet {
  const slugs = new Set<string>();
  const companyNames = new Set<string>();
  for (const source of sources) {
    companyNames.add(source.company.toLowerCase());
    if (source.slug) slugs.add(`${source.ats}:${source.slug.toLowerCase()}`);
    if (source.tenant) slugs.add(`${source.ats}:${source.tenant.toLowerCase()}`);
  }
  for (const company of unresolvedCompanies) {
    companyNames.add(company.toLowerCase());
  }
  return { slugs, companyNames };
}

export function isExcludedCompany(
  ats: AtsPlatform,
  slug: string,
  companyLabel: string,
  exclusion: ExclusionSet,
): boolean {
  if (exclusion.slugs.has(`${ats}:${slug.toLowerCase()}`)) return true;
  return exclusion.companyNames.has(companyLabel.toLowerCase());
}

export function pickRotationWindow(
  bank: readonly string[],
  startIndex: number,
  count: number,
): { phrases: string[]; nextIndex: number } {
  if (bank.length === 0) return { phrases: [], nextIndex: 0 };
  const normalizedStart = ((startIndex % bank.length) + bank.length) % bank.length;
  const windowSize = Math.min(count, bank.length);
  const phrases: string[] = [];
  for (let i = 0; i < windowSize; i++) {
    phrases.push(bank[(normalizedStart + i) % bank.length]);
  }
  const nextIndex = (normalizedStart + windowSize) % bank.length;
  return { phrases, nextIndex };
}

export interface PhraseSearchResult {
  refs: JobRef[];
  errors: string[];
}

export type SearchPageEvent = {
  phrase: string;
  query: string;
  page: number;
  status: "started" | "complete" | "failed";
  startedAt: string;
  finishedAt: string | null;
  results: SerperOrganicResult[] | null;
  httpStatus: number | null;
  error: string | null;
};

// Isolated per phrase: searchSerper throws on any non-2xx (a single 429 or
// transient 5xx), and without this try/catch one bad page would propagate
// out of the whole function, discarding every posting already found by
// other, successful phrases. Errors are collected and returned instead —
// the caller merges them into its own errors array — and the run proceeds
// with whatever partial results came back rather than losing the lot.
export async function findPostingsForPhrases(
  apiKey: string,
  phrases: string[],
  exclusion: ExclusionSet,
  maxPagesPerPhrase: number,
  onPage?: (event: SearchPageEvent) => Promise<void>,
): Promise<PhraseSearchResult> {
  const found = new Map<string, JobRef>();
  const errors: string[] = [];
  for (const phrase of phrases) {
    const query = buildSearchQuery(phrase);
    for (let page = 1; page <= maxPagesPerPhrase; page++) {
      const startedAt = new Date().toISOString();
      await onPage?.({ phrase, query, page, status: "started", startedAt, finishedAt: null,
        results: null, httpStatus: null, error: null });
      let results: SerperOrganicResult[];
      try {
        results = await searchSerper(apiKey, query, page, "qdr:m");
      } catch (error) {
        const message = (error as Error).message;
        const status = /^serper: HTTP (\d+)$/.exec(message);
        await onPage?.({ phrase, query, page, status: "failed", startedAt,
          finishedAt: new Date().toISOString(), results: null,
          httpStatus: status ? Number(status[1]) : null, error: message });
        errors.push(`"${phrase}": ${message}`);
        break;
      }
      await onPage?.({ phrase, query, page, status: "complete", startedAt,
        finishedAt: new Date().toISOString(), results, httpStatus: 200, error: null });
      if (results.length === 0) break;
      for (const result of results) {
        const ref = parseJobUrl(result.link, result.title);
        if (!ref) continue;
        if (isExcludedCompany(ref.ats, ref.slug, titleCaseSlug(ref.slug), exclusion)) continue;
        const id = jobRefId(ref);
        if (!found.has(id)) found.set(id, ref);
      }
    }
  }
  return { refs: [...found.values()], errors };
}

export interface SerperOrganicResult {
  link: string;
  title: string;
}

export async function searchSerper(
  apiKey: string,
  query: string,
  page: number,
  tbs: string,
): Promise<SerperOrganicResult[]> {
  const res = await fetchWithDeadline("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, page, tbs }),
  });
  if (!res.ok) throw new Error(`serper: HTTP ${res.status}`);
  const data = (await res.json()) as { organic?: SerperOrganicResult[] };
  if (!Array.isArray(data?.organic)) throw new Error("serper: missing or invalid organic results");
  return data.organic;
}

export function workdaySite(url: string): string | null {
  const ref = parseJobUrl(url, "");
  if (ref?.ats !== "workday") return null;
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return (parts[0] && /^[a-z]{2}-[a-z]{2}$/i.test(parts[0]) ? parts[1] : parts[0])?.toLowerCase() ?? null;
}
