// A local, self-contained page for the candidate to review before anything is written.
// It shows evidence one-liners only, never email bodies.
import type { ImportPlan, NewRow } from "./types";

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (s: string | null) => (s ? s.slice(0, 10) : "—");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderReview(plan: ImportPlan): string {
  const statusChanges = plan.updates.filter((u) => u.before.status !== u.after.status);
  const backfills = plan.updates.length - statusChanges.length;
  const bySource = new Map<string, NewRow[]>();
  for (const r of plan.inserts) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  const questions = plan.questions.length
    ? `<h2>Questions</h2>
<table><thead><tr><th>Id</th><th>Question</th><th>Evidence</th><th>Answers</th></tr></thead><tbody>
${plan.questions.map((q) => `<tr><td><code>${esc(q.id)}</code></td><td>${esc(q.text)}</td><td>${esc(q.evidence)}</td><td>${q.options.map((o) => `<code>${esc(o)}</code>`).join(" ")}</td></tr>`).join("\n")}
</tbody></table>`
    : "";

  const changes = statusChanges.length
    ? `<h2>Status changes</h2>
<table><thead><tr><th>Application</th><th>Change</th><th>Evidence</th></tr></thead><tbody>
${statusChanges.map((u) => `<tr><td>${esc(u.employer)} — ${esc(u.title ?? "(no title)")}</td><td>${esc(u.before.status)} → <strong>${esc(u.after.status)}</strong> <span class="muted">${day(u.after.statusUpdatedAt)}</span></td><td>${u.evidence.map(esc).join("<br>")}</td></tr>`).join("\n")}
</tbody></table>`
    : "";

  const merged = plan.deletes.length + plan.links.length
    ? `<h2>Duplicates merged</h2>
<table><thead><tr><th>Duplicate</th><th>Merged into</th><th>How</th></tr></thead><tbody>
${[
  ...plan.deletes.map((d) => `<tr><td>${esc(d.employer)} — ${esc(d.title ?? "(no title)")} <span class="muted">${esc(d.ownerId)}</span></td><td>${esc(d.mergedInto)}</td><td>row deleted</td></tr>`),
  ...plan.links.map((l) => `<tr><td>${esc(l.employer)} — ${esc(l.title ?? "(no title)")} <span class="muted">${esc(l.jobId)}</span></td><td>${esc(l.mergedInto)}</td><td>posting linked</td></tr>`),
].join("\n")}
</tbody></table>`
    : "";

  const inserts = [...bySource.entries()]
    .map(
      ([source, rows]) => `<h2>New rows: ${esc(source)} (${rows.length})</h2>
<table><thead><tr><th>Employer</th><th>Title</th><th>Status</th><th>Applied</th><th>Evidence</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.employer)}</td><td>${esc(r.title ?? "(no title)")}</td><td>${esc(r.status)}</td><td>${day(r.appliedAt)}</td><td>${r.evidence.map(esc).join("<br>")}</td></tr>`).join("\n")}
</tbody></table>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledger Import Review</title>
<style>
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6760; --line: #e3e0da; --accent: #b4532a; }
@media (prefers-color-scheme: dark) { :root { --bg: #171614; --fg: #ece9e3; --muted: #9c978e; --line: #2e2c28; --accent: #e08a5f; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px 16px; }
h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 32px; }
.summary { display: flex; gap: 24px; flex-wrap: wrap; color: var(--muted); }
.summary strong { color: var(--fg); font-size: 20px; display: block; }
.open { color: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.muted { color: var(--muted); }
.wrap { overflow-x: auto; }
</style></head><body>
<h1>Ledger import review</h1>
<p class="muted">Generated ${esc(plan.generatedAt)}. Nothing has been written to D1.</p>
<div class="summary">
<div><strong>${plural(plan.inserts.length, "new row")}</strong>added</div>
<div><strong>${plural(statusChanges.length, "status change")}</strong>to existing rows</div>
<div><strong>${plural(backfills, "backfill")}</strong>fields only</div>
<div><strong>${plural(plan.deletes.length + plan.links.length, "duplicate")} merged</strong>into one row each</div>
<div class="${plan.questions.length ? "open" : ""}"><strong>${plural(plan.questions.length, "open question")}</strong>must be answered first</div>
</div>
<div class="wrap">${questions}${changes}${merged}${inserts}</div>
</body></html>
`;
}
