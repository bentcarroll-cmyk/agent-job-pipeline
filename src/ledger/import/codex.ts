import type { LedgerStatus } from "../types";
import type { Candidate } from "./types";

// Fields from selected pipeline job records.
export type CodexJob = {
  job_id: string;
  employer: string;
  title: string;
  status: string;
  posting_url?: string | null;
  requisition_id?: string | null;
};

// One selected lifecycle event record.
export type CodexEvent = { event_type: string; status: string | null; occurred_at: string };

// When the current status began: the first event of the final unbroken run
// carrying it. Re-verification events repeat a status without changing it,
// so the last event alone would date it too late.
export function statusSince(events: CodexEvent[], status: string): string | null {
  let i = events.length - 1;
  while (i >= 0 && events[i].status === status) i--;
  return events[i + 1]?.occurred_at ?? null;
}

export function codexCandidates(jobs: Array<{ job: CodexJob; events: CodexEvent[] }>): Candidate[] {
  return jobs.map(({ job, events }) => {
    const since = statusSince(events, job.status);
    return {
      source: "codex_pipeline",
      sourceJobId: job.job_id,
      employer: job.employer,
      title: job.title,
      status: job.status as LedgerStatus,
      statusAt: since,
      appliedAt: events.find((e) => e.status === "applied")?.occurred_at ?? null,
      postingUrl: job.posting_url ?? null,
      requisitionId: job.requisition_id ?? null,
      mergeInto: null,
      evidence: `Codex ${job.job_id}: ${job.status} since ${since ? since.slice(0, 10) : "unknown"}`,
    };
  });
}
