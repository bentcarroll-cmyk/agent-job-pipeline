import { htmlToTextWithProvenance, MAX_COMPENSATION_CHARS, MAX_DESCRIPTION_CHARS } from "../description";
import type { NormalizedJob } from "../sources";
import { observedUrl } from "./observe";
import type { EmployerSource, ResolutionResult, SafePage } from "./types";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const held = (reason: "unsupported" | "ambiguous" | "blocked" | "not_found" | "invalid_identity" | "transient",
  detail: string, retryable = false): ResolutionResult => ({ kind: "held", reason, detail, retryable });

function nodes(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  const item = object(value);
  if (!item) return [];
  const type = item["@type"];
  const types = Array.isArray(type) ? type : [type];
  return [...(types.some(entry => typeof entry === "string" && /(^|\/)JobPosting$/i.test(entry)) ? [item] : []),
    ...nodes(item["@graph"])];
}

function jobPostingNodes(page: SafePage): JsonObject[] {
  const payloads: unknown[] = [];
  if (/application\/(?:ld\+)?json/i.test(page.contentType ?? "")) {
    try { payloads.push(JSON.parse(page.body)); } catch { return []; }
  } else {
    const scripts = page.body.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const script of scripts) {
      try { payloads.push(JSON.parse(script[1])); } catch { /* malformed node is not source evidence */ }
    }
  }
  return payloads.flatMap(nodes);
}

function reqId(node: JsonObject): string | null {
  const identifier = object(node.identifier);
  const value = string(identifier?.value ?? node.identifier);
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) ? value : null;
}

function companyMatches(source: EmployerSource, node: JsonObject): boolean {
  const organization = object(node.hiringOrganization);
  const observed = string(organization?.name);
  if (!observed) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/(?: inc| llc| ltd| corporation| corp)$/i, "");
  return normalize(observed) === normalize(source.name);
}

function canonicalUrl(source: EmployerSource, node: JsonObject, page: SafePage): string | null {
  const explicit = string(node.url);
  const link = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(page.body)?.[1];
  let url: URL;
  try { url = new URL(explicit ?? link ?? page.finalUrl, page.finalUrl); }
  catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !source.careerHosts.includes(url.hostname) || !/\/(?:job|jobs)\/[^/]+/i.test(url.pathname)) return null;
  return observedUrl(url.href);
}

function locationList(node: JsonObject): string[] {
  const source = Array.isArray(node.jobLocation) ? node.jobLocation : node.jobLocation ? [node.jobLocation] : [];
  return source.map(item => {
    const address = object(object(item)?.address);
    return [string(address?.addressLocality), string(address?.addressRegion), string(address?.addressCountry)]
      .filter(Boolean).join(", ");
  }).filter(Boolean);
}

function employmentType(node: JsonObject): string | null {
  const value = node.employmentType;
  if (Array.isArray(value)) return value.map(string).filter((item): item is string => !!item).join("; ") || null;
  return string(value);
}

function applicantGeography(node: JsonObject): string[] {
  const raw = Array.isArray(node.applicantLocationRequirements)
    ? node.applicantLocationRequirements : node.applicantLocationRequirements
      ? [node.applicantLocationRequirements] : [];
  return raw.map(item => {
    const value = object(item);
    const address = object(value?.address);
    return [string(value?.name), string(address?.addressRegion), string(address?.addressCountry)]
      .filter(Boolean).join(", ");
  }).filter(Boolean);
}

