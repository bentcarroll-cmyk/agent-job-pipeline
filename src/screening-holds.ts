import type { NormalizedJob } from "./sources";

export function screeningHoldMessage(jobs: readonly NormalizedJob[]): string {
  if (!jobs.length) return "";
  const lines = [`:warning: ${jobs.length} posting(s) have screening on hold; no verdict was saved. They remain eligible for retry after cooldown.`];
  for (const job of jobs) {
    const title = job.title.replace(/[\r\n<>|]/g, " ").slice(0, 70);
    lines.push(`• ${title} (${job.id}): ${job.url}`);
  }
  return lines.join("\n");
}

export function applicationIdentityHoldMessage(holds: readonly { job: NormalizedJob; reason: string }[]): string {
  if (!holds.length) return "";
  const lines = [`:warning: ${holds.length} posting(s) need application identity review; automatic screening is paused.`];
  for (const { job, reason } of holds) {
    const title = job.title.replace(/[\r\n<>|]/g, " ").slice(0, 70);
    const explanation = reason === "pending_confirmation" ? "application confirmation awaits review" :
      reason === "possible_prior_application" ? "possible prior application; posting identity is unverified" : "conflicting application identities";
    lines.push(`• ${title} (${job.id}): ${job.url} (${explanation})`);
  }
  return lines.join("\n");
}
