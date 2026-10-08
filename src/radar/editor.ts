// The daily editor pass: one Claude call that picks, merges and writes the
// digest, checked in code before anything is posted.
import Anthropic from "@anthropic-ai/sdk";
import { ANGLE_RULES, BANNED_TERMS } from "./angle-rules";
import type { Expansion } from "./collect";
import type { TasteExample } from "./db";
import type { Candidate } from "./rank";
import { cut, oneLine } from "./text";

export const EDITOR_MODEL = "claude-sonnet-5";
// The most a digest fits at three blocks an item: with the header, the count,
// four section titles and the footer, 14 items make 49 of Slack's 50 blocks.
export const MAX_ITEMS = 14;
// Digest order. Slack's titles for them are in digest-blocks.ts.
export const SECTIONS = ["hiring", "developments", "practice", "debates"] as const;
export type Section = (typeof SECTIONS)[number];
export type DigestItem = { postIds: string[]; headline: string; why: string | null; angle: string | null };
export type Digest = Record<Section, DigestItem[]>;
export type Context = { postId: string; thread: string[]; replies: Array<{ author: string; text: string; likes: number }> };
export type EditorInput = { candidates: Candidate[]; contexts: Context[]; taste: { useful: TasteExample[]; notUseful: TasteExample[] } };
export type EditorResult = {
  digest: Digest; fallback: boolean; inputTokens: number | null; outputTokens: number | null; problems: string[];
  // How many items validateDigest dropped to fit MAX_ITEMS. A diagnostic for
  // how often the editor ignores the cap; 0 on the plain-list fallback, which
  // is built to the cap already.
  trimmed: number;
};
export type EditorClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number }): Promise<Anthropic.Message> };
};

// Where the plain-list fallback files each kind. The editor itself may file
// a post under whichever section fits it best.
const SECTION_FOR_KIND: Record<Candidate["kind"], Section> = {
  hiring: "hiring", development: "developments", practice: "practice", debate: "debates",
};

// Structured outputs guarantee this shape. Lengths, ids and wording are
// checked in validateDigest, since the schema can't express them.
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    post_ids: { type: "array", items: { type: "string" } },
    headline: { type: "string" },
    why: { type: "string" },
    angle: { type: "string" },
  },
  required: ["post_ids", "headline", "why", "angle"],
  additionalProperties: false,
};
// Every section is required, in digest order.
export const DIGEST_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(SECTIONS.map((s) => [s, { type: "array", items: ITEM_SCHEMA }])),
  required: [...SECTIONS],
  additionalProperties: false,
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const emptyDigest = (): Digest => ({ hiring: [], developments: [], practice: [], debates: [] });

