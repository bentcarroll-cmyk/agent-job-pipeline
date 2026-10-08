// Reconciles every source's candidates, then every email, against what D1
// already holds, producing the changes to make and the questions to ask.
// Pure: the same inputs and answers always produce the same plan.
import { canonicalizeAtsUrl } from "../../sources";
import { findMatches, sameEmployer, conflictingIdentity } from "../match";
import { identityKey, normalizeEmployer, normalizeTitle } from "../normalize";
import { decideTransition, EVENT_STATUS, statusRank } from "../transitions";
import type { LedgerRow } from "../types";
import type { Candidate, DeletedRow, ImportPlan, LinkedRow, NewRow, OutcomeEvidence, Question, RowChange } from "./types";

const day = (s: string | null) => (s ? s.slice(0, 10) : null);

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return day(a)! <= day(b)! ? a : b;
}

const CHANGE_FIELDS = [
  "title",
  "status",
  "statusUpdatedAt",
  "statusSource",
  "postingUrl",
  "requisitionId",
  "appliedAt",
  "canonicalId",
  "sourceJobId",
] as const;

const label = (r: { employer: string; title: string | null }) => `${r.employer} — ${r.title ?? "(no title)"}`;
const optionLabels = (rows: LedgerRow[]) => Object.fromEntries(rows.map((r) => [r.ownerId, `${label(r)} · ${r.status}`]));

// When an application went in: its recorded date, or failing that the time
// its status became applied (how rows the pipeline owns record it).
export const appliedDay = (r: LedgerRow) => day(r.appliedAt ?? (r.status === "applied" ? r.statusUpdatedAt : null));
export const withinDays = (a: string | null, b: string, days: number) =>
  !!a && Math.abs(Date.parse(a) - Date.parse(b.slice(0, 10))) <= days * 86_400_000;

