import type { LedgerRow } from "../types";

// `SELECT * FROM known_applications`. The three ledger columns are optional
// because the snapshot is taken before the migration adds them.
export type KnownRow = {
  id: number;
  canonical_id: string | null;
  employer: string | null;
  title: string | null;
  status: string | null;
  source: string | null;
  source_job_id: string | null;
  status_updated_at: string | null;
  status_source: string | null;
  posting_url?: string | null;
  requisition_id?: string | null;
  applied_at?: string | null;
};

export type JobRow = {
  id: string;
  company: string;
  title: string;
  url: string;
  application_status: string;
  application_status_updated_at: string | null;
  application_status_source: string | null;
  is_known_application: number;
  known_application_source: string | null;
};

// Mirrors the `applications` view, so a snapshot taken before the
// migration and a read-back taken after it compare like for like.
export function snapshotRows(known: KnownRow[], jobs: JobRow[]): LedgerRow[] {
  const ledger: LedgerRow[] = known.map((k) => ({
    ownerTable: "known_applications",
    ownerId: String(k.id),
    employer: k.employer ?? "",
    title: k.title,
    status: k.status ?? "new",
    statusUpdatedAt: k.status_updated_at,
    source: k.source ?? "",
    sourceJobId: k.source_job_id,
    canonicalId: k.canonical_id,
    postingUrl: k.posting_url ?? null,
    requisitionId: k.requisition_id ?? null,
    appliedAt: k.applied_at ?? null,
    statusSource: k.status_source,
  }));
  for (const j of jobs) {
    if (j.application_status === "not_applied" || j.is_known_application !== 0) continue;
    ledger.push({
      ownerTable: "jobs",
      ownerId: j.id,
      employer: j.company,
      title: j.title,
      status: j.application_status,
      statusUpdatedAt: j.application_status_updated_at,
      source: "pipeline",
      sourceJobId: null,
      canonicalId: null,
      postingUrl: j.url,
      requisitionId: null,
      appliedAt: null,
      statusSource: j.application_status_source,
    });
  }
  return ledger;
}
