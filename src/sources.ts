import { fetchWithDeadline } from "./operations/fetch";
import { htmlToTextWithProvenance, MAX_COMPENSATION_CHARS, MAX_DESCRIPTION_CHARS, type TextProvenance } from "./description";
import { parseJobUrl } from "./unbounded/discovery";

const ATS_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co"]);

// The key discovery uses to recognise a posting already applied to, compared
// with known_applications.canonical_id. Those keys are stored when an
// application is recorded (the ledger import calls this), so keying a URL
// form differently means backfilling canonical_id for the rows already
// recorded with it. The unbounded Worker looks up parseJobUrl's postingId
// instead, which must stay equal to this key for the same posting's board
// URL. Only covers Greenhouse/Ashby/Lever: Workday and Amazon postings can't
// be matched this way.
export function canonicalizeAtsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!ATS_HOSTS.has(parsed.hostname)) return embeddedGreenhouseJobId(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).pop();
    return last ? last.toLowerCase() : null;
  } catch {
    return null;
  }
}

// An employer's careers page embedding a Greenhouse board names the posting in
// gh_jid: the id its board URL ends in. A page naming two different postings
// names neither.
export function embeddedGreenhouseJobId(url: string): string | null {
  try {
    const values = new Set(new URL(url).searchParams.getAll("gh_jid"));
    const [id] = values;
    return values.size === 1 && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export type NormalizedJob = {
  id: string; // stable, unique across runs — used as the KV dedup key
  company: string;
  title: string;
  url: string;
  location: string;
  // Provider observations stay separate: a remote flag does not resolve a
  // Hybrid arrangement, and a primary office does not exhaust other offices.
  // Absence of this object is legacy/unsupported coverage, not remote proof.
  locationMetadata?: {
    workplaceType: string | null;
    secondaryLocations: string[];
    coverageGaps: string[];
    sourceFields: string[];
  };
  department: string;
  isRemote: boolean | null;
  employmentType: string | null;
  postedAt: string | null;
  compensation: string | null; // raw text if the ATS exposes it, else null
  // Posting body as plain text, truncated. The hard excludes ask what the
  // posting says about clearance, salary and location — none of which is
  // reliably in the structured fields above.
  description: string | null;
  // Board facet observed during Amazon catalog acquisition. A URL alone
  // cannot prove category membership; legacy contexts without this stay unsupported.
  fixedSourceProvenance?: { ats: "amazon"; category: string };
  // Measures observed provider text retention, not whole-posting completeness.
  // Absent for legacy/synthesized jobs that have no observed source evidence.
  contentProvenance?: {
    description: TextProvenance;
    compensation: TextProvenance;
    coverageGaps: string[];
  };
};

type ObservedText = ReturnType<typeof htmlToTextWithProvenance>;

function locationMetadata(
  primary: unknown,
  primaryField: string,
  workplaceType: unknown,
  secondary?: { value: unknown; field: string },
): NonNullable<NormalizedJob["locationMetadata"]> {
  const coverageGaps: string[] = [];
  const sourceFields: string[] = [];
  const retainText = (value: unknown, field: string): string | null => {
    if (typeof value === "string" && value.trim()) {
      sourceFields.push(field);
      return value;
    }
    coverageGaps.push(`${field}: ${value == null ? "not supplied" : typeof value === "string" ? "no usable location text" : "unsupported location value"}`);
    return null;
  };
  retainText(primary, primaryField);
  const arrangement = retainText(workplaceType, "workplaceType");
  const secondaryLocations: string[] = [];
  if (secondary) {
    if (Array.isArray(secondary.value)) {
      // An explicitly empty array is observed coverage, unlike a missing one.
      if (secondary.value.length === 0) sourceFields.push(secondary.field);
      secondary.value.forEach((entry: unknown, index: number) => {
        const field = `${secondary.field}[${index}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          coverageGaps.push(`${field}: unsupported location entry`);
          return;
        }
        const text = retainText((entry as { location?: unknown }).location, `${field}.location`);
        if (text !== null) secondaryLocations.push(text);
      });
    } else {
      coverageGaps.push(`${secondary.field}: ${secondary.value == null ? "not supplied" : "unsupported location collection"}`);
    }
  }
  return { workplaceType: arrangement, secondaryLocations, coverageGaps, sourceFields };
}

function contentProvenance(description: ObservedText, compensation: ObservedText, coverageGaps: string[] = []): NonNullable<NormalizedJob["contentProvenance"]> {
  const gaps = [...coverageGaps];
  for (const [field, observed] of [["description", description], ["compensation", compensation]] as const) {
    // A marker already in a fully retained provider field describes upstream
    // omission; local truncation remains a separate measured fact.
    if (observed.provenance.truncated === false && /\[(?:middle of posting|snapshot text) omitted\]/i.test(observed.text ?? "")) {
      gaps.push(`${field}: source text was already omitted`);
    }
  }
  return {
    description: description.provenance,
    compensation: compensation.provenance,
    coverageGaps: [...gaps, ...(!description.text ? ["description: no usable provider text"] : [])],
  };
}

export type CompanyCategory = "frontier AI" | "AI infrastructure" | "defense/autonomy" | "applied AI";

export type Source = (
  | { company: string; ats: "greenhouse"; slug: string }
  | { company: string; ats: "ashby"; slug: string }
  | { company: string; ats: "lever"; slug: string }
  | { company: string; ats: "workday"; tenant: string; wdHost: string; site: string; searchTerms: string[] }
  | { company: string; ats: "amazon"; category: string }
) & { companyCategory: CompanyCategory };

async function fetchGreenhouse(slug: string, includeContent = true): Promise<any[]> {
  const res = await fetchWithDeadline(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=${includeContent}`);
  if (!res.ok) throw new Error(`greenhouse/${slug}: HTTP ${res.status}`);
  const data = (await res.json()) as { jobs: any[] };
  return data.jobs ?? [];
}

export function normalizeGreenhouse(company: string, raw: any, descriptionLimit: number = MAX_DESCRIPTION_CHARS): NormalizedJob {
  const description = htmlToTextWithProvenance(raw.content, descriptionLimit, ["content"]);
  const compensation = htmlToTextWithProvenance(undefined, MAX_COMPENSATION_CHARS);
  return {
    id: `greenhouse:${company}:${raw.id}`,
    company,
    title: raw.title,
    url: raw.absolute_url,
    location: raw.location?.name ?? "unspecified",
    department: raw.departments?.[0]?.name ?? "unspecified",
    isRemote: null, // Greenhouse doesn't expose this as a flag; GLM infers from location text
    employmentType: null,
    postedAt: raw.updated_at ?? null,
    compensation: null, // not exposed in the list endpoint
    description: description.text,
    contentProvenance: contentProvenance(description, compensation),
  };
}

// Ashby's posting API answers 404 when the job board itself does not exist,
// such as a retired board still returned by search. The message matches every
// other board failure so callers that treat all failures alike are unchanged.
export class AshbyBoardNotFoundError extends Error {
  constructor(slug: string) {
    super(`ashby/${slug}: HTTP 404`);
  }
}

async function fetchAshby(slug: string): Promise<any[]> {
  const res = await fetchWithDeadline(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
  );
  if (res.status === 404) throw new AshbyBoardNotFoundError(slug);
  if (!res.ok) throw new Error(`ashby/${slug}: HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "jobs"))
    throw new Error(`ashby/${slug}: invalid board job list`);
  const jobs = (data as { jobs: unknown }).jobs;
  // Callers use absence from this list as not-found evidence. Missing lists
  // or unusable IDs cannot establish absence; retain the source failure.
  if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job !== "object" || Array.isArray(job) ||
    typeof job.id !== "string" || !job.id || job.id.trim() !== job.id))
    throw new Error(`ashby/${slug}: invalid board job list`);
  return jobs;
}

export function normalizeAshby(company: string, raw: any, descriptionLimit: number = MAX_DESCRIPTION_CHARS): NormalizedJob {
  const descriptionField = typeof raw.descriptionPlain === "string" && raw.descriptionPlain.trim()
    ? "descriptionPlain" : raw.descriptionHtml != null ? "descriptionHtml" : "descriptionPlain";
  const description = htmlToTextWithProvenance(raw[descriptionField], descriptionLimit, [descriptionField]);
  const nestedCompensation = htmlToTextWithProvenance(raw.compensation?.compensationTierSummary, MAX_COMPENSATION_CHARS, ["compensation.compensationTierSummary"]);
  // The public API nests this summary; retain the older top-level shape as
  // a fallback. Keep the provider wording (including OTE), not a base-pay claim.
  const compensation = nestedCompensation.text ? nestedCompensation
    : htmlToTextWithProvenance(raw.compensationTierSummary, MAX_COMPENSATION_CHARS, ["compensationTierSummary"]);
  return {
    id: `ashby:${company}:${raw.id}`,
    company,
    title: raw.title,
    url: raw.jobUrl ?? raw.applyUrl,
    location: raw.locationName ?? raw.location ?? "unspecified",
    locationMetadata: locationMetadata(raw.locationName ?? raw.location, raw.locationName != null ? "locationName" : "location", raw.workplaceType, { value: raw.secondaryLocations, field: "secondaryLocations" }),
    department: raw.department ?? raw.team ?? "unspecified",
    isRemote: typeof raw.isRemote === "boolean" ? raw.isRemote : null,
    employmentType: raw.employmentType ?? null,
    postedAt: raw.publishedAt ?? null,
    compensation: compensation.text,
    description: description.text,
    contentProvenance: contentProvenance(description, compensation),
  };
}

async function fetchLever(slug: string): Promise<any[]> {
  const res = await fetchWithDeadline(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  if (!res.ok) throw new Error(`lever/${slug}: HTTP ${res.status}`);
  return (await res.json()) as any[];
}

export function normalizeLever(company: string, raw: any, descriptionLimit: number = MAX_DESCRIPTION_CHARS): NormalizedJob {
  const coverageGaps: string[] = [];
  const parts: string[] = [];
  const sourceFields: string[] = [];
  const includeText = (value: unknown, field: string) => {
    if (typeof value === "string") { parts.push(value); sourceFields.push(field); }
    else if (value != null) coverageGaps.push(`${field}: unsupported text value`);
  };
  includeText(raw.description, "description");
  // Lever splits requirements/responsibilities into lists. Preserve recognized
  // text and flag unsupported sections instead of silently declaring coverage.
  if (Array.isArray(raw.lists)) {
    raw.lists.forEach((list: unknown, index: number) => {
      if (!list || typeof list !== "object" || Array.isArray(list)) {
        coverageGaps.push(`lists[${index}]: unsupported requirement section`);
        return;
      }
      const section = list as { text?: unknown; content?: unknown };
      includeText(section.text, `lists[${index}].text`);
      includeText(section.content, `lists[${index}].content`);
      if (!htmlToTextWithProvenance(section.content).text) {
        coverageGaps.push(`lists[${index}].content: no usable requirement text`);
      }
    });
  } else if (raw.lists != null) coverageGaps.push("lists: unsupported requirement collection");
  includeText(raw.additional, "additional");
  const description = htmlToTextWithProvenance(sourceFields.length ? parts.join("\n") : undefined, descriptionLimit, sourceFields);
  const compensation = htmlToTextWithProvenance(raw.salaryDescription, MAX_COMPENSATION_CHARS, ["salaryDescription"]);
  return {
    id: `lever:${company}:${raw.id}`,
    company,
    title: raw.text,
    url: raw.hostedUrl,
    location: raw.categories?.location ?? "unspecified",
    locationMetadata: locationMetadata(raw.categories?.location, "categories.location", raw.workplaceType),
    department: raw.categories?.team ?? "unspecified",
    isRemote: raw.workplaceType ? raw.workplaceType === "remote" : null,
    employmentType: raw.categories?.commitment ?? null,
    postedAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
    compensation: compensation.text,
    description: description.text,
    contentProvenance: contentProvenance(description, compensation, coverageGaps),
  };
}

// Use bounded Workday search pages and retain explicit coverage limits;
// a depth-limited search does not establish a complete employer catalog.
const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_MAX_PAGES = 3; // up to 60 results per search term

async function fetchWorkday(source: Extract<Source, { ats: "workday" }>): Promise<any[]> {
  const url = `https://${source.tenant}.${source.wdHost}.myworkdayjobs.com/wday/cxs/${source.tenant}/${source.site}/jobs`;
  const seen = new Map<string, any>();
  for (const searchText of source.searchTerms) {
    for (let page = 0; page < WORKDAY_MAX_PAGES; page++) {
      const res = await fetchWithDeadline(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: WORKDAY_PAGE_SIZE, offset: page * WORKDAY_PAGE_SIZE, searchText }),
      });
      if (!res.ok) throw new Error(`workday/${source.tenant} (${searchText}, page ${page}): HTTP ${res.status}`);
      const data = (await res.json()) as { jobPostings: any[]; total: number };
      for (const job of data.jobPostings ?? []) {
        const id = job.bulletFields?.[0] ?? job.externalPath;
        seen.set(id, job); // dedupe across the merged search terms
      }
      if ((page + 1) * WORKDAY_PAGE_SIZE >= (data.total ?? 0)) break;
    }
  }
  return [...seen.values()].map((job) => ({ ...job, _workdayBase: `https://${source.tenant}.${source.wdHost}.myworkdayjobs.com/${source.site}` }));
}

function normalizeWorkday(company: string, raw: any): NormalizedJob {
  const reqId = raw.bulletFields?.[0] ?? raw.externalPath;
  const missingText = htmlToTextWithProvenance(undefined);
  return {
    id: `workday:${company}:${reqId}`,
    company,
    title: raw.title,
    url: `${raw._workdayBase}${raw.externalPath}`,
    location: raw.locationsText ?? "unspecified",
    // Workday's search endpoint returns no body. Fresh postings are hydrated
    // from its JSON detail endpoint after deduplication, before screening.
    department: "unspecified", // not returned by the list endpoint
    isRemote: null,
    employmentType: null,
    postedAt: raw.postedOn ?? null, // relative text ("Posted 3 Days Ago"), not a timestamp
    compensation: null,
    description: null,
    contentProvenance: contentProvenance(missingText, missingText, ["workday catalog: posting detail not fetched"]),
  };
}

// Page Amazon search results by offset rather than assuming a requested
// limit guarantees that all matching postings fit in one response.
const AMAZON_PAGE_SIZE = 10;

async function fetchAmazon(category: string): Promise<any[]> {
  const jobs: any[] = [];
  let offset = 0;
  while (true) {
    const res = await fetchWithDeadline(
      `https://www.amazon.jobs/en/search.json?business_category%5B%5D=${encodeURIComponent(category)}&offset=${offset}`,
    );
    if (!res.ok) throw new Error(`amazon/${category} (offset ${offset}): HTTP ${res.status}`);
    const data = (await res.json()) as { jobs: any[]; hits: number };
    jobs.push(...(data.jobs ?? []));
    offset += AMAZON_PAGE_SIZE;
    if (offset >= (data.hits ?? 0) || (data.jobs ?? []).length === 0) break;
  }
  return jobs;
}

function normalizeAmazon(company: string, raw: any, category: string): NormalizedJob {
  const missingText = htmlToTextWithProvenance(undefined);
  return {
    id: `amazon:${company}:${raw.id}`,
    fixedSourceProvenance: { ats: "amazon", category },
    company,
    title: raw.title,
    url: `https://www.amazon.jobs${raw.job_path}`,
    location: raw.normalized_location ?? raw.location ?? "unspecified",
    department: raw.job_category ?? "unspecified",
    isRemote: null,
    employmentType: raw.job_schedule_type ?? null,
    postedAt: raw.posted_date ?? null,
    compensation: null,
    description: null,
    contentProvenance: contentProvenance(missingText, missingText, ["amazon catalog: posting body not fetched"]),
  };
}

export type SourceObservation = {
  source: Source;
  status: "started" | "complete" | "failed";
  startedAt: string;
  finishedAt: string | null;
  jobs: NormalizedJob[];
  error: string | null;
};

export async function fetchAllPostings(
  sources: readonly Source[],
  onSource?: (event: SourceObservation) => Promise<void>,
): Promise<{ jobs: NormalizedJob[]; errors: string[] }> {
  const jobs: NormalizedJob[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    const startedAt = new Date().toISOString();
    await onSource?.({ source, status: "started", startedAt, finishedAt: null, jobs: [], error: null });
    const before = jobs.length;
    let sourceError: string | null = null;
    try {
      switch (source.ats) {
        case "greenhouse": {
          // Deduplicate the catalog before loading individual descriptions.
          const raw = await fetchGreenhouse(source.slug, false);
          jobs.push(...raw.map((j) => normalizeGreenhouse(source.company, j)));
          break;
        }
        case "ashby": {
          const raw = await fetchAshby(source.slug);
          jobs.push(...raw.map((j) => normalizeAshby(source.company, j)));
          break;
        }
        case "lever": {
          const raw = await fetchLever(source.slug);
          jobs.push(...raw.map((j) => normalizeLever(source.company, j)));
          break;
        }
        case "workday": {
          const raw = await fetchWorkday(source);
          jobs.push(...raw.map((j) => normalizeWorkday(source.company, j)));
          break;
        }
        case "amazon": {
          const raw = await fetchAmazon(source.category);
          jobs.push(...raw.map((j) => normalizeAmazon(source.company, j, source.category)));
          break;
        }
      }
    } catch (e) {
      sourceError = `${source.company}: ${(e as Error).message}`;
      errors.push(sourceError);
    }
    // Observe outside the provider catch. A failed accounting write must not
    // be mislabeled as a source fetch error or silently dropped.
    await onSource?.({ source, status: sourceError ? "failed" : "complete", startedAt,
      finishedAt: new Date().toISOString(), jobs: jobs.slice(before), error: sourceError });
  }

  return { jobs, errors };
}

// Only the "ashby" branch is exercised today (Worker 2's Ashby board-level
// fetch, since Ashby has no public per-posting endpoint) — greenhouse/lever
// are kept here for future use.
export async function fetchCompanyBoard(
  ats: "greenhouse" | "ashby" | "lever",
  company: string,
  slug: string,
  descriptionLimit: number = MAX_DESCRIPTION_CHARS,
): Promise<NormalizedJob[]> {
  switch (ats) {
    case "greenhouse": {
      const raw = await fetchGreenhouse(slug);
      return raw.map((j) => normalizeGreenhouse(company, j, descriptionLimit));
    }
    case "ashby": {
      const raw = await fetchAshby(slug);
      return raw.map((j) => normalizeAshby(company, j, descriptionLimit));
    }
    case "lever": {
      const raw = await fetchLever(slug);
      return raw.map((j) => normalizeLever(company, j, descriptionLimit));
    }
    default:
      throw new Error(`fetchCompanyBoard: unsupported ats "${ats}"`);
  }
}

// Greenhouse and Lever both expose a public single-posting endpoint, so a
// newly-found posting costs exactly one request. (Ashby has no public
// per-posting endpoint — callers use fetchCompanyBoard for that platform.)
export type PostingRef = {
  ats: "greenhouse" | "lever" | "workday";
  slug: string;
  postingId: string;
  // Workday's detail endpoint is derived from the public URL: the
  // career-site name and external path appear nowhere else, so tenant plus
  // requisition id is not enough to rebuild it. Unused by the other two.
  url: string;
};

export async function fetchPosting(
  ref: PostingRef,
  company: string,
  descriptionLimit: number = MAX_DESCRIPTION_CHARS,
): Promise<NormalizedJob | null> {
  const url = postingDetailUrl(ref);
  if (!url) throw new Error(`Workday: invalid posting reference for ${ref.slug}/${ref.postingId}`);

  // Inspect Workday redirects instead of allowing an ATS URL to fetch an
  // arbitrary destination. A redirect remains retryable, never a rejection.
  const res = ref.ats === "workday" ? await fetchWithDeadline(url, { redirect: "manual" }) : await fetchWithDeadline(url);
  if (ref.ats === "workday" && res.status >= 300 && res.status < 400) {
    throw new Error(`Workday redirect: HTTP ${res.status}`);
  }
  if (res.status === 404) return null; // posting closed or never existed
  if (ref.ats === "workday" && res.status === 403 && await workdayPostingUnlisted(ref, url, res)) return null;
  if (!res.ok) throw new Error(`${ref.ats}/${ref.slug}/${ref.postingId}: HTTP ${res.status}`);

  const raw = await res.json();
  if (ref.ats === "greenhouse") return normalizeGreenhouse(company, raw, descriptionLimit);
  if (ref.ats === "lever") return normalizeLever(company, raw, descriptionLimit);
  return normalizeWorkdayPosting(company, ref, raw, descriptionLimit);
}

// Workday's detail endpoint answers 403 with errorCode S22 ("permission
// denied") for postings that are no longer public: removed, expired or
// internal-only. A 403 alone never proves closure, so the tenant's live job
// search must also omit the posting. A failed, truncated or unreadable search
// keeps the 403 retryable. A trailing publication suffix ("_R-1234-1") is also
// searched as its base requisition so a live posting is never closed.
async function workdayPostingUnlisted(ref: PostingRef, detailUrl: string, res: Response): Promise<boolean> {
  let body: { errorCode?: unknown } | null = null;
  try { body = await res.json(); } catch { return false; }
  if (body?.errorCode !== "S22") return false;
  const cxsBase = detailUrl.split("/job/")[0];
  const publicBase = `${new URL(cxsBase).origin}/${cxsBase.split("/").at(-1)}`;
  const postingId = ref.postingId.toLowerCase();
  const baseRequisition = postingId.replace(/-\d{1,2}$/, "");
  for (const searchText of new Set([postingId, baseRequisition])) {
    const search = await fetchWithDeadline(`${cxsBase}/jobs`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: WORKDAY_PAGE_SIZE, offset: 0, searchText }),
    });
    if (!search.ok) return false;
    let data: { total?: unknown; jobPostings?: unknown } | null = null;
    try { data = await search.json(); } catch { return false; }
    if (!Array.isArray(data?.jobPostings) || typeof data.total !== "number" || data.total > data.jobPostings.length) return false;
    if (data.jobPostings.some((p: { externalPath?: unknown }) => typeof p?.externalPath === "string" &&
      parseJobUrl(`${publicBase}${p.externalPath}`, "")?.postingId === postingId)) return false;
  }
  return true;
}