export function buildPlan(input: {
  existing: LedgerRow[];
  candidates: Candidate[];
  evidence: OutcomeEvidence[];
  questions: Question[];
  answers: Record<string, string>;
  generatedAt: string;
  // Duplicate row id → the row it duplicates (decisions.json → merge_rows).
  merges?: Record<string, string>;
  // Row id → a status the candidate set by hand (decisions.json → status_overrides).
  overrides?: Record<string, { status: string; at: string; reason: string }>;
}): ImportPlan {
  const rows: LedgerRow[] = input.existing.map((r) => ({ ...r }));
  const before = new Map(input.existing.map((r) => [r.ownerId, r]));
  const evidenceById = new Map<string, string[]>();
  const questions: Question[] = [...input.questions];
  const matches: ImportPlan["matches"] = [];
  const merges = input.merges ?? {};
  const redirect = (id: string) => merges[id] ?? id;

  // Duplicates leave the ledger before anything is matched, so evidence and
  // answers can only land on the row they duplicate.
  const deletes: DeletedRow[] = [];
  const links: LinkedRow[] = [];
  for (const [dupId, keepId] of Object.entries(merges)) {
    const dup = rows.find((r) => r.ownerId === dupId);
    const keep = rows.find((r) => r.ownerId === keepId);
    if (!dup || !keep) throw new Error(`merge_rows ${dupId} → ${keepId}: row not found`);
    rows.splice(rows.indexOf(dup), 1);
    const merged = { employer: dup.employer, title: dup.title, mergedInto: keepId };
    if (dup.ownerTable === "jobs") {
      if (!keep.sourceJobId) throw new Error(`merge_rows ${dupId} → ${keepId}: a posting can only merge into an application with a source_job_id`);
      links.push({ jobId: dupId, ...merged, sourceJobId: keep.sourceJobId });
    } else {
      deletes.push({ ownerId: dupId, ...merged });
    }
  }

  const note = (row: LedgerRow, text: string) => {
    evidenceById.set(row.ownerId, [...(evidenceById.get(row.ownerId) ?? []), text]);
  };

  // New rows are named by what they are, not by insertion order, so an
  // answer that adds a row can't renumber the rows other answers point at.
  const insert = (fields: Omit<LedgerRow, "ownerTable" | "ownerId">, evidence: string, key: string): LedgerRow => {
    let ownerId = `new:${key}`;
    for (let n = 2; rows.some((r) => r.ownerId === ownerId); n++) ownerId = `new:${key}#${n}`;
    const row: LedgerRow = { ...fields, ownerTable: "new", ownerId };
    rows.push(row);
    note(row, evidence);
    return row;
  };

  // Returns the recorded answer, or raises the question and returns undefined.
  // An answer naming a merged duplicate means the row it was merged into.
  const ask = (q: Question): string | undefined => {
    const answer = input.answers[q.id];
    if (answer === undefined) questions.push(q);
    return answer === undefined ? undefined : redirect(answer);
  };

  const setStatus = (row: LedgerRow, status: string, at: string | null, source: string) => {
    row.status = status;
    row.statusUpdatedAt = at;
    row.statusSource = source;
  };

  // ------------------------------------------------------------ candidates

  const resolveTarget = (c: Candidate): LedgerRow | null | "skip" => {
    if (c.mergeInto) {
      const aiapplyEmployer = c.mergeInto.startsWith("aiapply:") ? c.mergeInto.slice("aiapply:".length) : null;
      const hit = aiapplyEmployer
        ? rows.find((r) => r.source === "aiapply" && sameEmployer(r.employer, aiapplyEmployer))
        : rows.find((r) => r.sourceJobId === c.mergeInto);
      if (hit && !conflictingIdentity(c, hit)) return hit;
    }
    if (c.sourceJobId) {
      const hit = rows.find((r) => r.sourceJobId === c.sourceJobId);
      if (hit && !conflictingIdentity(c, hit)) return hit;
    }
    const { exact, sameEmployer: atEmployer } = findMatches({ employer: c.employer, title: c.title, requisitionId: c.requisitionId, postingUrl: c.postingUrl }, rows);
    // Without a title, only a row from the same source at the same employer
    // can be assumed to be this application.
    const pool = c.title ? exact : atEmployer.filter((r) => !conflictingIdentity(c, r) && r.source === c.source);
    if (pool.length === 1) return pool[0];
    // A titled record for an employer the same source recorded without a
    // title ("Synthetic Labs") is that same application, now with its title.
    const untitled = atEmployer.filter((r) => !conflictingIdentity(c, r) && r.source === c.source && !r.title);
    if (c.title && !exact.length && untitled.length === 1) return untitled[0];
    if (pool.length === 0 && !atEmployer.some(r => conflictingIdentity(c, r)) && (c.title || atEmployer.length === 0)) return null;
    const offered = pool.length ? pool : atEmployer;
    const answer = ask({
      id: `candidate:${c.source}:${c.sourceJobId ?? `${c.employer}|${c.title ?? ""}`}`,
      kind: "ambiguous_match",
      text: `${label(c)} (${c.source}) could be any of: ${offered.map((r) => `${r.ownerId} = ${label(r)} [${r.status}]`).join("; ")}`,
      evidence: c.evidence,
      options: [...offered.map((r) => r.ownerId), "new", "skip"],
      optionLabels: optionLabels(offered),
    });
    if (answer === undefined || answer === "skip") return "skip";
    if (answer === "new") return null;
    return rows.find((r) => r.ownerId === answer) ?? "skip";
  };

  const mergeCandidate = (row: LedgerRow, c: Candidate) => {
    if (c.status !== row.status) {
      const backward = statusRank(c.status) < statusRank(row.status);
      const rowNewer = !!row.statusUpdatedAt && !!c.statusAt && day(row.statusUpdatedAt)! > day(c.statusAt)!;
      if (!backward) {
        if (!rowNewer) setStatus(row, c.status, c.statusAt, "ledger_import");
      } else if (!(row.statusUpdatedAt && (!c.statusAt || day(row.statusUpdatedAt)! >= day(c.statusAt)!))) {
        // Backwards with nothing dating the ledger's status as newer: only
        // the candidate can say which is right.
        const answer = ask({
          id: `backward:${row.ownerId}:${c.source}:${c.status}`,
          kind: "backward_move",
          text: `${label(row)}: ${c.source} says ${c.status}, the ledger says ${row.status}`,
          evidence: c.evidence,
          options: ["keep", "apply"],
        });
        if (answer === "apply") setStatus(row, c.status, c.statusAt, "ledger_import");
      }
    } else if (!row.statusUpdatedAt && c.statusAt) {
      row.statusUpdatedAt = c.statusAt;
    }
    if (row.ownerTable !== "jobs") {
      row.title ??= c.title;
      row.postingUrl ??= c.postingUrl;
      row.requisitionId ??= c.requisitionId;
      row.canonicalId ??= c.postingUrl ? canonicalizeAtsUrl(c.postingUrl) : null;
      row.sourceJobId ??= c.sourceJobId;
      row.appliedAt = earliest(row.appliedAt, c.appliedAt);
    }
    note(row, c.evidence);
  };

  for (const c of input.candidates) {
    const target = resolveTarget(c);
    if (target === "skip") continue;
    if (target) {
      mergeCandidate(target, c);
      continue;
    }
    insert(
      {
        employer: c.employer,
        title: c.title,
        status: c.status,
        statusUpdatedAt: c.statusAt,
        source: c.source,
        sourceJobId: c.sourceJobId,
        canonicalId: c.postingUrl ? canonicalizeAtsUrl(c.postingUrl) : null,
        postingUrl: c.postingUrl,
        requisitionId: c.requisitionId,
        appliedAt: c.appliedAt,
        statusSource: "ledger_import",
      },
      c.evidence,
      `${c.source}:${c.sourceJobId ?? identityKey(c.employer, c.title) ?? normalizeEmployer(c.employer)}`,
    );
  }

  // -------------------------------------------------------------- evidence

  const insertFromEvidence = (e: OutcomeEvidence) =>
    insert(
      {
        employer: e.employer,
        title: e.title,
        status: EVENT_STATUS[e.event],
        statusUpdatedAt: e.date,
        source: e.source ?? "lifecycle_email",
        sourceJobId: null,
        canonicalId: null,
        postingUrl: null,
        requisitionId: e.requisitionId,
        appliedAt: e.event === "application_confirmation" ? e.date : null,
        statusSource: "lifecycle_email",
      },
      e.evidence,
      `email:${e.date}:${identityKey(e.employer, e.title) ?? normalizeEmployer(e.employer)}`,
    );

  // Oldest first, so a rejection lands after the confirmation it follows.
  const ordered = [...input.evidence].sort((a, b) => a.date.localeCompare(b.date) || a.employer.localeCompare(b.employer));
  for (const e of ordered) {
    const id = `evidence:${e.date}|${e.event}|${e.employer}|${e.title ?? ""}`;
    const { exact, near, sameEmployer: atEmployer } = findMatches(
      { employer: e.employer, title: e.title, requisitionId: e.requisitionId, sender: e.sender },
      rows,
    );
    // For an employer-level confirmation, the employer's applications that
    // went in within a couple of days of it.
    const recent = !e.title && e.event === "application_confirmation" ? atEmployer.filter((r) => !conflictingIdentity(e, r) && withinDays(appliedDay(r), e.date, 2)) : [];
    // For a titled confirmation at an employer with nothing on record, the
    // applications with its exact title from those days under another name
    // (a separately named recruiting brand confirming a posting): offered, never
    // assumed.
    const title = e.title ? normalizeTitle(e.title) : "";
    const renamed =
      e.event === "application_confirmation" && title && !atEmployer.length
        ? rows.filter((r) => r.title && normalizeTitle(r.title) === title && withinDays(appliedDay(r), e.date, 2))
        : [];
    let target: LedgerRow | undefined;
    if (exact.length === 1) {
      target = exact[0];
    } else if (near.length === 1) {
      // No title matches exactly, and one is the same title worded a little
      // differently: it breaks the tie between the employer's rows.
      target = near[0];
    } else if (!e.title && !exact.length && atEmployer.length === 1 && !conflictingIdentity(e, atEmployer[0]) && !atEmployer[0].title) {
      // An employer-level email and the employer's only row, untitled too.
      target = atEmployer[0];
    } else if (!exact.length && recent.length === 1) {
      // An employer-level confirmation and the one application at that
      // employer from the same days, whatever else it has on record.
      target = recent[0];
    } else if (exact.length === 0 && e.event === "application_confirmation" && e.title && atEmployer.length === 0 && !renamed.length) {
      // The auto-add rule: a clearly named application at an employer with
      // nothing on record.
      matches.push({ evidenceId: id, ownerId: insertFromEvidence(e).ownerId, outcome: "inserted" });
      continue;
    } else {
      const pool = exact.length ? exact : atEmployer.length ? atEmployer : renamed;
      const answer = ask({
        id,
        kind: exact.length ? "ambiguous_match" : "unmatched_evidence",
        text: `${e.event} for ${label(e)}${pool.length ? ` could be: ${pool.map((r) => `${r.ownerId} = ${label(r)} [${r.status}]`).join("; ")}` : " matches nothing on record"}`,
        evidence: e.evidence,
        options: [...pool.map((r) => r.ownerId), ...(e.title || e.event === "application_confirmation" ? ["new"] : []), "skip"],
        optionLabels: optionLabels(pool),
      });
      if (answer === undefined || answer === "skip") continue;
      if (answer === "new") {
        matches.push({ evidenceId: id, ownerId: insertFromEvidence(e).ownerId, outcome: "inserted" });
        continue;
      }
      target = rows.find((r) => r.ownerId === answer);
      if (!target) continue;
    }

    const decision = decideTransition(target.status, e.event, target.statusUpdatedAt, e.date);
    let outcome: "applied" | "unchanged" = "unchanged";
    if (decision.action === "apply") {
      setStatus(target, decision.to, e.date, "lifecycle_email");
      outcome = "applied";
    } else if (decision.action === "review") {
      const answer = ask({
        id: `${id}:review`,
        kind: "transition_review",
        text: `${label(target)}: this ${e.event} would move ${target.status} → ${decision.to} (${decision.reason})`,
        evidence: e.evidence,
        options: ["apply", "skip"],
      });
      if (answer !== "apply") continue;
      setStatus(target, decision.to, e.date, "lifecycle_email");
      outcome = "applied";
    }
    if (e.event === "application_confirmation" && target.ownerTable !== "jobs") {
      target.appliedAt = earliest(target.appliedAt, e.date);
    }
    matches.push({ evidenceId: id, ownerId: target.ownerId, outcome });
    note(target, e.evidence);
  }

  // ------------------------------------------------------------- overrides

  for (const [id, o] of Object.entries(input.overrides ?? {})) {
    const row = rows.find((r) => r.ownerId === redirect(id));
    if (!row) throw new Error(`status_overrides ${id}: row not found`);
    setStatus(row, o.status, o.at, "ledger_import");
    note(row, `Your decision: ${o.reason}`);
  }

  // ---------------------------------------------------------------- output

  const inserts: NewRow[] = rows
    .filter((r) => r.ownerTable === "new")
    .map((r) => ({ ...r, evidence: evidenceById.get(r.ownerId) ?? [] }));
  const updates: RowChange[] = [];
  for (const r of rows) {
    if (r.ownerTable === "new") continue;
    const b = before.get(r.ownerId)!;
    if (!CHANGE_FIELDS.some((f) => b[f] !== r[f])) continue;
    updates.push({
      ownerTable: r.ownerTable,
      ownerId: r.ownerId,
      employer: r.employer,
      title: r.title,
      sourceJobId: r.sourceJobId,
      before: b,
      after: { ...r },
      evidence: evidenceById.get(r.ownerId) ?? [],
    });
  }
  const unique = [...new Map(questions.map((q) => [q.id, q])).values()];
  return { generatedAt: input.generatedAt, inserts, updates, deletes, links, matches, questions: unique, projected: rows };
}
