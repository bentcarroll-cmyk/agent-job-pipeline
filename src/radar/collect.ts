// Runs a query plan against the provider breadth-first, and fetches thread
// and reply context for the top candidates. No D1 here: callers save pages.
import type { Meter } from "./budget";
import type { QueryPlanEntry } from "./sources";
import { XApiError, type Page, type XClient, type XPost } from "./x-client";

export type CollectResult = {
  okRequests: number;
  posts: number;
  requests: number;
  spent: number;
  cutShort: string[];
  thinned: number;
  errors: string[];
};

export type Expansion = { postId: string; thread: XPost[]; replies: XPost[] };

const defaultPause = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));

// Page one of every search, then page two of those with more, and so on, so
// a tight budget thins every search instead of dropping one. Each page is
// saved as it arrives; a failed save fails the step so the Workflow retries.
export async function collect(
  plan: QueryPlanEntry[],
  client: XClient,
  meter: Meter,
  save: (entry: QueryPlanEntry, posts: XPost[]) => Promise<void>,
  pause: () => Promise<void> = defaultPause,
): Promise<CollectResult> {
  const cursor = new Map(plan.map((e) => [e.id, ""]));
  const pages = new Map(plan.map((e) => [e.id, 0]));
  const cutShort: string[] = [];
  let thinned = 0;
  const errors: string[] = [];
  let okRequests = 0;
  const rounds = Math.max(0, ...plan.map((e) => e.maxPages));
  for (let round = 0; round < rounds; round++) {
    for (const entry of plan) {
      if (!cursor.has(entry.id) || pages.get(entry.id)! >= entry.maxPages) continue;
      if (!meter.canAfford()) {
        // A constrained budget can thin searches after successful pages.
        // cutShort identifies only a search that fetched nothing at all;
        // partial budget coverage is recorded without a failure warning.
        if (pages.get(entry.id) === 0) cutShort.push(entry.id);
        else thinned++;
        cursor.delete(entry.id);
        continue;
      }
      let page: Page;
      try {
        page = await withRetry(() => client.searchPosts(entry.query, entry.queryType, cursor.get(entry.id)), pause);
      } catch (e) {
        errors.push(`${entry.id}: ${(e as Error).message}`);
        cursor.delete(entry.id);
        continue;
      }
      meter.record(page.rawCount);
      okRequests++;
      pages.set(entry.id, pages.get(entry.id)! + 1);
      // Dropped here even when the query's operators already excluded them:
      // an operator the provider ignores must not let them through.
      const originals = page.posts.filter((p) => !p.isReply && !p.isRepost);
      if (originals.length) await save(entry, originals);
      if (page.nextCursor) cursor.set(entry.id, page.nextCursor);
      else cursor.delete(entry.id);
    }
  }
  return { okRequests, posts: meter.posts, requests: meter.requests, spent: meter.spent, cutShort, thinned, errors };
}

// The author's own thread and the most-liked replies for each target, until
// the expansion reserve runs out.
export async function expand(
  targets: Array<{ id: string; authorHandle: string }>,
  client: XClient,
  meter: Meter,
  pause: () => Promise<void> = defaultPause,
): Promise<{ expansions: Expansion[]; errors: string[] }> {
  const expansions: Expansion[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    if (!meter.canAfford()) break;
    const expansion: Expansion = { postId: target.id, thread: [], replies: [] };
    try {
      const thread = await withRetry(() => client.getThreadContext(target.id), pause);
      meter.record(thread.rawCount);
      const author = target.authorHandle.toLowerCase();
      expansion.thread = thread.posts.filter((p) => p.id !== target.id && p.authorHandle.toLowerCase() === author);
    } catch (e) {
      errors.push(`thread ${target.id}: ${(e as Error).message}`);
    }
    if (meter.canAfford()) {
      try {
        const replies = await withRetry(() => client.getTopReplies(target.id), pause);
        meter.record(replies.rawCount);
        expansion.replies = replies.posts.filter((p) => p.id !== target.id).slice(0, 20);
      } catch (e) {
        errors.push(`replies ${target.id}: ${(e as Error).message}`);
      }
    }
    expansions.push(expansion);
  }
  return { expansions, errors };
}

// One retry for rate limits, provider errors and dropped connections; a
// rejected key or a bad query won't improve on a second try.
async function withRetry(fetchPage: () => Promise<Page>, pause: () => Promise<void>): Promise<Page> {
  try {
    return await fetchPage();
  } catch (e) {
    const retryable = !(e instanceof XApiError) || e.status === 429 || e.status >= 500;
    if (!retryable) throw e;
    await pause();
    return fetchPage();
  }
}