function postingDetailUrl(ref: PostingRef): string | null {
  if (ref.ats === "greenhouse") {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.slug)}/jobs/${encodeURIComponent(ref.postingId)}`;
  }
  if (ref.ats === "lever") {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(ref.slug)}/${encodeURIComponent(ref.postingId)}`;
  }
  const parsedRef = parseJobUrl(ref.url, "");
  if (parsedRef?.ats !== "workday" || parsedRef.slug !== ref.slug.toLowerCase() || parsedRef.postingId !== ref.postingId.toLowerCase()) return null;
  return workdayDetailUrl(parsedRef.url);
}

// https://{tenant}.{wdN}.myworkdayjobs.com[/{locale}]/{site}/job/...
//   becomes
// https://{tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/...
//
// The JSON detail response provides posting text and structured timeType
// evidence for screening.
export function workdayDetailUrl(publicUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    return null;
  }
  const host = /^([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(parsed.hostname);
  if (!host) return null;

  let segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > 0 && /^[a-z]{2}-[a-z]{2}$/i.test(segments[0])) segments = segments.slice(1);
  if (segments.length < 3) return null;

  const [site, ...externalPath] = segments;
  return `https://${parsed.hostname}/wday/cxs/${host[1].toLowerCase()}/${site}/${externalPath.join("/")}`;
}

