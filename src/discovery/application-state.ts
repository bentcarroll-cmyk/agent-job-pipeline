import { lookupKnownAtsApplication } from "../db";
import { sameEmployer } from "../ledger/match";
import { normalizeTitle } from "../ledger/normalize";
import { type Source, type NormalizedJob } from "../sources";
import { jobRefId, parseJobUrl } from "../unbounded/discovery";
import { lookupAliasOwner } from "./aliases";
import { clearFailures } from "../operations/retries";
import type { DiscoveryLease } from "../operations/leases";

type PostingIdentity = Pick<NormalizedJob, "id" | "url" | "company" | "title">;
export type DiscoveryApplicationState =
  | { kind: "clear" }
  | { kind: "protected"; reason: "user_disposition" | "known_application"; status: string | null; records: string[] }
  | { kind: "review"; reason: "possible_prior_application" | "pending_confirmation" | "ambiguous_application_identity"; records: string[] };

// Composite names nominate review only. They never establish an ATS owner.
function reviewEmployer(a: string, b: string): boolean {
  const parts = (name: string) => [name, ...name.split(/\s+[+/]\s+/)];
  return parts(a).some(left => parts(b).some(right => sameEmployer(left, right)));
}

export async function readDiscoveryApplicationState(db: D1Database, job: PostingIdentity, sources: readonly Source[]): Promise<DiscoveryApplicationState> {
  const ref = parseJobUrl(job.url, "");
  const keys = new Set([job.id]);
  if (ref) {
    keys.add(jobRefId(ref));
    for (const source of sources) {
      if (source.ats !== ref.ats) continue;
      const slug = "slug" in source ? source.slug : "tenant" in source ? source.tenant : null;
      if (slug?.toLowerCase() === ref.slug.toLowerCase()) keys.add(`${ref.ats}:${source.company}:${ref.postingId}`);
    }
  }
  const aliasOwner = await lookupAliasOwner(db, job.url);
  if (aliasOwner) keys.add(aliasOwner);
  const rows = (await db.prepare(`SELECT id,url,application_status,is_known_application FROM jobs
    WHERE lower(id) IN (${[...keys].map(() => "?").join(",")}) OR url=? LIMIT 101`)
    .bind(...[...keys].map(key => key.toLowerCase()), job.url).all<{
      id: string; url: string; application_status: string; is_known_application: number;
    }>()).results;
  const owners = rows.filter(row => {
    if (row.id === aliasOwner || row.url === job.url) return true;
    const observed = parseJobUrl(row.url, "");
    if (!ref || !observed) return row.id === job.id;
    if (jobRefId(observed).toLowerCase() !== jobRefId(ref).toLowerCase()) return false;
    if (ref.ats !== "workday") return true;
    const site = (url: string) => new URL(url).pathname.split("/").filter(Boolean)
      .filter((part, index) => index > 0 || !/^[a-z]{2}-[a-z]{2}$/i.test(part))[0]?.toLowerCase();
    return site(row.url) === site(job.url);
  });
  if (rows.length > 100 || owners.length > 1) return { kind: "review", reason: "ambiguous_application_identity", records: owners.map(row => row.id) };
  const owner = owners[0];
  if (owner && (owner.application_status !== "not_applied" || owner.is_known_application === 1)) {
    return { kind: "protected", reason: "user_disposition", status: owner.application_status, records: [owner.id] };
  }
  const lookup = await lookupKnownAtsApplication(db, { jobId: job.id, jobIds: [...keys],
    postingId: ref?.postingId ?? job.id.split(":").at(-1) ?? "",
    employerName: job.company, postingUrl: job.url });
  if (lookup.kind === "ambiguous") return { kind: "review", reason: "ambiguous_application_identity", records: [] };
  if (lookup.kind === "matched") return { kind: "protected", reason: "known_application",
    status: lookup.application.status, records: [lookup.application.source_job_id ?? job.id] };

  const title = normalizeTitle(job.title);
  if (!title) return { kind: "clear" };
  // Missing identity is uncertainty, not permission to attach this posting.
  // A differently identified row must never fall back to its matching title.
  const applications = (await db.prepare(`SELECT id,employer,title FROM known_applications
    WHERE NULLIF(trim(canonical_id),'') IS NULL AND NULLIF(trim(posting_url),'') IS NULL
      AND NULLIF(trim(requisition_id),'') IS NULL AND title IS NOT NULL LIMIT 1001`)
    .all<{ id: number; employer: string | null; title: string }>()).results;
  if (applications.length > 1000) return { kind: "review", reason: "ambiguous_application_identity", records: [] };
  const possible = applications.filter(row => row.employer && reviewEmployer(job.company, row.employer) && normalizeTitle(row.title) === title);
  if (possible.length) return { kind: "review", reason: "possible_prior_application", records: possible.map(row => `known_applications:${row.id}`) };

  const receipts = (await db.prepare(`SELECT gmail_message_id,employer,title,requisition_id FROM lifecycle_receipts
    WHERE test=0 AND event='application_confirmation' AND decision='question' AND title IS NOT NULL LIMIT 1001`)
    .all<{ gmail_message_id: string; employer: string | null; title: string; requisition_id: string | null }>()).results;
  if (receipts.length > 1000) return { kind: "review", reason: "ambiguous_application_identity", records: [] };
  const pending = receipts.filter(row => row.employer && reviewEmployer(job.company, row.employer) &&
    normalizeTitle(row.title) === title && (!row.requisition_id?.trim() ||
      row.requisition_id.trim().toLowerCase() === ref?.postingId.toLowerCase()));
  return pending.length ? { kind: "review", reason: "pending_confirmation", records: pending.map(row => `lifecycle_receipts:${row.gmail_message_id}`) }
    : { kind: "clear" };
}

export type ApplicationIdentityHold = { job: NormalizedJob; reason: Extract<DiscoveryApplicationState, { kind: "review" }>["reason"] };
export type DiscoveryHoldPlan = { screening: NormalizedJob[]; identityReview: ApplicationIdentityHold[]; suppressedJobIds: string[] };

// Call within the memoized message-plan callback, not while reconstructing
// unsent chunks. Failed-attempt stage receipts remain immutable.
export async function reconcileDiscoveryHolds(db: D1Database, lease: DiscoveryLease,
  jobs: readonly NormalizedJob[], sources: readonly Source[], notifications: readonly NormalizedJob[] = []): Promise<DiscoveryHoldPlan> {
  const screeningIds = new Set(jobs.map(job => job.id));
  const plan: DiscoveryHoldPlan = { screening: [], identityReview: [], suppressedJobIds: [] };
  for (const job of new Map([...jobs, ...notifications].map(job => [job.id, job])).values()) {
    const state = await readDiscoveryApplicationState(db, job, sources);
    if (state.kind === "clear") {
      if (screeningIds.has(job.id)) plan.screening.push(job);
    }
    else if (state.kind === "review") plan.identityReview.push({ job, reason: state.reason });
    else plan.suppressedJobIds.push(job.id);
  }
  // A title-only review is not enough evidence to discard its retry work.
  if (plan.suppressedJobIds.length) await clearFailures(db, lease, plan.suppressedJobIds);
  return plan;
}

export function actionableHoldErrors(errors: readonly string[], plan: DiscoveryHoldPlan): string[] {
  const nonScreening = [...plan.suppressedJobIds, ...plan.identityReview.map(hold => hold.job.id)];
  return errors.filter(error => !nonScreening.some(id => error.startsWith(`${id}:`)));
}
