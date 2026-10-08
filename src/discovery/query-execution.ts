import { fencedBatch, type DiscoveryLease } from "../operations/leases";
import { isExcludedCompany, jobRefId, parseJobUrl, titleCaseSlug,
  type ExclusionSet } from "../unbounded/discovery";
import { recordQueryPage, recordUrlObservation, type UrlObservation } from "./coverage";
import { observedUrl } from "./observe";
import { compileQuery, type QueryPageRequest, type QuerySpec, type VerifiedEmployer } from "./queries";
import type { QueryPageOutcome } from "./query-pages";

type Checkpoint = (name: string, callback: () => Promise<QueryPageOutcome>) => Promise<QueryPageOutcome>;

export type RecordedPageInput = {
  db: D1Database;
  lease: DiscoveryLease;
  query: QuerySpec;
  registry?: readonly VerifiedEmployer[];
  page: number;
  maxPagesPerQuery: number;
  exclusion: ExclusionSet;
  checkpoint: Checkpoint;
  provider: (request: QueryPageRequest) => Promise<QueryPageOutcome>;
};

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function runRecordedQueryPage(input: RecordedPageInput): Promise<QueryPageOutcome> {
  const { db, lease, query, page, exclusion } = input;
  const request = compileQuery(query, page, input.registry);
  const queryId = `${query.version}:${query.id}`;
  const attemptId = `${lease.owner}:${queryId}:${page}:1`;
  const queryHash = await digest(JSON.stringify(request));
  const base = { runId: lease.owner, queryId, page, attemptId, queryHash };
  const checkpointName = `query:${query.version}:${query.id}:page:${page}`;
  const outcome = await input.checkpoint(checkpointName, async () => {
    const existing = await db.prepare(`SELECT status,raw_hits,error_code FROM discovery_query_pages
      WHERE run_id=? AND query_id=? AND page=?`).bind(lease.owner, queryId, page)
      .first<{ status: string; raw_hits: number; error_code: string | null }>();
    if (existing?.status === "complete") {
      const rows = (await db.prepare(`SELECT observed_url,title FROM discovery_query_page_results
        WHERE run_id=? AND query_id=? AND page=? ORDER BY ordinal`)
        .bind(lease.owner, queryId, page).all<{observed_url:string|null;title:string}>()).results;
      if (rows.length === existing.raw_hits) return { status: "complete", results: rows.map(row => ({
        link: row.observed_url ?? "", title: row.title,
      })) };
    }
    if (existing?.status === "failed") return { status: "failed",
      errorCode: existing.error_code ?? "provider_error" };
    if (existing) return { status: "uncertain", errorCode: "request_outcome_unknown" };
    const startedAt = new Date().toISOString();
    await recordQueryPage(db, lease, { ...base, startedAt, finishedAt: null,
      status: "uncertain", rawHits: 0, httpStatus: null, stoppedBy: null });
    return input.provider(request);
  });
  if (outcome.status === "complete") {
    await fencedBatch(db, lease, outcome.results.map((result, ordinal) =>
      db.prepare(`INSERT INTO discovery_query_page_results
        (run_id,query_id,page,ordinal,observed_url,title) VALUES (?,?,?,?,?,?)
        ON CONFLICT(run_id,query_id,page,ordinal) DO NOTHING`)
        .bind(lease.owner, queryId, page, ordinal, observedUrl(result.link), result.title.slice(0, 500))));
    for (const [ordinal, result] of outcome.results.entries()) {
      const normalizedUrl = observedUrl(result.link);
      const ref = normalizedUrl ? parseJobUrl(normalizedUrl, result.title) : null;
      const excluded = ref && isExcludedCompany(ref.ats, ref.slug, titleCaseSlug(ref.slug), exclusion);
      const observed: UrlObservation["outcome"] = !normalizedUrl ? "malformed" :
        excluded ? "excluded" : ref ? "resolved" : "unsupported";
      await recordUrlObservation(db, lease, { runId: lease.owner, queryId, page, ordinal,
        rawUrl: normalizedUrl, normalizedUrl, outcome: observed,
        jobId: observed === "resolved" ? jobRefId(ref!) : null,
        reasonCode: observed === "unsupported" ? "unsupported_employer_url" : null });
    }
  }
  if (outcome.status !== "uncertain") {
    await recordQueryPage(db, lease, { ...base, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), status: outcome.status,
      rawHits: outcome.status === "complete" ? outcome.results.length : 0,
      httpStatus: outcome.status === "complete" ? 200 :
        Number(/^http_(\d{3})$/.exec(outcome.errorCode)?.[1]) || null,
      errorCode: outcome.status === "failed" ? outcome.errorCode : null,
      stoppedBy: outcome.status === "complete"
        ? outcome.results.length === 0 ? "empty" : page >= input.maxPagesPerQuery ? "page_limit" : null
        : "failure" });
  }
  return outcome;
}
