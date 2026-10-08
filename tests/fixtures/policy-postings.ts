import { posting } from "./candidates";
import type { NormalizedJob } from "../../src/sources";
export function completePosting(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  const job = posting({ description: "Lead operations and improve workflows.", ...overrides });
  const p = (value: string | null) => ({ provided: value !== null, originalChars: value?.length ?? null, retainedChars: value?.length ?? 0, truncated: value === null ? null : false, sourceFields: value === null ? [] : ["synthetic"], normalizerVersion: "synthetic" });
  return { ...job, contentProvenance: { description: p(job.description), compensation: p(job.compensation), coverageGaps: [] } };
}
export const fact = (field: string, sourceField: string, excerpt: string) => ({ field, sourceField, excerpt, value: excerpt });
export function proposal(hardExclude: string | null = null, extra: ReturnType<typeof fact>[] = []) {
  return { state: hardExclude ? "no_match" : "match", lane: hardExclude ? null : "A", hardExclude, reason: "Synthetic supported assessment.", gaps: [], evidence: [fact("function", "description", "Lead operations and improve workflows."), fact("location", "location", "Chicago, IL"), ...extra] };
}
