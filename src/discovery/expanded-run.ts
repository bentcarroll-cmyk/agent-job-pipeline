import type { RuntimeConfig } from "../config/types";
import { advanceRotationCursor, getRotationCursor } from "../db";
import type { DiscoveryLease } from "../operations/leases";
import { isExcludedCompany, jobRefId, parseJobUrl, titleCaseSlug,
  type ExclusionSet, type JobRef } from "../unbounded/discovery";
import { runRecordedQueryPage } from "./query-execution";
import { runQueryPages, type QueryPageOutcome, type QueryPagesResult } from "./query-pages";
import { requestSerperPage } from "./query-provider";
import { buildQueryBanks, selectExplorationQueries } from "./queries";

type Checkpoint = <T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>) => Promise<T>;
export type ExpandedSearch = { refs: JobRef[]; report: QueryPagesResult };

// Every provider page is its own Workflow checkpoint and durable D1 intent.
// The plan checkpoint freezes query rotation before the first paid request.
export async function runExpandedSearch(input: { db: D1Database; lease: DiscoveryLease;
  runtime: RuntimeConfig; apiKey: string; exclusion: ExclusionSet; checkpoint: Checkpoint;
  provider?: typeof requestSerperPage;
  onPageHits?: (input: { queryId: string; page: number; hits: Extract<QueryPageOutcome, { status: "complete" }> }) => Promise<void> }): Promise<ExpandedSearch> {
  const banks = buildQueryBanks(input.runtime);
  const plan = await input.checkpoint("expanded-query-plan", async () => {
    const cursor = await getRotationCursor(input.db, input.lease);
    const selected = selectExplorationQueries(banks.rotation, cursor, Math.min(12, banks.rotation.length));
    return { criteriaVersion: input.runtime.criteriaVersion, queryIds: selected.queries.map(query => query.id), nextCursor: selected.nextCursor };
  });
  if (plan.criteriaVersion !== input.runtime.criteriaVersion) throw new Error("Frozen query plan configuration version changed");
  const selected = plan.queryIds.map(id => {
    const query = banks.rotation.find(item => item.id === id);
    if (!query) throw new Error("Frozen query plan references an unknown versioned query");
    return query;
  });
  const report = await runQueryPages({ baseline: banks.baseline, exploration: selected,
    baselineBudget: 150, explorationBudget: 60, maxPagesPerQuery: 5,
    execute: async (_request, query) => {
      const outcome = await runRecordedQueryPage({ db: input.db, lease: input.lease,
        query, page: _request.page, maxPagesPerQuery: 5, exclusion: input.exclusion,
        checkpoint: (name, callback): Promise<QueryPageOutcome> => input.checkpoint(name, callback),
        provider: request => (input.provider ?? requestSerperPage)(input.apiKey, request) });
      if (outcome.status === "complete" && input.onPageHits) {
        await input.checkpoint(`candidates:${query.version}:${query.id}:page:${_request.page}`, async () => {
          await input.onPageHits!({ queryId: query.id, page: _request.page, hits: outcome });
          return true;
        });
      }
      return outcome;
    },
  });
  await input.checkpoint("expanded-query-advance", async () => {
    await advanceRotationCursor(input.db, plan.nextCursor, input.lease);
    return true;
  });
  const refs = new Map<string, JobRef>();
  for (const hit of report.hits) {
    const ref = parseJobUrl(hit.link, hit.title);
    if (!ref || isExcludedCompany(ref.ats, ref.slug, titleCaseSlug(ref.slug), input.exclusion)) continue;
    refs.set(jobRefId(ref), ref);
  }
  return { refs: [...refs.values()], report };
}
