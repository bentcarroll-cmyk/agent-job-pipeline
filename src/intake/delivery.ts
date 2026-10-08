import { fetchWithDeadline } from "../operations/fetch";
import { applyMark, renderJobBlocks, type SlackPostEnv } from "../slack";
import type { Verdict } from "../criteria";
import type { ManualCard, SendOutcome } from "./types";

function displayVerdict(card: ManualCard): Verdict {
  if (card.advisoryError || !card.verdict) return {
    match: true, lane: null, hard_exclude: null,
    reason: "Added by hand. Advisory screening was unavailable; qualifications need review.",
  };
  if (!card.verdict.match) return { ...card.verdict,
    reason: `Added by hand. Advisory screening disagreed: ${card.verdict.reason}` };
  return { ...card.verdict, reason: `Added by hand. ${card.verdict.reason}` };
}

function code(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value) ? value : fallback;
}

export async function sendManualCard(env: SlackPostEnv, card: ManualCard,
  deliveryId: string): Promise<SendOutcome> {
  if (deliveryId !== `manual:${card.job.id}` || !/^[a-f0-9]{64}$/.test(card.requestId) ||
    !env.SLACK_CHANNEL_ID || !env.SLACK_BOT_TOKEN) {
    return { kind: "rejected", code: "invalid_delivery_configuration" };
  }
  const marker = { type: "context", block_id: `manual_intake_${card.requestId}`,
    elements: [{ type: "plain_text", text: "Added by hand" }] };
  const locationGaps = card.job.locationMetadata?.coverageGaps ?? [];
  const warnings = locationGaps.length ? [{ type: "section", block_id: "manual_location_warnings",
    text: { type: "plain_text", text: `Location details to confirm: ${locationGaps.join("; ").slice(0, 2800)}` } }] : [];
  const blocks = applyMark([...renderJobBlocks(card.job, displayVerdict(card)), ...warnings, marker],
    card.job.id, { status: "needs_materials", userId: card.userId,
      at: new Date(card.selectedAt) });
  let response: Response;
  try {
    response = await fetchWithDeadline("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID,
        text: `Added by hand: ${card.job.title} — ${card.job.company}`,
        blocks, unfurl_links: false }),
    });
  } catch { return { kind: "unknown", code: "transport_uncertain" }; }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400)
      return { kind: "unknown", code: "rate_limit_without_retry_after" };
    return { kind: "retryable_rejection", code: "rate_limited",
      retryAfterMs: Math.max(1000, Math.ceil(seconds * 1000)) };
  }
  if (!response.ok) {
    return response.status >= 500 || response.status === 408
      ? { kind: "unknown", code: `http_${response.status}_uncertain` }
      : { kind: "rejected", code: `http_${response.status}` };
  }
  let answer: {ok?:boolean;error?:unknown;channel?:unknown;ts?:unknown};
  try { answer = await response.json(); }
  catch { return { kind: "unknown", code: "unreadable_response" }; }
  if (answer.ok === false) return { kind: "rejected", code: code(answer.error, "slack_rejected") };
  if (answer.ok !== true || answer.channel !== env.SLACK_CHANNEL_ID ||
    typeof answer.ts !== "string" || !/^\d+\.\d+$/.test(answer.ts)) {
    return { kind: "unknown", code: "missing_or_invalid_receipt" };
  }
  return { kind: "accepted", receipt: { channelId: answer.channel,
    messageTs: answer.ts } };
}
