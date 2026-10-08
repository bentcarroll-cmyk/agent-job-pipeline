// First pass over every new post: GLM sorts each into development, debate,
// practice, hiring or noise with a 0-3 score, about 20 posts per call.
import { sampleModelDecision, type FilterEnv } from "../filter";
import type { Metrics, PostRow } from "./db";
import { cut, oneLine } from "./text";
import { TOPICS } from "./topics";
import type { XPost } from "./x-client";

export const TRIAGE_KINDS = ["development", "debate", "practice", "hiring", "noise"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];
export type TriageResult = { id: string; kind: TriageKind; topic: string; score: 0 | 1 | 2 | 3; reason: string };
export type TriageInput = {
  id: string;
  text: string;
  quotedText: string | null;
  authorHandle: string;
  authorName: string | null;
  authorBio: string | null;
  authorFollowers: number | null;
  authorCreatedAt: string | null;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  foundBy: string[];
};

export const TOPIC_IDS: string[] = [...TOPICS.map((t) => t.id), "hiring"];
const SCORES = [0, 1, 2, 3];

export function buildTriagePrompt(profile: string, topicIds: readonly string[]): string {
  return `You sort posts from X for one reader. ${profile}

Call record_triage once, with one entry per post, using each post's id.

kind — pick one:
- development: news or a real development in AI worth knowing: launches, results, evidence of adoption, policy moves.
- debate: an argued position or live disagreement worth reacting to in a LinkedIn post.
- practice: a concrete way to use today's frontier AI tools, at home or at work, that the reader could try: a workflow, setup, technique or newly usable capability, with enough detail to act on. Tool promos, course ads, listicles ("7 levels of…", "10 AI tools…") and hype that doesn't show how to do anything are noise.
- hiring: someone at an AI company, or at a company doing serious AI work, hiring for a role in one of the reader's approved lanes. When the post says where the role is based (a city, remote, or a region), name that location in the reason. Recruiter spam and job-board reposts are noise.
- noise: engagement bait, listicles ("10 AI tools..."), promotion, courses, giveaways, crypto, generic hype, and anything off the topics below.

topic — the best fit from this list, or "hiring" for hiring posts:
${TOPICS.filter(t => topicIds.includes(t.id)).map((t) => `- ${t.id}: ${t.description}`).join("\n")}

score — how much the reader would want to see it: 0 not at all, 1 marginal, 2 worth a look, 3 must see. Weigh substance and the author's credibility (bio, followers, account age) over raw engagement.

reason — one short line on why.`;
}

export const TRIAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "record_triage",
    description: "Record the triage result for every post in the batch",
    parameters: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: [...TRIAGE_KINDS] },
              topic: { type: "string", enum: TOPIC_IDS },
              score: { type: "integer", enum: SCORES },
              reason: { type: "string" },
            },
            required: ["id", "kind", "topic", "score", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
  },
};

export function renderBatch(posts: TriageInput[]): string {
  return posts
    .map((p) =>
      [
        `id: ${p.id}`,
        `author: @${p.authorHandle}${p.authorName ? ` (${p.authorName})` : ""}, ${p.authorFollowers ?? "unknown"} followers${p.authorCreatedAt ? `, joined ${p.authorCreatedAt.slice(0, 4)}` : ""}`,
        p.authorBio ? `bio: ${cut(oneLine(p.authorBio), 300)}` : null,
        `found by: ${p.foundBy.join(", ")}`,
        `engagement: ${p.likes} likes, ${p.reposts} reposts, ${p.replies} replies, ${p.quotes} quotes`,
        `text: ${cut(oneLine(p.text), 1000)}`,
        p.quotedText ? `quoting: ${cut(oneLine(p.quotedText), 500)}` : null,
      ].filter((line): line is string => line !== null).join("\n"))
    .join("\n\n---\n\n");
}

