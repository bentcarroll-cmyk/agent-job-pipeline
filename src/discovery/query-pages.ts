import { compileQuery, type QueryPageRequest, type QuerySpec, type VerifiedEmployer } from "./queries";
import type { SerperOrganicResult } from "../unbounded/discovery";

export type QueryPageOutcome =
  | { status: "complete"; results: SerperOrganicResult[] }
  | { status: "failed" | "uncertain"; errorCode: string; retryAfterSeconds?: number | null };

export type QueryPageRunner = {
  baseline: readonly QuerySpec[];
  exploration: readonly QuerySpec[];
  baselineBudget: number;
  explorationBudget: number;
  maxPagesPerQuery: number;
  registry?: readonly VerifiedEmployer[];
  execute: (request: QueryPageRequest, query: QuerySpec) => Promise<QueryPageOutcome>;
};

export type QueryPagesResult = {
  hits: SerperOrganicResult[];
  hitObservations: Array<{ queryId: string; family: QuerySpec["family"]; page: number;
    ordinal: number; link: string; title: string }>;
  rawHitOccurrences: number;
  usage: { baselinePages: number; explorationPages: number };
  pageFailures: Array<{ queryId: string; page: number; errorCode: string; retryAfterSeconds: number | null }>;
  incompleteQueries: Array<{ queryId: string; reason: "budget" | "page_limit" | "repeated_page" | "failure" | "uncertain" }>;
};

type State = { query: QuerySpec; lane: "baseline" | "exploration"; active: boolean; previousLinks: string | null };

function validBudget(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

// The executor owns scheduling and accounting units. The caller owns the
// durable per-page checkpoint and the transport; one execute call means one
// budgeted request intent, including an uncertain request.
export async function runQueryPages(input: QueryPageRunner): Promise<QueryPagesResult> {
  if (!validBudget(input.baselineBudget) || !validBudget(input.explorationBudget) ||
    !Number.isSafeInteger(input.maxPagesPerQuery) || input.maxPagesPerQuery < 1) {
    throw new Error("Invalid search page budget");
  }
  if (input.baselineBudget < input.baseline.length || input.explorationBudget < input.exploration.length) {
    throw new Error("Search budget must cover all selected first pages");
  }
  const states: State[] = [
    ...input.baseline.map(query => ({ query, lane: "baseline" as const, active: true, previousLinks: null })),
    ...input.exploration.map(query => ({ query, lane: "exploration" as const, active: true, previousLinks: null })),
  ];
  if (new Set(states.map(state => `${state.query.version}:${state.query.id}`)).size !== states.length) {
    throw new Error("Duplicate query identity");
  }
  const result: QueryPagesResult = { hits: [], hitObservations: [], rawHitOccurrences: 0,
    usage: { baselinePages: 0, explorationPages: 0 },
    pageFailures: [], incompleteQueries: [] };
  const seenLinks = new Set<string>();
  for (let page = 1; page <= input.maxPagesPerQuery; page++) {
    for (const state of states) {
      if (!state.active) continue;
      const spentKey = state.lane === "baseline" ? "baselinePages" : "explorationPages";
      const ceiling = state.lane === "baseline" ? input.baselineBudget : input.explorationBudget;
      if (result.usage[spentKey] >= ceiling) {
        state.active = false;
        result.incompleteQueries.push({ queryId: state.query.id, reason: "budget" });
        continue;
      }
      const request = compileQuery(state.query, page, input.registry);
      // Reserve the page before calling the injected transport. It can return
      // uncertain after a crash without a second provider request.
      result.usage[spentKey]++;
      const outcome = await input.execute(request, state.query);
      if (!outcome || !["complete", "failed", "uncertain"].includes(outcome.status)) {
        throw new Error("Invalid search page outcome");
      }
      if (outcome.status !== "complete") {
        state.active = false;
        result.pageFailures.push({ queryId: state.query.id, page, errorCode: outcome.errorCode,
          retryAfterSeconds: outcome.retryAfterSeconds ?? null });
        result.incompleteQueries.push({ queryId: state.query.id,
          reason: outcome.status === "uncertain" ? "uncertain" : "failure" });
        continue;
      }
      if (!Array.isArray(outcome.results) || outcome.results.some(hit =>
        !hit || typeof hit.link !== "string" || typeof hit.title !== "string")) {
        state.active = false;
        result.pageFailures.push({ queryId: state.query.id, page,
          errorCode: "malformed_response", retryAfterSeconds: null });
        result.incompleteQueries.push({ queryId: state.query.id, reason: "failure" });
        continue;
      }
      result.rawHitOccurrences += outcome.results.length;
      outcome.results.forEach((hit, ordinal) => result.hitObservations.push({
        queryId: state.query.id, family: state.query.family, page, ordinal,
        link: hit.link, title: hit.title,
      }));
      if (outcome.results.length === 0) { state.active = false; continue; }
      const links = JSON.stringify([...new Set(outcome.results.map(hit => hit.link))].sort());
      if (state.previousLinks === links) {
        state.active = false;
        result.incompleteQueries.push({ queryId: state.query.id, reason: "repeated_page" });
        continue;
      }
      state.previousLinks = links;
      for (const hit of outcome.results) {
        if (seenLinks.has(hit.link)) continue;
        seenLinks.add(hit.link);
        result.hits.push(hit);
      }
    }
  }
  for (const state of states) {
    if (state.active) result.incompleteQueries.push({ queryId: state.query.id, reason: "page_limit" });
  }
  return result;
}