export function buildEditorPrompt(input: EditorInput, profile: string): { system: string; user: string } {
  const system = `You edit a daily digest of posts from X for one reader, delivered on the configured local schedule. ${profile}

Pick at most ${MAX_ITEMS} items in total, across all four sections:
- hiring: someone hiring for a role in the reader's lanes.
- developments: news and real developments worth knowing.
- practice: a hands-on way to use frontier AI that the reader could try, at home or at work. Its why line says how the reader could use it.
- debates: arguments worth reacting to in a LinkedIn post.

Rules:
- Use only the candidate ids you are given, each at most once. When several candidates cover the same story, make one item with the best post's id first and the others after it.
- headline: at most 100 characters, plain text, saying what happened or what is being argued.
- why: at most 200 characters, why it matters to this reader in particular.
- angle: debates only, at most 200 characters. Use an empty string for hiring, developments and practice.
- Write why lines to the reader as "you". Angles are draft arguments for review, per the angle rules. Never use the reader's name or employer, or the profile's labels.
- Every item must be worth the reader's time. When several posts cover one story, lead with the most credible and informative one. Leave a section empty rather than pad it.
- The reader replies the same day, so for debates and hiring prefer posts that are still active (roughly the last 12 hours) over older posts of similar value.
- Recent feedback shows the reader's taste. Lean toward what they marked useful and away from what they marked not useful.

${ANGLE_RULES}`;
  const candidates = input.candidates.map(renderCandidate).join("\n\n");
  const contexts = input.contexts.filter((c) => c.thread.length || c.replies.length).map(renderContext).join("\n\n");
  const taste = [
    input.taste.useful.length ? `Marked useful recently:\n${input.taste.useful.map(renderTaste).join("\n")}` : "",
    input.taste.notUseful.length ? `Marked not useful recently:\n${input.taste.notUseful.map(renderTaste).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const user = [`Candidates:\n\n${candidates}`, contexts ? `Conversation context:\n\n${contexts}` : "", taste]
    .filter(Boolean).join("\n\n====\n\n");
  return { system, user };
}

function renderCandidate(c: Candidate): string {
  return [
    `[${c.id}] ${c.kind} · ${c.topic} · score ${c.score} · ${Math.round(c.ageHours)}h old · ${c.likes} likes · ${c.replies} replies`,
    `@${c.authorHandle}${c.authorFollowers !== null ? ` (${c.authorFollowers} followers)` : ""}${c.authorBio ? `: ${cut(oneLine(c.authorBio), 160)}` : ""}`,
    cut(oneLine(c.text), 1000),
    c.quotedText ? `quoting: ${cut(oneLine(c.quotedText), 400)}` : "",
    `triage note: ${c.reason}`,
  ].filter(Boolean).join("\n");
}

function renderContext(c: Context): string {
  return [
    `Context for [${c.postId}]`,
    ...c.thread.map((t, i) => `thread ${i + 1}: ${t}`),
    ...c.replies.map((r) => `reply @${r.author} (${r.likes} likes): ${r.text}`),
  ].join("\n");
}

const renderTaste = (t: TasteExample) => `- [${t.kind}/${t.topic}] ${oneLine(t.text)}`;

export function contextFromExpansion(x: Expansion): Context {
  return {
    postId: x.postId,
    thread: x.thread.slice(0, 10).map((p) => cut(oneLine(p.text), 280)),
    replies: x.replies.slice(0, 20).map((p) => ({ author: p.authorHandle, text: cut(oneLine(p.text), 280), likes: p.likes })),
  };
}

// Two tries; the second is told exactly which checks failed. After that the
// digest is a plain ranked list, so a model failure never means no digest,
// and the result carries both tries' problems for the logs. At worst that's
// 2 tries × 2 SDK attempts (maxRetries 1) × 120 s = 8 minutes, inside the
// edit step's 10, so a hung call still reaches the fallback instead of
// timing the step out.
export async function runEditor(getClient: () => Promise<EditorClient>, input: EditorInput, profile: string): Promise<EditorResult> {
  const { system, user } = buildEditorPrompt(input, profile);
  let problems: string[] = [];
  const failures: string[] = [];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const content = attempt === 1 ? user : `${user}\n\nYour previous answer failed these checks. Fix them:\n- ${problems.join("\n- ")}`;
    try {
      const client = await getClient();
      const response = await client.messages.create({
        model: EDITOR_MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: DIGEST_SCHEMA } },
      }, { timeout: 120_000 });
      inputTokens = (inputTokens ?? 0) + response.usage.input_tokens;
      outputTokens = (outputTokens ?? 0) + response.usage.output_tokens;
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      if (response.stop_reason !== "end_turn") problems = [`stop_reason was ${response.stop_reason}`];
      else if (!text) problems = ["no text in the response"];
      else {
        const checked = validateDigest(JSON.parse(text.text), input.candidates);
        if (!checked.problems.length) {
          return { digest: checked.digest, fallback: false, inputTokens, outputTokens, problems: [], trimmed: checked.trimmed };
        }
        problems = checked.problems;
      }
    } catch (e) {
      problems = [(e as Error).message];
    }
    failures.push(...problems.map((p) => `attempt ${attempt}: ${p}`));
  }
  return { digest: plainDigest(input.candidates), fallback: true, inputTokens, outputTokens, problems: failures, trimmed: 0 };
}

export function validateDigest(parsed: any, candidates: Candidate[]): { digest: Digest; problems: string[]; trimmed: number } {
  const known = new Set(candidates.map((c) => c.id));
  const used = new Set<string>();
  const problems: string[] = [];
  const digest = emptyDigest();
  const { sections, trimmed } = trimToCap(parsed);
  for (const section of SECTIONS) {
    const items = sections[section];
    if (!items) {
      problems.push(`${section} is missing`);
      continue;
    }
    for (const raw of items) {
      const ids: string[] = Array.isArray(raw?.post_ids) ? raw.post_ids.map(String) : [];
      const first = ids[0] ?? "(none)";
      if (!ids.length) problems.push(`an item in ${section} has no post ids`);
      for (const id of ids) {
        if (!known.has(id)) problems.push(`unknown post id ${id}`);
        else if (used.has(id)) problems.push(`post id ${id} used twice`);
        used.add(id);
      }
      const headline = clean(raw?.headline);
      const why = clean(raw?.why);
      const angle = clean(raw?.angle);
      if (!headline || headline.length > 100) problems.push(`headline for ${first} is empty or over 100 characters`);
      if (!why || why.length > 200) problems.push(`why for ${first} is empty or over 200 characters`);
      if (section === "debates") {
        if (!angle || angle.length > 200) problems.push(`angle for ${first} is empty or over 200 characters`);
        const term = bannedTerm(angle);
        if (term) problems.push(`banned term "${term}" in item ${first}`);
      } else if (angle) {
        problems.push(`angle given outside debates for ${first}`);
      }
      digest[section].push({ postIds: ids, headline, why, angle: section === "debates" ? angle : null });
    }
  }
  if (digestItemCount(digest) === 0 && !problems.length) problems.push("no items");
  return { digest, problems, trimmed };
}

// Trim excess items deterministically before validation. Remove the last item
// from the largest section, breaking ties toward later sections, so retained
// items keep their original order and removed IDs do not count as used.
function trimToCap(parsed: any): { sections: Partial<Record<Section, any[]>>; trimmed: number } {
  const sections: Partial<Record<Section, any[]>> = {};
  for (const s of SECTIONS) if (Array.isArray(parsed?.[s])) sections[s] = [...parsed[s]];
  const size = (s: Section) => sections[s]?.length ?? 0;
  let trimmed = 0;
  for (let total = SECTIONS.reduce((n, s) => n + size(s), 0); total > MAX_ITEMS; total--) {
    // Scanning in digest order with >= hands a tie to the later section.
    const largest = SECTIONS.reduce((a, b) => (size(b) >= size(a) ? b : a));
    sections[largest]!.pop();
    trimmed++;
  }
  return { sections, trimmed };
}

export function bannedTerm(line: string): string | null {
  const lower = line.toLowerCase();
  for (const term of BANNED_TERMS) {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(lower)) return term;
  }
  return null;
}

export function plainDigest(candidates: Candidate[]): Digest {
  const digest = emptyDigest();
  for (const c of [...candidates].sort((a, b) => b.rank - a.rank).slice(0, MAX_ITEMS)) {
    const line = oneLine(c.text);
    digest[SECTION_FOR_KIND[c.kind]].push({
      postIds: [c.id],
      headline: line.length <= 100 ? line : `${cut(line, 99)}…`,
      why: null,
      angle: null,
    });
  }
  return digest;
}

export function digestPostIds(digest: Digest): string[] {
  return SECTIONS.flatMap((s) => digest[s].flatMap((item) => item.postIds));
}

export function digestItemCount(digest: Digest): number {
  return SECTIONS.reduce((n, s) => n + digest[s].length, 0);
}

export async function createEditorClient(env: { ANTHROPIC_API_KEY: string }): Promise<EditorClient> {
  // The optional editor uses its explicitly configured Anthropic credential.
  // Workers AI gateway authorization does not authorize this SDK client.
  // One SDK retry: runEditor's own second try covers the rest, and both
  // must fit inside the edit step (see runEditor).
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return { messages: { create: (params, options) => client.messages.create(params, options) } };
}
