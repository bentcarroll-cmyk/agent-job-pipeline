// Resolves a parsed job reference to a normalized posting.
//
// Deliberately free of Workers-only imports. src/unbounded/index.ts pulls in
// cloudflare:workers, so a helper living there cannot be loaded by the local
// materials tooling, which runs this same code in Node under tsx. Keeping it
// here means the Worker and the CLI share one implementation of the ATS
// parsing rather than a second copy that drifts.
import { fetchCompanyBoard, fetchPosting, type NormalizedJob } from "./sources";
import { MAX_DESCRIPTION_CHARS } from "./description";
import { jobRefId, titleCaseSlug, type JobRef } from "./unbounded/discovery";

export async function fetchJobForRef(
  ref: JobRef,
  descriptionLimit: number = MAX_DESCRIPTION_CHARS,
): Promise<NormalizedJob | null> {
  const company = titleCaseSlug(ref.slug);
  if (ref.ats !== "ashby") {
    const job = await fetchPosting(
      { ats: ref.ats, slug: ref.slug, postingId: ref.postingId, url: ref.url },
      company,
      descriptionLimit,
    );
    return job ? { ...job, id: jobRefId(ref) } : null;
  }
  // Ashby publishes no per-posting endpoint, so the board is fetched and the
  // posting picked out of it — the same approach the scheduled run uses.
  const board = await fetchCompanyBoard("ashby", company, ref.slug, descriptionLimit);
  const match = board.find((j) => j.id.toLowerCase().endsWith(`:${ref.postingId}`));
  return match ? { ...match, id: jobRefId(ref) } : null;
}
