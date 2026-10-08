import type { DiscoveryLease } from "../operations/leases";
import { isExcludedCompany, jobRefId, parseJobUrl, titleCaseSlug,
  type ExclusionSet } from "../unbounded/discovery";
import { candidateKeyFor, persistCandidate } from "./candidates";
import { observedUrl } from "./observe";
import { directAtsResolution } from "./resolve";

export async function persistSearchPageHits(db: D1Database, lease: DiscoveryLease,
  input: { queryId: string; page: number; hits: readonly { link: string; title: string }[];
    discoveredAt: string; exclusion: ExclusionSet }): Promise<{ saved: number; malformed: number; excluded: number }> {
  let saved = 0;
  let malformed = 0;
  let excluded = 0;
  for (const hit of input.hits) {
    const url = observedUrl(hit.link);
    if (!url) { malformed++; continue; }
    const ref = parseJobUrl(url, hit.title);
    if (ref && isExcludedCompany(ref.ats, ref.slug, titleCaseSlug(ref.slug), input.exclusion)) {
      excluded++;
      continue;
    }
    const jobId = ref ? jobRefId(ref) : null;
    await persistCandidate(db, lease, { candidateKey: await candidateKeyFor(url, jobId),
      originalUrl: url, canonicalJobId: jobId, discoveredAt: input.discoveredAt,
      sourceId: `${input.queryId}:${input.page}`, resolution: ref ? directAtsResolution(ref) : null });
    saved++;
  }
  return { saved, malformed, excluded };
}
