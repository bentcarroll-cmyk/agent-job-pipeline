// Slack Block Kit for the AI radar digest and its marked items.
import type { Mark } from "./db";
import { SECTIONS, type Digest, type DigestItem, type Section } from "./editor";
import { cut } from "./text";

export const RADAR_ACTIONS = {
  useful: "radar_useful",
  notUseful: "radar_not_useful",
  mute: "radar_mute",
  undo: "radar_undo",
} as const;

export type ItemMeta = { url: string; authorHandle: string; ageHours: number; likes: number; replies: number };
export type Footer = { postsRead: number; estCostUsd: number; warnings: string[] };

const TITLES: Record<Section, string> = {
  hiring: "💼 Hiring", developments: "📰 Developments", practice: "🛠️ Try it", debates: "💬 Debates",
};
const MARK_LABEL: Record<Mark, string> = { useful: "✓ Useful", not_useful: "✓ Not useful", mute: "✓ Author muted" };

// Slack mrkdwn treats these three as control characters.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clamp = (s: string, n: number) => (s.length <= n ? s : `${cut(s, n - 1)}…`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const button = (actionId: string, label: string, value: string) => ({
  type: "button",
  action_id: actionId,
  text: { type: "plain_text", text: label, emoji: true },
  value,
});
const feedbackButtons = (postId: string) => [
  button(RADAR_ACTIONS.useful, "👍 Useful", postId),
  button(RADAR_ACTIONS.notUseful, "👎 Not useful", postId),
  button(RADAR_ACTIONS.mute, "🔇 Mute author", postId),
];

export function ageLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function footerText(footer: Footer): string {
  const base = `Read ${plural(footer.postsRead, "post", "posts")} · about $${footer.estCostUsd.toFixed(2)} of X data`;
  return footer.warnings.length ? `${base}\n:warning: ${footer.warnings.join(" · ")}` : base;
}

// At most 14 items at three blocks each, plus the header, the count, four
// section titles and the footer: 49 blocks, inside Slack's 50.
export function renderDigest(
  digest: Digest,
  meta: Map<string, ItemMeta>,
  header: { dateLabel: string; postsConsidered: number },
  footer: Footer,
): { text: string; blocks: any[] } {
  const body: any[] = [];
  let count = 0;
  for (const section of SECTIONS) {
    const items = digest[section].filter((item) => meta.has(item.postIds[0]));
    if (!items.length) continue;
    body.push({ type: "section", text: { type: "mrkdwn", text: `*${TITLES[section]}*` } });
    for (const item of items) body.push(...itemBlocks(item, meta.get(item.postIds[0])!));
    count += items.length;
  }
  const items = plural(count, "item", "items");
  return {
    text: `AI radar: ${items}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `AI radar · ${header.dateLabel}`, emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${items} from ${plural(header.postsConsidered, "post", "posts")}` }] },
      ...body,
      { type: "context", elements: [{ type: "mrkdwn", text: footerText(footer) }] },
    ],
  };
}

function itemBlocks(item: DigestItem, m: ItemMeta): any[] {
  const id = item.postIds[0];
  const lines = [`*<${m.url}|${esc(item.headline)}>*`];
  if (item.why) lines.push(esc(item.why));
  if (item.angle) lines.push(`_Angle:_ ${esc(item.angle)}`);
  const others = item.postIds.length - 1;
  const more = others > 0 ? ` · +${others} more ${others === 1 ? "post" : "posts"} on this` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: clamp(lines.join("\n"), 3000) } },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `@${esc(m.authorHandle)} · ${ageLabel(m.ageHours)} · ${plural(m.likes, "like", "likes")} · ${plural(m.replies, "reply", "replies")}${more}`,
      }],
    },
    { type: "actions", block_id: `radar_actions:${id}`, elements: feedbackButtons(id) },
  ];
}

// One block in, one block out, so marking never pushes the message past
// Slack's block limit.
export function markItem(blocks: any[], postId: string, mark: Mark): any[] {
  return blocks.map((b) =>
    b?.block_id === `radar_actions:${postId}` ? { ...b, elements: [button(RADAR_ACTIONS.undo, `${MARK_LABEL[mark]} · Undo`, postId)] } : b);
}

export function unmarkItem(blocks: any[], postId: string): any[] {
  return blocks.map((b) => (b?.block_id === `radar_actions:${postId}` ? { ...b, elements: feedbackButtons(postId) } : b));
}
