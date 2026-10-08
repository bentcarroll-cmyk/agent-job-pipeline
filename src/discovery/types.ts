import type { JobRef } from "../unbounded/discovery";
import type { NormalizedJob } from "../sources";

export type EmployerSource = {
  key: string;
  name: string;
  careerHosts: readonly string[];
  atsHosts: readonly string[];
  evidenceUrl: string;
  verifiedAt: string;
  adapter: "workday" | "greenhouse" | "ashby" | "lever" | "jobposting";
  boardUrl: string | null;
};
export type SafePage = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  redirects: readonly string[];
  requestCount: number;
  fetchedAt: string;
};
export type SafePageFetcher = (
  url: string,
  limits: { maxRequests: number; maxRedirects: number; maxBytes: number; timeoutMs: number },
) => Promise<SafePage>;
export type ResolverDependencies = {
  registry: readonly EmployerSource[];
  fetchPage: SafePageFetcher;
  now: () => string;
};
export type ResolutionEvidence = {
  url: string;
  method: "direct_ats" | "redirect" | "canonical" | "embedded_ats" | "jobposting";
  employerKey: string | null;
  requisitionId: string | null;
};
export type ResolvedPosting =
  | { kind: "ats"; jobId: string; canonicalUrl: string; ref: JobRef }
  | { kind: "employer"; jobId: string; canonicalUrl: string; employerKey: string;
      requisitionId: string; job: NormalizedJob };
export type ResolutionResult =
  | { kind: "resolved"; posting: ResolvedPosting; aliases: string[]; evidence: ResolutionEvidence[] }
  | { kind: "held"; reason: "unsupported" | "ambiguous" | "blocked" | "not_found"
      | "invalid_identity" | "budget_exhausted" | "transient";
      detail: string; retryable: boolean };
export type PostingFetchResult =
  | { kind: "fetched"; job: NormalizedJob; sourceUrl: string; fetchedAt: string }
  | { kind: "not_found"; reason: "http_404" | "http_410" | "explicit_closed" | "absent_complete_board";
      sourceUrl: string; checkedAt: string; httpStatus: number | null }
  | { kind: "held"; reason: "blocked" | "transient" | "unsupported" | "invalid_identity" | "incomplete";
      retryable: boolean; detail: string; sourceUrl: string; httpStatus: number | null };

// Both search surfaces are bound to the admitted decision-affecting config.
export type DiscoveryConfigVersions = { queryVersion: string; registryVersion: string };
