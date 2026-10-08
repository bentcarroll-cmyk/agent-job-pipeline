import type { TextProvenance } from "../description";
import type { CompanyCategory, NormalizedJob } from "../sources";
import type { PostingSnapshot } from "./types";

const SNAPSHOT_VERSION = "retained-posting-v2";
const encoder = new TextEncoder();
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const omission = "\n… [snapshot text omitted] …\n";

export async function hashContent(value: unknown): Promise<string> {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : item;
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function provenance(text: string | null, existing?: TextProvenance): TextProvenance {
  if (!existing) return { provided: text !== null, originalChars: null, retainedChars: text?.length ?? 0,
    truncated: null, sourceFields: [], normalizerVersion: "unknown" };
  const { provided, originalChars, retainedChars, truncated, sourceFields, normalizerVersion } = existing;
  if (typeof provided !== "boolean" || !(truncated === null || typeof truncated === "boolean") ||
      !(originalChars === null || Number.isSafeInteger(originalChars) && originalChars >= 0) ||
      retainedChars !== (text?.length ?? 0) || !Array.isArray(sourceFields) || sourceFields.length > 32 ||
      sourceFields.some(field => typeof field !== "string" || field.length > 200) ||
      typeof normalizerVersion !== "string" || normalizerVersion.length > 100 ||
      (truncated === false && originalChars !== null && originalChars !== retainedChars) ||
      (!provided && (text !== null || originalChars !== null || truncated !== null))) throw new Error("invalid posting provenance");
  return { provided, originalChars, retainedChars, truncated, sourceFields: [...sourceFields], normalizerVersion };
}

function locationMetadata(value: unknown): NonNullable<NormalizedJob["locationMetadata"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid location metadata");
  const { workplaceType, secondaryLocations, coverageGaps, sourceFields } = value as Record<string, unknown>;
  // Multi-office metadata needs both a list-count limit and an encoded-size
  // limit; the 8 KiB bound below also constrains the combined fields.
  const stringList = (items: unknown, max: number): items is string[] => Array.isArray(items) && items.length <= 200 &&
    items.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= max);
  if (!(workplaceType === null || typeof workplaceType === "string" && workplaceType.trim().length > 0 && workplaceType.length <= 100) ||
      !stringList(secondaryLocations, 500) || !stringList(coverageGaps, 500) || !stringList(sourceFields, 200)) {
    throw new Error("invalid or excessive location metadata");
  }
  const retained = { workplaceType, secondaryLocations: [...secondaryLocations], coverageGaps: [...coverageGaps], sourceFields: [...sourceFields] };
  // Losing one office, restriction or coverage warning can change eligibility.
  // Refuse oversized metadata rather than silently truncating an alternative.
  if (size(retained) > 8192) throw new Error("location metadata exceeds snapshot bound");
  return retained;
}

// Preserve code points and make every extra retention limit visible. Source
// normalization has already chosen head/tail text; this guard only bounds JSON.
function bounded(text: string, bytes: number): string {
  if (size(text) <= bytes) return text;
  const points = Array.from(text);
  let low = 0, high = points.length;
  while (low < high) {
    const keep = Math.ceil((low + high) / 2);
    const value = points.slice(0, Math.ceil(keep * .625)).join("") + omission + points.slice(points.length - Math.floor(keep * .375)).join("");
    if (size(value) <= bytes) low = keep; else high = keep - 1;
  }
  return points.slice(0, Math.ceil(low * .625)).join("") + omission + points.slice(points.length - Math.floor(low * .375)).join("");
}

export async function createPostingSnapshot(job: NormalizedJob, category?: CompanyCategory, fetchedAt: string | null = null): Promise<PostingSnapshot> {
  if (!job.id || !job.url || size(job.id) > 1024 || size(job.url) > 4096) throw new Error("posting identity missing or exceeds snapshot bound");
  if (fetchedAt !== null && (!Number.isFinite(Date.parse(fetchedAt)) || fetchedAt.length > 40)) throw new Error("invalid posting observation time");
  // Explicit projection prevents accidental persistence of caller-added private data.
  const retained: NormalizedJob = {
    id: job.id, company: job.company, title: job.title, url: job.url, location: job.location,
    department: job.department, isRemote: job.isRemote, employmentType: job.employmentType,
    postedAt: job.postedAt, compensation: job.compensation, description: job.description,
    ...(job.locationMetadata !== undefined ? { locationMetadata: locationMetadata(job.locationMetadata) } : {}),
    contentProvenance: {
      description: provenance(job.description, job.contentProvenance?.description),
      compensation: provenance(job.compensation, job.contentProvenance?.compensation),
      coverageGaps: [...(job.contentProvenance?.coverageGaps ?? [])],
    },
  };
  const coverage = retained.contentProvenance!;
  for (const field of ["company", "title", "location", "department", "employmentType", "postedAt", "compensation", "description"] as const) {
    const text = retained[field];
    if (text === null) continue;
    const limited = bounded(text, field === "description" ? 22000 : field === "compensation" ? 2000 : 1500);
    if (limited !== text) {
      retained[field] = limited;
      coverage.coverageGaps.push(`${field}: additional snapshot text omitted`);
      if (field === "description" || field === "compensation") {
        coverage[field].truncated = true;
        coverage[field].retainedChars = limited.length;
      }
    }
  }
  // Metadata is trusted normalizer output; refuse excessive metadata instead of
  // silently dropping a coverage warning that could change the decision.
  const snapshot: PostingSnapshot = { id: "0".repeat(64), jobId: retained.id, contentHash: "0".repeat(64),
    job: retained, companyCategory: category ?? null, fetchedAt, normalizerVersion: SNAPSHOT_VERSION };
  if (size(snapshot) > 32768) throw new Error("posting snapshot metadata exceeds 32KiB bound");
  snapshot.id = snapshot.contentHash = await hashContent({ job: retained, companyCategory: snapshot.companyCategory, normalizerVersion: SNAPSHOT_VERSION });
  return snapshot;
}