// Valid entries for posts in the batch; unknown ids, repeats and invalid
// values are dropped, and the caller retries whatever is missing.
export function parseTriage(args: string, expectedIds: string[]): TriageResult[] {
  let parsed: any;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new Error("triage is not valid JSON");
  }
  if (!Array.isArray(parsed?.results)) throw new Error("triage has no results");
  const expected = new Set(expectedIds);
  const kept = new Map<string, TriageResult>();
  for (const r of parsed.results) {
    const id = String(r?.id ?? "");
    if (!expected.has(id) || kept.has(id)) continue;
    if (!TRIAGE_KINDS.includes(r.kind) || !TOPIC_IDS.includes(r.topic) || !SCORES.includes(r.score)) continue;
    kept.set(id, { id, kind: r.kind, topic: r.topic, score: r.score, reason: typeof r.reason === "string" ? cut(r.reason.trim(), 200) : "" });
  }
  return [...kept.values()];
}

export function triageInputFromRow(row: PostRow): TriageInput {
  const m = JSON.parse(row.metrics_json) as Metrics;
  return {
    id: row.id, text: row.text, quotedText: row.quoted_text, authorHandle: row.author_handle, authorName: row.author_name,
    authorBio: row.author_bio, authorFollowers: row.author_followers, authorCreatedAt: row.author_created_at,
    likes: m.likes, reposts: m.reposts, replies: m.replies, quotes: m.quotes, foundBy: JSON.parse(row.found_by) as string[],
  };
}

export function triageInputFromPost(post: XPost, foundBy: string[]): TriageInput {
  return {
    id: post.id, text: post.text, quotedText: post.quoted?.text ?? null, authorHandle: post.authorHandle, authorName: post.authorName,
    authorBio: post.authorBio, authorFollowers: post.authorFollowers, authorCreatedAt: post.authorCreatedAt,
    likes: post.likes, reposts: post.reposts, replies: post.replies, quotes: post.quotes, foundBy,
  };
}

// Same bounded GLM call as screening (src/filter.ts): a truncated or
// unreadable answer earns one more sample before this throws.
export async function callTriageModel(env: FilterEnv, posts: TriageInput[], profile: string, topicIds: readonly string[]): Promise<TriageResult[]> {
  const ids = posts.map((p) => p.id);
  return sampleModelDecision(
    env,
    `radar-triage:${ids[0] ?? "empty"}`,
    {
      messages: [
        { role: "system", content: buildTriagePrompt(profile, topicIds) },
        { role: "user", content: renderBatch(posts) },
      ],
      tools: [TRIAGE_TOOL],
      tool_choice: "auto",
    },
    (args) => {
      const results = parseTriage(args, ids).filter(r => r.topic === "hiring" || topicIds.includes(r.topic));
      if (!results.length) throw new Error("no usable triage results");
      return results;
    },
    "record_triage",
    { reasoningEffort: "low" },
  );
}

// One call; one retry of whatever it missed; then the rest split in half.
// Anything still missing is reported as failed rather than guessed.
export async function triageWithRecovery(
  posts: TriageInput[],
  call: (batch: TriageInput[]) => Promise<TriageResult[]>,
  pause: () => Promise<void> = () => new Promise<void>((resolve) => setTimeout(resolve, 4000)),
): Promise<{ results: TriageResult[]; failed: string[] }> {
  const results: TriageResult[] = [];
  const attempt = async (batch: TriageInput[]): Promise<TriageInput[]> => {
    let got: TriageResult[] = [];
    try {
      got = await call(batch);
    } catch {
      // An unusable answer counts as no answer; the retry and split handle it.
    }
    results.push(...got);
    const done = new Set(got.map((r) => r.id));
    return batch.filter((p) => !done.has(p.id));
  };
  let missing = await attempt(posts);
  if (missing.length) {
    await pause();
    missing = await attempt(missing);
  }
  if (missing.length > 1) {
    const half = Math.ceil(missing.length / 2);
    const first = missing.slice(0, half);
    const second = missing.slice(half);
    await pause();
    const a = await attempt(first);
    await pause();
    const b = await attempt(second);
    missing = [...a, ...b];
  }
  return { results, failed: missing.map((p) => p.id) };
}
