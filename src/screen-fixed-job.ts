import { fetchPosting, fixedSourceCompanyCategory, fixedSourceForJob, matchesFixedWorkdaySource, type Source, type NormalizedJob } from "./sources";
import { filterJob, type FilterEnv, type ModelOptions } from "./filter";
import { parseJobUrl } from "./unbounded/discovery";
import { evaluateJob } from "./screening/evaluate";

// Called only after the fixed-board Workflow removes existing/known jobs.
// Keep the established fixed-board ID only when fresh detail proves the same
// employer and posting identity; changing it would bypass D1 deduplication.
export class FixedPostingFetchError extends Error {}

export async function screenFixedJob(env: FilterEnv, job: NormalizedJob, sources: readonly Source[],
  options: ModelOptions & { refreshLever?: boolean } = {}) {
  const { refreshLever = false, ...modelOptions } = options;
  let hydrated: NormalizedJob | null;
  try { hydrated = await hydrateFixedJob(job, refreshLever, sources); }
  catch (error) {
    if (env.SCREENING_MODE === "evidence") throw new FixedPostingFetchError((error as Error).message);
    throw error;
  }
  if (!hydrated) return null;
  return screenHydratedFixedJob(env, hydrated, sources, modelOptions);
}

// The Workflow records its durable fetch receipt between these two phases.
// Keep the original combined API for callers that do not account by stage.
export async function screenHydratedFixedJob(env: FilterEnv, hydrated: NormalizedJob, sources: readonly Source[],
  modelOptions: ModelOptions = {}) {
  const category = fixedSourceCompanyCategory(hydrated, sources);
  return env.SCREENING_MODE === "evidence"
    ? { job: hydrated, screening: await evaluateJob(env, hydrated, category, modelOptions) }
    : { job: hydrated, verdict: await filterJob(env, hydrated, category, modelOptions) };
}

export async function hydrateFixedJob(job: NormalizedJob, refreshLever: boolean, sources: readonly Source[]): Promise<NormalizedJob | null> {
  const selectedSource = fixedSourceForJob(job, sources);
  if (!selectedSource) throw new Error("Fixed-board source identity is outside the selected configuration");
  if (job.id.startsWith("greenhouse:")) {
    // The public application URL can be an employer's custom career page.
    // Bind the detail request to our configured board and stable posting ID.
    const source = selectedSource;
    const postingId = source ? job.id.slice(`greenhouse:${source.company}:`.length) : "";
    if (source?.ats !== "greenhouse" || !/^\d+$/.test(postingId)) {
      throw new Error("Greenhouse: invalid fixed-board posting identity");
    }
    const detail = await fetchPosting({ ats: "greenhouse", slug: source.slug, postingId, url: job.url }, job.company);
    if (!detail) return null;
    if (detail.id !== job.id || typeof detail.title !== "string" || !detail.title.trim() ||
      typeof detail.url !== "string" || !isWebUrl(detail.url) || !detail.description?.trim()) {
      throw new Error("Greenhouse: invalid or incomplete fixed-board posting detail");
    }
    job = detail;
  } else if (refreshLever && job.id.startsWith("lever:")) {
    const source = selectedSource;
    const postingId = source ? job.id.slice(`lever:${source.company}:`.length) : "";
    const ref = parseJobUrl(job.url, job.title);
    if (source?.ats !== "lever" || !/^[a-z0-9-]+$/i.test(postingId) ||
      ref?.ats !== "lever" || ref.slug !== source.slug.toLowerCase() ||
      ref.postingId !== postingId.toLowerCase()) {
      throw new Error("Lever: invalid fixed-board posting identity");
    }
    const detail = await fetchPosting({ ats: "lever", slug: source.slug,
      postingId, url: job.url }, job.company);
    if (!detail) return null;
    const detailRef = parseJobUrl(detail.url, detail.title);
    if (detail.id !== job.id || detailRef?.ats !== "lever" ||
      detailRef.slug !== source.slug.toLowerCase() || detailRef.postingId !== ref.postingId ||
      !detail.title?.trim() || !detail.description?.trim()) {
      throw new Error("Lever: invalid or incomplete fixed-board posting detail");
    }
    job = detail;
  } else if (job.id.startsWith("workday:")) {
    if (!matchesFixedWorkdaySource(job, sources)) throw new Error("Workday: invalid fixed-board posting identity");
    const ref = parseJobUrl(job.url, job.title);
    if (ref?.ats !== "workday") throw new Error("Workday: invalid fixed-board posting URL");
    const detail = await fetchPosting({ ...ref, ats: "workday" }, job.company);
    if (!detail) return null;
    if (detail.id !== job.id || !matchesFixedWorkdaySource(detail, sources)) {
      throw new Error("Workday: fixed-board detail identity changed");
    }
    job = detail;
  }
  return job;
}

function isWebUrl(url: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
