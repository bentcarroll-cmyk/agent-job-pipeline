import type { ImportPlan } from "./types";

// LedgerRow field → known_applications column, in the order SET clauses
// are written.
const KNOWN_COLUMNS: Array<[keyof ImportPlan["projected"][number], string]> = [
  ["title", "title"],
  ["status", "status"],
  ["statusUpdatedAt", "status_updated_at"],
  ["statusSource", "status_source"],
  ["postingUrl", "posting_url"],
  ["requisitionId", "requisition_id"],
  ["appliedAt", "applied_at"],
  ["canonicalId", "canonical_id"],
  ["sourceJobId", "source_job_id"],
];

// jobs.application_status_source has its own vocabulary.
export const JOBS_STATUS_SOURCE: Record<string, string> = { lifecycle_email: "lifecycle_email", ledger_import: "import" };

export function sqlValue(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

// Every statement a plan implies, whether or not it still has open questions.
// The lifecycle tracker runs these per email; the import goes through
// planToSql, which refuses while anything is unanswered.
export function planStatements(plan: Omit<ImportPlan, "generatedAt" | "questions" | "matches">): string[] {
  const out: string[] = [];
  for (const r of plan.inserts) {
    const values = [
      r.canonicalId,
      r.employer,
      r.title,
      r.status,
      r.source,
      r.sourceJobId,
      r.statusUpdatedAt,
      r.statusSource ?? "ledger_import",
      r.postingUrl,
      r.requisitionId,
      r.appliedAt,
    ];
    out.push(
      `INSERT INTO known_applications (canonical_id, employer, title, status, source, source_job_id, status_updated_at, status_source, posting_url, requisition_id, applied_at) VALUES (${values.map(sqlValue).join(", ")});`,
    );
  }
  for (const u of plan.updates) {
    const statusChanged = u.before.status !== u.after.status;
    const jobsSource = sqlValue(JOBS_STATUS_SOURCE[u.after.statusSource ?? ""] ?? "import");
    const jobsSet = `application_status = ${sqlValue(u.after.status)}, application_status_source = ${jobsSource}, application_status_updated_at = ${sqlValue(u.after.statusUpdatedAt)}`;
    if (u.ownerTable === "jobs") {
      if (statusChanged) out.push(`UPDATE jobs SET ${jobsSet} WHERE id = ${sqlValue(u.ownerId)};`);
      continue;
    }
    const sets = KNOWN_COLUMNS.filter(([f]) => u.before[f] !== u.after[f]).map(
      ([f, col]) => `${col} = ${sqlValue(u.after[f] as string | null)}`,
    );
    if (sets.length) out.push(`UPDATE known_applications SET ${sets.join(", ")} WHERE id = ${Number(u.ownerId)};`);
    // A jobs row mirroring this application must not disagree with it.
    if (statusChanged && u.after.sourceJobId) {
      out.push(`UPDATE jobs SET ${jobsSet} WHERE known_application_source = ${sqlValue(u.after.sourceJobId)};`);
    }
  }
  for (const l of plan.links) {
    const keeper = plan.projected.find((r) => r.ownerId === l.mergedInto);
    if (!keeper) throw new Error(`link ${l.jobId}: ${l.mergedInto} is not in the projection`);
    out.push(
      `UPDATE jobs SET is_known_application = 1, known_application_source = ${sqlValue(l.sourceJobId)}, application_status = ${sqlValue(keeper.status)}, application_status_source = 'import', application_status_updated_at = ${sqlValue(keeper.statusUpdatedAt)} WHERE id = ${sqlValue(l.jobId)};`,
    );
  }
  for (const d of plan.deletes) out.push(`DELETE FROM known_applications WHERE id = ${Number(d.ownerId)};`);
  return out;
}

export function planToSql(plan: ImportPlan): string {
  if (plan.questions.length) {
    throw new Error(`${plan.questions.length} open question(s): answer them in data/ledger/decisions.json and rebuild`);
  }
  const out = planStatements(plan);
  return out.length ? `${out.join("\n")}\n` : "";
}