function urlRequisition(urlText: string): string | null {
  const url = new URL(urlText);
  const parameter = url.searchParams.get("jobSeqNo") ?? url.searchParams.get("reqId") ??
    url.searchParams.get("requisitionId");
  const fromPath = /\/(?:job|jobs)\/([^/?#]+)$/i.exec(url.pathname)?.[1] ?? null;
  // Some employer-owned paths put a requisition-bearing external ID before
  // the human-readable slug, e.g. /job/MASRUSR291187EXTERNALENUS/Director.
  const externalSegment = /\/(?:job|jobs)\/([^/?#]+)/i.exec(url.pathname)?.[1] ?? null;
  const externalMarker = externalSegment ? /r\d{3,}(?=external)/i.exec(externalSegment)?.[0] ?? null : null;
  const candidate = parameter ?? externalMarker ?? fromPath;
  if (!candidate) return null;
  const decoded = decodeURIComponent(candidate).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (parameter) return /r\d{2,}/i.exec(decoded)?.[0] ?? decoded;
  return /^(?:r|jr)\d+$/i.test(decoded) ? decoded : null;
}

function sameJobUrl(page: SafePage, canonical: string, requisitionId: string): boolean {
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const expected = normalized(requisitionId);
  const canonicalMarker = urlRequisition(canonical);
  if (canonicalMarker && canonicalMarker !== expected) return false;
  for (const current of [page.requestedUrl, page.finalUrl]) {
    if (observedUrl(current) === canonical) continue;
    let marker: string | null;
    try { marker = urlRequisition(current); } catch { return false; }
    if (marker && marker !== expected) return false;
    // A redirect or explicit same-job canonical can explain an alternate
    // path; unrelated JSON-LD alone cannot turn that path into an alias.
    const canonicalLink = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(page.body)?.[1];
    let declared: string | null = null;
    try { declared = canonicalLink ? observedUrl(new URL(canonicalLink, page.finalUrl).href) : null; }
    catch { /* invalid canonical is no evidence */ }
    if (!marker && declared !== canonical) return false;
  }
  return true;
}

function basePay(node: JsonObject): string | null {
  const salary = object(node.baseSalary);
  const value = object(salary?.value);
  const currency = string(salary?.currency);
  const min = value?.minValue;
  const max = value?.maxValue;
  const unit = string(value?.unitText);
  if (!currency || !unit || typeof min !== "number" || !Number.isFinite(min) || min < 0 ||
    typeof max !== "number" || !Number.isFinite(max) || max < min) return null;
  return `${currency} ${min}–${max} per ${unit}`;
}

export function normalizeJobPosting(source: EmployerSource, page: SafePage): ResolutionResult {
  if (page.status === 403) return held("blocked", "Employer page denied access", true);
  if (page.status === 404 || page.status === 410) return held("not_found", `Employer page HTTP ${page.status}`);
  if (page.status === 429 || page.status >= 500) return held("transient", `Employer page HTTP ${page.status}`, true);
  if (page.status !== 200) return held("unsupported", `Employer page HTTP ${page.status}`);
  const postings = jobPostingNodes(page);
  if (!postings.length) return held("unsupported", "No readable JobPosting data");
  const identities = new Set(postings.map(reqId));
  if (postings.length > 1 && (identities.size !== 1 ||
    new Set(postings.map(node => [string(node.title), string(node.url), string(object(node.hiringOrganization)?.name)].join("|"))).size !== 1)) {
    return held("ambiguous", "Multiple incompatible JobPosting nodes");
  }
  const node = postings[0];
  const requisitionId = reqId(node);
  if (!requisitionId) return held("invalid_identity", "JobPosting lacks a stable requisition identifier");
  if (!companyMatches(source, node)) return held("invalid_identity", "JobPosting organization conflicts with source owner");
  const canonical = canonicalUrl(source, node, page);
  if (!canonical) return held("invalid_identity", "JobPosting canonical URL is not a registered job page");
  if (!sameJobUrl(page, canonical, requisitionId)) {
    return held("ambiguous", "Fetched URL and JobPosting canonical identify different jobs");
  }
  const title = string(node.title);
  if (!title) return held("invalid_identity", "JobPosting title is missing");
  const description = htmlToTextWithProvenance(node.description, MAX_DESCRIPTION_CHARS, ["JobPosting.description"]);
  if (!description.text) return held("unsupported", "JobPosting description is unreadable");
  const visible = htmlToTextWithProvenance(page.body.replace(/<script\b[\s\S]*?<\/script>/gi, ""),
    MAX_DESCRIPTION_CHARS).text ?? "";
  const hybrid = /\bhybrid\b|\b\d+\s+days?\b[^.]{0,80}\boffice\b/i.test(`${description.text}\n${visible}`);
  const remote = string(node.jobLocationType)?.toUpperCase().includes("TELECOMMUTE") ?? false;
  if (remote && hybrid) return held("ambiguous", "Structured remote flag conflicts with hybrid office requirement");
  const locations = locationList(node);
  const geography = applicantGeography(node);
  if (remote && geography.length && locations.length) {
    return held("ambiguous", "Remote applicant geography and office locations require separate location review");
  }
  if (/\b(?:remote\s+(?:us|u\.s\.|united states)\s+(?:is\s+)?(?:unavailable|not available|not permitted)|(?:must|required to)\s+(?:reside|live|be based)\s+in\s+[^.\n]{2,100}|hiring\s+only\s+in\s+[^.\n]{2,100}|only\s+(?:hiring|candidates)\s+in\s+[^.\n]{2,100})/i.test(visible)) {
    return held("ambiguous", "Visible location restriction needs review");
  }
  const visibleLocation = /(?:^|\n)\s*(?:work\s+)?locations?\s*:\s*([^\n.]{2,100})/i.exec(visible)?.[1]?.trim();
  if (visibleLocation && !/^(?:multiple|various|flexible|tbd)$/i.test(visibleLocation)) {
    const city = visibleLocation.split(/[,;/]/)[0].trim().toLowerCase();
    if (city && ![...locations, ...geography].some(place => place.toLowerCase().includes(city)) &&
      !(remote && /^remote\b/i.test(city))) {
      return held("ambiguous", "Visible location conflicts with structured JobPosting locations");
    }
  }
  const compensationText = basePay(node);
  const compensation = htmlToTextWithProvenance(compensationText, MAX_COMPENSATION_CHARS,
    compensationText ? ["baseSalary"] : []);
  const locationGaps = [
    ...(!locations.length ? ["jobLocation: no usable office locations"] : []),
    ...(remote && !geography.length ? ["applicantLocationRequirements: remote geography not supplied"] : []),
  ];
  const gaps = [
    ...(!compensationText ? ["baseSalary: complete base-pay range not supplied"] : []),
    ...locationGaps,
  ];
  const id = `employer:${source.key}:${encodeURIComponent(requisitionId)}`;
  const postedAt = string(node.datePosted);
  const job: NormalizedJob = { id, company: source.name, title, url: canonical,
    location: locations.join("; ") || (remote ? `Remote${geography.length ? `: ${geography.join("; ")}` : ", geography unverified"}` : "unspecified"),
    locationMetadata: { workplaceType: remote ? "remote" : hybrid ? "hybrid" : locations.length ? "onsite" : null,
      secondaryLocations: locations.slice(1), coverageGaps: locationGaps,
      sourceFields: ["JobPosting.jobLocation", ...(remote ? ["JobPosting.jobLocationType"] : []),
        ...(geography.length ? ["JobPosting.applicantLocationRequirements"] : [])] },
    department: "unspecified", isRemote: remote ? true : hybrid ? false : null,
    employmentType: employmentType(node),
    postedAt: postedAt && !Number.isNaN(Date.parse(postedAt)) ? postedAt : null,
    compensation: compensation.text, description: description.text,
    contentProvenance: { description: description.provenance, compensation: compensation.provenance,
      coverageGaps: gaps },
  };
  const aliases = [...new Set([page.requestedUrl, page.finalUrl, canonical].map(observedUrl)
    .filter((url): url is string => !!url))];
  return { kind: "resolved", posting: { kind: "employer", jobId: id,
    canonicalUrl: canonical, employerKey: source.key, requisitionId, job }, aliases,
    evidence: [
      { url: canonical, method: "jobposting", employerKey: source.key, requisitionId },
      ...aliases.filter(url => url !== canonical).map(url => ({ url,
        method: "redirect" as const, employerKey: source.key, requisitionId })),
    ] };
}
