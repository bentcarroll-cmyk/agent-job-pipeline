import type { RuntimeConfig } from "./config/types";
import { configuredSources } from "./config/sources";
import { buildQueryBanks } from "./discovery/queries";
import { fetchJobForRef } from "./fetch-job";
import { filterJob, type FilterEnv } from "./filter";
import { type NormalizedJob } from "./sources";
import { buildExclusionSet, findPostingsForPhrases, jobRefId, parseJobUrl, type JobRef } from "./unbounded/discovery";
import type { Verdict } from "./criteria";
import { evaluateJob } from "./screening/evaluate";
import type { ScreeningResult, ScreeningState } from "./screening/types";

type PreviewRow = { id: string; url: string; status: "fetched" | "closed" | "retry"; job?: NormalizedJob; verdict?: Verdict; screening?: ScreeningResult; error?: string; evaluationError?: string };
export interface PreviewOptions {
  runtime: RuntimeConfig;
  urls?: string[];
  phrases?: string[];
  apiKey?: string;
  maxPostings: number;
  evaluate?: FilterEnv;
}

// No database or Slack dependencies. Search is capped at three phrases and
// one page each; details/evaluation are capped independently at 50 postings.
export async function previewDiscovery(options: PreviewOptions) {
  const { maxPostings, evaluate, runtime } = options;
  const banks = buildQueryBanks(runtime);
  const approvedPhrases = new Set([...banks.baseline, ...banks.exploration].map(query => query.terms[0]));
  if (options.phrases?.some(phrase => !approvedPhrases.has(phrase))) throw new Error("Preview phrases require candidate search approval");
  if (!Number.isInteger(maxPostings) || maxPostings < 1 || maxPostings > 50) throw new Error("maxPostings must be an integer from 1 to 50");
  if ((options.phrases?.length ?? 0) > 3) throw new Error("At most three search phrases are allowed");
  const refs = new Map<string, JobRef>();
  const errors: string[] = [];
  let unsupported = 0;
  for (const url of options.urls ?? []) {
    const ref = parseJobUrl(url, "");
    if (ref?.ats === "workday") refs.set(jobRefId(ref), ref);
    else unsupported++;
  }
  if (options.phrases?.length) {
    if (!options.apiKey) throw new Error("SERPER_API_KEY is required for search");
    const result = await findPostingsForPhrases(options.apiKey, options.phrases, buildExclusionSet(configuredSources(runtime), [...runtime.candidate.search.unresolvedEmployers]), 1);
    for (const ref of result.refs) if (ref.ats === "workday") refs.set(jobRefId(ref), ref);
    errors.push(...result.errors);
  }
  const counts = { found: refs.size, attempted: Math.min(refs.size, maxPostings), fetched: 0, closed: 0, retry: 0, unsupported, deferred: Math.max(0, refs.size - maxPostings), evaluated: 0, evaluationFailures: 0, matches: evaluate ? 0 : null as number | null, screening: evaluate ? { match: 0, no_match: 0, needs_review: 0, retry: 0 } as Record<ScreeningState, number> : null };
  const rows: PreviewRow[] = [];
  for (const ref of [...refs.values()].slice(0, maxPostings)) {
    const row: PreviewRow = { id: jobRefId(ref), url: ref.url, status: "retry" };
    rows.push(row);
    try {
      const job = await fetchJobForRef(ref);
      if (!job) { row.status = "closed"; counts.closed++; continue; }
      row.status = "fetched";
      row.job = job;
      counts.fetched++;
    } catch (error) {
      counts.retry++;
      if (counts.screening) counts.screening.retry++;
      row.error = (error as Error).message;
      continue;
    }
    if (evaluate) {
      try {
        if (evaluate.SCREENING_MODE === "evidence") {
          row.screening = await evaluateJob(evaluate, row.job!);
          counts.screening![row.screening.decision.state]++;
          if (row.screening.decision.state === "match") counts.matches!++;
          if (row.screening.decision.state === "retry") {
            counts.evaluationFailures++;
            row.evaluationError = row.screening.decision.reason;
          }
        } else {
          row.verdict = await filterJob(evaluate, row.job!);
          counts.screening![row.verdict.match ? "match" : "no_match"]++;
          if (row.verdict.match) counts.matches!++;
        }
        counts.evaluated++;
      } catch (error) {
        counts.evaluationFailures++;
        counts.screening!.retry++;
        row.evaluationError = (error as Error).message;
      }
      // Match production's pacing between model calls.
      if (rows.length < counts.attempted) await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
  return { createdAt: new Date().toISOString(), source: "workday", evaluated: Boolean(evaluate), counts, searchErrors: errors, rows };
}