// Workday serves career sites case-insensitively and search results can carry a
// lowercased site, so compare the tenant host and site without case.
export function sameWorkdaySite(a: string, b: string): boolean {
  const first = workdayDetailUrl(a)?.split("/job/")[0].toLowerCase();
  const second = workdayDetailUrl(b)?.split("/job/")[0].toLowerCase();
  return !!first && first === second;
}

// Normalize surrounding whitespace and spacing around existing hyphens.
// Do not turn an ordinary space into a hyphen or collapse distinct IDs.
export function normalizeWorkdayRequisition(requisition: string): string {
  return requisition.trim().replace(/\s*-\s*/g, "-");
}

export function matchesWorkdayRequisition(publicUrl: string, requisition: string): boolean {
  const ref = parseJobUrl(publicUrl, "");
  if (ref?.ats !== "workday") return false;
  const anchor = decodeURIComponent(new URL(ref.url).pathname.split("/").filter(Boolean).at(-1)!).toLowerCase();
  const marker = `_${normalizeWorkdayRequisition(requisition).toLowerCase()}`;
  const markerAt = anchor.lastIndexOf(marker);
  const suffix = markerAt < 0 ? null : anchor.slice(markerAt + marker.length);
  return suffix === "" || (suffix !== null && /^-\d+$/.test(suffix));
}

