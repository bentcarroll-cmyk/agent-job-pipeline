import { isCurrentCriteria } from "../config/run-context";
import type { RuntimeConfig } from "../config/types";
import type { Source } from "../sources";
import { getPendingNotifications } from "../db";
import { getPendingScreeningNotifications, type PendingScreeningNotification } from "../screening/store";
import type { DiscoverySteps } from "../operations/discovery-run";
import { jsonToStream, streamToJson } from "../step-stream";
import { readDiscoveryApplicationState } from "./application-state";

type NotificationPlan = {
  candidates: PendingScreeningNotification[];
  ready: PendingScreeningNotification[];
  held: PendingScreeningNotification[];
};

// Application-held rows remain unnotified. Page past them to fill the card
// allowance, retaining their links for the frozen review summary. Keyset
// paging tolerates earlier rows becoming ineligible between page reads.
export async function loadApplicationAwareNotifications(step: DiscoverySteps, db: D1Database,
  discoverySource: "fixed_board" | "unbounded_search", limit: number, evidenceMode: boolean, sources: readonly Source[], instanceId?: string, runtime?: RuntimeConfig): Promise<NotificationPlan> {
  const plan: NotificationPlan = { candidates: [], ready: [], held: [] };
  if (!Number.isInteger(limit) || limit < 1) return plan;
  let after: string | null = null;
  for (let pageNumber = 0; plan.ready.length < limit; pageNumber++) {
    const checkpoint = await step.do(pageNumber === 0 ? "load-pending-notifications" : `load-pending-notifications-page:${pageNumber}`, async () => {
      // Preserve the old first-page checkpoint shapes, including legacy arrays.
      if (evidenceMode) return jsonToStream(await getPendingScreeningNotifications(db, discoverySource, limit, after, instanceId));
      return getPendingNotifications(db, discoverySource, limit, after, instanceId);
    });
    const page: PendingScreeningNotification[] = checkpoint instanceof ReadableStream
      ? await streamToJson<PendingScreeningNotification[]>(checkpoint) : checkpoint;
    if (!page.length) break;
    const clear = new Set(await step.do(`classify-pending-applications:${pageNumber}`, async () => {
      const ids: string[] = [];
      for (const item of page) if ((await readDiscoveryApplicationState(db, item.job, sources)).kind === "clear") ids.push(item.job.id);
      return ids;
    }));
    for (const item of page) {
      if (runtime && !isCurrentCriteria(item.criteriaVersion, runtime)) continue;
      if (!clear.has(item.job.id)) { plan.held.push(item); plan.candidates.push(item); }
      else if (plan.ready.length < limit) { plan.ready.push(item); plan.candidates.push(item); }
    }
    if (page.length < limit) break;
    after = page.at(-1)!.job.id;
  }
  return plan;
}
