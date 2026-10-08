export type BenchmarkCase = {
  id: string;
  split: "development" | "holdout" | "observational";
  provenance: "synthetic" | "public_observation";
  observedAt: string | null;
  originalUrl: string;
  canonicalJobId: string | null;
  expectedAliases: string[];
  indexedByBaseline: "observed" | "not_observed" | "unknown";
  sourceFixture: string;
  sourceSha256: string;
  sourceCoverage: "complete_observed_fields" | "partial" | "unknown";
  expected: null | {
    resolvable: boolean;
    location: "eligible" | "ineligible" | "review";
    screening: "match" | "no_match" | "needs_review";
    qualificationGroups: Array<{
      id: string;
      sourceField: "description";
      excerpt: string;
      requiredMeaning: string;
    }>;
    rationale: string;
  };
  tags: string[];
};

export type BenchmarkManifest = {
  schemaVersion: 1;
  baselineCommit: string;
  frozenAt: string;
  holdout: { state: "sealed"; manifestSha256: string; custodian: string } |
    { state: "unavailable"; reason: string };
  cases: BenchmarkCase[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA256 digest`);
}

export function validateBenchmarkManifest(value: unknown, options: { requireFrozenHoldout?: boolean } = {}): BenchmarkManifest {
  const manifest = object(value, "benchmark manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported benchmark schema version");
  nonempty(manifest.baselineCommit, "baseline commit");
  nonempty(manifest.frozenAt, "freeze time");
  if (Number.isNaN(Date.parse(manifest.frozenAt as string))) throw new Error("Invalid freeze time");
  const holdout = object(manifest.holdout, "holdout");
  if (holdout.state === "sealed") {
    digest(holdout.manifestSha256, "holdout manifest SHA256");
    nonempty(holdout.custodian, "holdout custodian");
  } else if (holdout.state === "unavailable") {
    nonempty(holdout.reason, "holdout unavailable reason");
  } else {
    throw new Error("Unknown holdout state");
  }
  if (!Array.isArray(manifest.cases)) throw new Error("Benchmark cases are required");
  const seen = new Set<string>();
  let holdoutCases = 0;
  for (const raw of manifest.cases) {
    const item = object(raw, "benchmark case");
    const id = nonempty(item.id, "case ID");
    if (seen.has(id)) throw new Error(`Duplicate case ID: ${id}`);
    seen.add(id);
    if (!["development", "holdout", "observational"].includes(String(item.split))) throw new Error(`Invalid split for ${id}`);
    if (!["synthetic", "public_observation"].includes(String(item.provenance))) throw new Error(`Invalid provenance for ${id}`);
    if (item.split === "holdout") {
      holdoutCases++;
      if (holdout.state !== "sealed") throw new Error("Holdout cases require a frozen sealed manifest");
      if (item.provenance !== "public_observation" || item.observedAt === null) {
        throw new Error("Holdout cases require fresh public observations, not synthetic fixtures");
      }
    }
    if (item.split !== "observational" && item.expected === null) throw new Error(`Missing expected label for ${id}`);
    if (item.expected !== null) {
      const expected = object(item.expected, `expected label for ${id}`);
      if (typeof expected.resolvable !== "boolean" ||
        !["eligible", "ineligible", "review"].includes(String(expected.location)) ||
        !["match", "no_match", "needs_review"].includes(String(expected.screening)) ||
        !Array.isArray(expected.qualificationGroups)) throw new Error(`Incomplete expected label for ${id}`);
      nonempty(expected.rationale, `label rationale for ${id}`);
    }
    if (item.provenance === "synthetic" && (item.indexedByBaseline === "observed" || item.observedAt !== null)) {
      throw new Error(`Synthetic case ${id} cannot claim observed live evidence`);
    }
    if (!["observed", "not_observed", "unknown"].includes(String(item.indexedByBaseline))) throw new Error(`Invalid indexing label for ${id}`);
    if (!["complete_observed_fields", "partial", "unknown"].includes(String(item.sourceCoverage))) throw new Error(`Invalid source coverage for ${id}`);
    nonempty(item.originalUrl, `original URL for ${id}`);
    nonempty(item.sourceFixture, `source fixture for ${id}`);
    digest(item.sourceSha256, `source SHA256 for ${id}`);
    if (!Array.isArray(item.expectedAliases) || !Array.isArray(item.tags)) throw new Error(`Aliases and tags required for ${id}`);
  }
  if (options.requireFrozenHoldout && (holdout.state !== "sealed" || holdoutCases === 0)) {
    throw new Error("Live comparison requires a frozen holdout");
  }
  return value as BenchmarkManifest;
}

export function scoreDiscoveryCases(cases: readonly BenchmarkCase[],
  observedUrls: readonly string[], resolvedJobIds: readonly string[]) {
  const urls = new Set(observedUrls.map(observedUrl).filter((url): url is string => !!url));
  const jobs = new Set(resolvedJobIds);
  const rows = cases.map(item => {
    const aliases = item.expectedAliases.map(observedUrl).filter((url): url is string => !!url);
    const urlSeen = aliases.some(url => urls.has(url));
    return { caseId: item.id, split: item.split, provenance: item.provenance,
      indexedByBaseline: item.indexedByBaseline, urlSeen,
      canonicalRecovered: item.canonicalJobId === null ? null : jobs.has(item.canonicalJobId) };
  });
  const counts = Object.fromEntries(["development", "holdout", "observational"].map(split => {
    const observed = rows.filter(row => row.split === split && row.provenance === "public_observation");
    const relevantIds = new Set(cases.filter(item => item.split === split &&
      item.provenance === "public_observation" && item.expected?.screening === "match" &&
      item.expected.location === "eligible" && item.canonicalJobId !== null)
      .map(item => item.canonicalJobId!));
    const recoveredIds = [...relevantIds].filter(id => jobs.has(id));
    return [split, { urlSeen: observed.filter(row => row.urlSeen).length,
      urlDenominator: observed.length, canonicalRecovered: recoveredIds.length,
      canonicalDenominator: relevantIds.size,
      relevantIdentityUnresolved: cases.filter(item => item.split === split &&
        item.provenance === "public_observation" && item.expected?.screening === "match" &&
        item.expected.location === "eligible" && item.canonicalJobId === null).length,
      indexedUnknown: observed.filter(row => row.indexedByBaseline === "unknown").length,
      observationWindowUnverified: observed.length }];
  }));
  return { rows, counts };
}
import { observedUrl } from "./observe";