// A provider answering for another posting than the one requested has given a
// definite answer, so retrying cannot help, unlike a timeout or an HTTP 5xx.
// The Worker's re-fetch (src/discovery/fetch.ts) and the materials CLI both
// classify failures by this message rule.
export function isPostingIdentityConflict(error: unknown): boolean {
  return error instanceof Error && /mismatched requisition|identity/i.test(error.message);
}

// Fixed-board Workday claims must remain tied to the configured tenant, host,
// career site and requisition. A matching requisition on another tenant is
// not the same employer posting.
export function matchesFixedWorkdaySource(job: Pick<NormalizedJob, "id" | "company" | "url">, sources: readonly Source[]): boolean {
  const source = sources.find(item => item.ats === "workday" && item.company === job.company);
  if (source?.ats !== "workday") return false;
  const prefix = `workday:${source.company}:`;
  const requisition = job.id.startsWith(prefix) ? job.id.slice(prefix.length) : "";
  const ref = parseJobUrl(job.url, "");
  const detailUrl = workdayDetailUrl(job.url);
  return !!requisition && ref?.ats === "workday" &&
    ref.slug === source.tenant.toLowerCase() &&
    ref.postingId === requisition.toLowerCase() &&
    detailUrl?.startsWith(`https://${source.tenant.toLowerCase()}.${source.wdHost.toLowerCase()}.myworkdayjobs.com/wday/cxs/${source.tenant.toLowerCase()}/${source.site}/job/`) === true &&
    matchesWorkdayRequisition(job.url, requisition);
}

