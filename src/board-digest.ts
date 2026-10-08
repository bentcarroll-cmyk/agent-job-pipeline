// The summary line the fixed-board Worker posts before match messages. Kept
// out of src/index.ts because that module imports cloudflare:workers, which
// the node test environment cannot load.

export type BoardDigest = {
  // Messages going out now: this run's matches plus any earlier run's
  // undelivered backlog.
  delivering: number;
  matchedThisRun: number;
  deliveringReviews?: number;
  needsReviewThisRun?: number;
  // Postings that reached a real verdict this run.
  checked: number;
  alreadyApplied: number;
  fetchErrors: string[];
  // Postings the model failed on. They receive a separate retry cooldown.
  filterFailures: number;
  totalBoards: number;
  cap: number;
};

export function boardDigestMessage(d: BoardDigest): string {
  // A board that fails to fetch is lost coverage for as long as it stays
  // broken, so it is worth a message even on a run with nothing to deliver.
  if (d.delivering === 0) {
    const lines = [
      d.fetchErrors.length
        ? `:warning: Company boards: ${d.fetchErrors.length} of ${d.totalBoards} board(s) failed to fetch this run: ${d.fetchErrors.join("; ")}`
        : ":mag: Company boards: no matches delivered this run.",
    ];
    if (d.filterFailures > 0) lines.push(filterFailureLine(d.filterFailures));
    return lines.join("\n");
  }

  // `delivering` includes carried-over matches, so it must not be described
  // as "new", or a drained backlog would read as a sudden surge of fresh finds.
  const carried = d.delivering - d.matchedThisRun - (d.needsReviewThisRun ?? 0);
  const lines = [
    (d.deliveringReviews === undefined
      ? `:mag: Company boards: ${d.delivering} match(es) to review`
      : `:mag: Company boards: ${d.delivering - d.deliveringReviews} possible match(es); ${d.deliveringReviews} need(s) evidence review`) +
      (carried > 0 ? ` (${d.matchedThisRun + (d.needsReviewThisRun ?? 0)} new, ${carried} carried over from an earlier run).` : "."),
    `${d.checked} new posting(s) checked this run.` + (d.needsReviewThisRun === undefined ? "" : ` ${d.matchedThisRun} possible match(es), ${d.needsReviewThisRun} need(s) evidence review.`),
  ];
  if (d.alreadyApplied > 0) {
    lines.push(`(${d.alreadyApplied} skipped — already tracked as an existing application.)`);
  }
  if (d.delivering >= d.cap) {
    lines.push(`Capped at ${d.cap} per run — any remainder follows next run.`);
  }
  if (d.fetchErrors.length > 0) lines.push(`Board fetch errors: ${d.fetchErrors.join("; ")}`);
  if (d.filterFailures > 0) lines.push(filterFailureLine(d.filterFailures));
  return lines.join("\n");
}

function filterFailureLine(n: number): string {
  return `${n} posting(s) couldn't be judged — they can be retried after a cooldown.`;
}
