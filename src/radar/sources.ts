// Turns the topics and hiring searches into one run's query plan.
import {
  HIRING_MAX_PAGES,
  OPERATORS,
  TOPIC_MAX_PAGES,
  TOPIC_MIN_FAVES,
  TOPICS,
  type Operators,
  type TopicId,
  type Topic,
} from "./topics";

export type QueryPlanEntry = {
  // "hiring:0", "enterprise_adoption:1": recorded in found_by, and named in
  // the footer when the budget cuts a search short.
  id: string;
  source: TopicId | "hiring";
  query: string;
  queryType: "Latest" | "Top";
  maxPages: number;
};

const HOUR = 3_600_000;

// A minFaves of 0 means no likes floor, which is the topic default (see
// TOPIC_MIN_FAVES). Hiring searches never get one.
export function decorate(
  query: string,
  kind: "hiring" | "topic",
  sinceUnix: number,
  operators: Operators = OPERATORS,
  minFaves = TOPIC_MIN_FAVES,
): string {
  const parts = [query];
  if (operators.lang) parts.push("lang:en");
  if (operators.noReplies) parts.push("-filter:replies");
  if (operators.noReposts) parts.push("-filter:retweets");
  parts.push(`since_time:${sinceUnix}`);
  if (kind === "topic" && operators.minFaves && minFaves > 0) parts.push(`min_faves:${minFaves}`);
  return parts.join(" ");
}

// Hiring first: collection goes breadth-first in plan order, so on a tight
// day topics thin out before hiring does.
export function buildQueryPlan(sinceUnix: number, operators: Operators = OPERATORS, selection: { topics: readonly Topic[]; hiringQueries: readonly string[] } = { topics: TOPICS, hiringQueries: [] }): QueryPlanEntry[] {
  const hiring = selection.hiringQueries.map((q, i): QueryPlanEntry => ({
    id: `hiring:${i}`,
    source: "hiring",
    query: decorate(q, "hiring", sinceUnix, operators),
    queryType: "Latest",
    maxPages: HIRING_MAX_PAGES,
  }));
  const topics = selection.topics.flatMap((t) =>
    t.queries.map((q, i): QueryPlanEntry => ({
      id: `${t.id}:${i}`,
      source: t.id,
      query: decorate(q, "topic", sinceUnix, operators),
      queryType: "Top",
      maxPages: TOPIC_MAX_PAGES,
    })),
  );
  return [...hiring, ...topics];
}

// Where this run's window starts: the last successful collection, never
// more than 72 hours back; 24 hours on the very first run.
export function sinceTime(lastCollectStartedAt: string | null, now: Date): number {
  const from = lastCollectStartedAt
    ? Math.max(Date.parse(lastCollectStartedAt), now.getTime() - 72 * HOUR)
    : now.getTime() - 24 * HOUR;
  return Math.floor(from / 1000);
}
