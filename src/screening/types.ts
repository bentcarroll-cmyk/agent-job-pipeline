import type { CompanyCategory, NormalizedJob } from "../sources";

export type ScreeningState = "match" | "no_match" | "needs_review" | "retry";
export type EvidenceField = "location" | "employment" | "compensation" | "clearance" | "function" | "company_category" | "qualification";
// workplaceType and secondaryLocations are the snapshot's location metadata.
// A secondaryLocations fact's offsets index the list joined one per line.
export type EvidenceSourceField = "description" | "compensation" | "location" | "employmentType" | "title" | "department" | "companyCategory" |
  "workplaceType" | "secondaryLocations";
export type PostingSnapshot = {
  id: string;
  jobId: string;
  contentHash: string;
  job: NormalizedJob;
  companyCategory: CompanyCategory | null;
  fetchedAt: string | null;
  normalizerVersion: string;
};
export type EvidenceFact = {
  field: EvidenceField;
  value: string;
  sourceUrl: string;
  excerpt: string;
  sourceField: EvidenceSourceField;
  snapshotId: string;
  start: number;
  end: number;
};
export type ScreeningDecision = {
  state: ScreeningState;
  lane: "A" | "B" | null;
  reason: string;
  evidence: EvidenceFact[];
  gaps: string[];
  qualificationWarnings: string[];
  hardExclude: "employment" | "clearance" | "compensation" | "location" | null;
  criteriaVersion: string;
  promptVersion: string;
  model: string;
};
export type ScreeningResult = { snapshot: PostingSnapshot; decision: ScreeningDecision };
export type ScreeningEvaluation = {
  id: string;
  jobId: string;
  runId: string;
  snapshot: PostingSnapshot | null;
  decision: ScreeningDecision;
  evaluatedAt: string;
};
