import type { LedgerRow } from "../types";

const day = (s: string | null) => (s ? s.slice(0, 10) : null);
const label = (r: LedgerRow) => `${r.employer} — ${r.title ?? "(no title)"}`;
const KNOWN_FIELDS = ["title", "status", "postingUrl", "requisitionId", "appliedAt", "sourceJobId", "canonicalId"] as const;

// Compares the plan's projection with a fresh read of D1. New rows have no
// id until inserted, so they are matched by content instead.
export function verifyProjected(
  projected: LedgerRow[],
  actual: LedgerRow[],
  linked: Array<{ sourceJobId: string; status: string }>,
): string[] {
  const problems: string[] = [];
  if (projected.length !== actual.length) problems.push(`row count: expected ${projected.length}, found ${actual.length}`);

  const byId = new Map(actual.map((r) => [`${r.ownerTable}:${r.ownerId}`, r]));
  const claimed = new Set(projected.filter((p) => p.ownerTable !== "new").map((p) => `${p.ownerTable}:${p.ownerId}`));
  const unclaimed = actual.filter((r) => r.ownerTable === "known_applications" && !claimed.has(`known_applications:${r.ownerId}`));

  for (const p of projected) {
    let a: LedgerRow | undefined;
    if (p.ownerTable === "new") {
      const i = unclaimed.findIndex(
        (r) => r.source === p.source && r.sourceJobId === p.sourceJobId && r.employer === p.employer && r.title === p.title,
      );
      if (i >= 0) a = unclaimed.splice(i, 1)[0];
    } else {
      a = byId.get(`${p.ownerTable}:${p.ownerId}`);
    }
    if (!a) {
      problems.push(`missing: ${label(p)}`);
      continue;
    }
    const fields = p.ownerTable === "jobs" ? (["status"] as const) : KNOWN_FIELDS;
    for (const f of fields) {
      if (p[f] !== a[f]) problems.push(`${label(p)}: ${f} expected ${p[f]}, found ${a[f]}`);
    }
    if (day(p.statusUpdatedAt) !== day(a.statusUpdatedAt)) {
      problems.push(`${label(p)}: statusUpdatedAt expected ${day(p.statusUpdatedAt)}, found ${day(a.statusUpdatedAt)}`);
    }
  }

  for (const l of linked) {
    const owner = projected.find((p) => p.ownerTable !== "jobs" && p.sourceJobId === l.sourceJobId);
    if (owner && owner.status !== l.status) {
      problems.push(`jobs rows for ${l.sourceJobId}: expected ${owner.status}, found ${l.status}`);
    }
  }
  return problems;
}