export function normalizeWorkdayPosting(
  company: string,
  ref: PostingRef,
  raw: any,
  descriptionLimit: number = MAX_DESCRIPTION_CHARS,
): NormalizedJob {
  const info = raw?.jobPostingInfo;
  if (!info || typeof info.title !== "string" || !info.title.trim() ||
      typeof info.jobReqId !== "string" || !info.jobReqId.trim() || typeof info.jobDescription !== "string") {
    throw new Error("Workday: missing or invalid posting details");
  }
  // Match the full URL anchor, not the legacy dedup ID: that ID keeps only
  // the final underscore-delimited component.
  // Changing stored IDs here would rediscover existing jobs. Workday may
  // append a numeric publication suffix; its opaque `id` is unrelated.
  const requested = ref.postingId.toLowerCase();
  if (!matchesWorkdayRequisition(ref.url, info.jobReqId)) throw new Error("Workday: mismatched requisition identity");
  const description = htmlToTextWithProvenance(info.jobDescription, descriptionLimit, ["jobPostingInfo.jobDescription"]);
  if (!description.text) throw new Error("Workday: empty posting description");
  // Returned canonical URLs can add a location segment. Trust only URLs
  // that still identify the same tenant, site and posting on the same host.
  let publicUrl = ref.url;
  if (typeof info.externalUrl === "string") {
    const canonical = parseJobUrl(info.externalUrl, "");
    if (canonical?.ats === "workday" && canonical.slug === ref.slug.toLowerCase() && canonical.postingId === requested && matchesWorkdayRequisition(canonical.url, info.jobReqId) &&
        sameWorkdaySite(canonical.url, ref.url)) publicUrl = canonical.url;
  }
  // A Workday posting can list several offices, and under hard exclude 4 it
  // qualifies if ANY one of them is commutable — so every location has to
  // reach the model, not just the primary.
  const coverageGaps: string[] = [];
  const locations: string[] = [];
  const secondaryLocations: string[] = [];
  const sourceFields: string[] = [];
  const includeLocation = (value: unknown, field: string, listed = false) => {
    if (typeof value === "string" && value.trim()) {
      locations.push(value);
      if (listed) secondaryLocations.push(value);
      sourceFields.push(field);
    }
    else if (listed || (value != null && typeof value !== "string")) coverageGaps.push(`${field}: unsupported location value`);
  };
  includeLocation(info.location, "jobPostingInfo.location");
  if (Array.isArray(info.additionalLocations)) {
    sourceFields.push("jobPostingInfo.additionalLocations");
    info.additionalLocations.forEach((value: unknown, index: number) => includeLocation(value, `jobPostingInfo.additionalLocations[${index}]`, true));
  } else if (info.additionalLocations != null) coverageGaps.push("jobPostingInfo.additionalLocations: unsupported location collection");
  const remoteType = typeof info.remoteType === "string" ? info.remoteType : null;
  if (remoteType !== null) sourceFields.push("jobPostingInfo.remoteType");
  else if (info.remoteType != null) coverageGaps.push("jobPostingInfo.remoteType: unsupported workplace value");
  const canonicalRemote = remoteType !== null && /^(?:remote|on[ -]?site|hybrid)$/i.test(remoteType.trim());
  const negatedRemote = remoteType !== null && (/\b(?:not|no|non)[\s-]+remote\b/i.test(remoteType) ||
    /\bremote(?:\s+work(?:ing)?)?(?:\s+is)?\s+(?:not (?:permitted|allowed|available)|unavailable|prohibited)\b/i.test(remoteType));
  if (remoteType !== null && !canonicalRemote) {
    const wording = remoteType.length <= 200 ? remoteType : `${remoteType.slice(0, 170)}… [remote wording omitted]`;
    coverageGaps.push(`jobPostingInfo.remoteType: noncanonical location/remote wording (${wording})`);
  }
  const compensation = htmlToTextWithProvenance(undefined, MAX_COMPENSATION_CHARS);

  return {
    id: `workday:${company}:${normalizeWorkdayRequisition(info.jobReqId)}`,
    company,
    title: info.title ?? "unspecified",
    url: publicUrl,
    location: locations.join(" / ") || "unspecified",
    department: "unspecified", // Workday exposes no department on this endpoint
    isRemote: negatedRemote ? false : canonicalRemote ? /^remote$/i.test(remoteType!.trim()) : null,
    locationMetadata: { workplaceType: remoteType, secondaryLocations, coverageGaps: [...coverageGaps], sourceFields },
    employmentType: info.timeType ?? null,
    postedAt: info.startDate ?? info.postedOn ?? null,
    compensation: null, // not exposed here; the body usually carries the range
    description: description.text,
    contentProvenance: contentProvenance(description, compensation, coverageGaps),
  };
}

// Greenhouse may expose custom employer URLs, so hydration reacquires detail
// from its selected board. Other boards must prove retained listing identity.
export function fixedSourceForJob(job: NormalizedJob, sources: readonly Source[]): Source | undefined {
  return sources.find(source => {
    const prefix = `${source.ats}:${source.company}:`;
    if (source.company !== job.company || !job.id.startsWith(prefix) || !job.id.slice(prefix.length)) return false;
    if (source.ats === "greenhouse") return true;
    if (source.ats === "workday") return matchesFixedWorkdaySource(job, [source]);
    if (source.ats === "amazon") return job.fixedSourceProvenance?.ats === "amazon" &&
      job.fixedSourceProvenance.category === source.category;
    const ref = parseJobUrl(job.url, job.title);
    return ref?.ats === source.ats && ref.slug === source.slug.toLowerCase() &&
      ref.postingId === job.id.slice(prefix.length).toLowerCase();
  });
}

export function fixedSourceCompanyCategory(job: NormalizedJob, sources: readonly Source[]): CompanyCategory | undefined {
  return fixedSourceForJob(job, sources)?.companyCategory;
}
