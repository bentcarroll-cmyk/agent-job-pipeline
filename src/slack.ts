import { fetchWithDeadline } from "./operations/fetch";
// Slack app integration for the unbounded Worker: posts each match as its
// own interactive message and records the button you tap back into D1.
//
// This replaces the incoming-webhook path for this Worker. Webhooks are
// one-way — they cannot carry buttons and cannot edit a message after the
// fact — so a bot token is required for both halves of the round trip.
import type { NormalizedJob } from "./sources";
import type { Verdict } from "./criteria";
import type { ScreeningDecision } from "./screening/types";

export interface SlackEnv {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;
  // Empty string = accept clicks from anyone who can see the channel.
  SLACK_ALLOWED_USER_ID: string;
}

// Posting needs only these two. The fixed-board Worker posts matches but never
// receives the button clicks — those go to the unbounded Worker, the Slack
// app's single interactivity URL — so it carries no signing secret.
export type SlackPostEnv = Pick<SlackEnv, "SLACK_BOT_TOKEN" | "SLACK_CHANNEL_ID">;

// The button allowlist, and the application_status each one writes. A click
// whose action_id is absent here is rejected before it reaches D1, so the
// endpoint can only ever set one of these four values.
export const ACTION_STATUS: Record<string, string> = {
  mark_materials: "needs_materials",
  mark_applied: "applied",
  mark_passed: "passed",
  mark_undo: "not_applied",
};

const STATUS_RECEIPT: Record<string, string> = {
  needs_materials: "📄 Needs materials",
  applied: "✅ Applied",
  passed: "🚫 Passed",
};

export type Mark = { status: string; userId: string; at: Date };

// Clamp outgoing fields to Block Kit limits even when upstream source fields
// contain oversized text; retries cannot repair an invalid_blocks response.
const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_BUTTON_TEXT_LIMIT = 75;

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export type Interaction = {
  actionId: string;
  jobId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  blocks: unknown[];
  // The original message's notification text, carried through so the update
  // doesn't have to invent a new one.
  text: string;
};

// ---------------------------------------------------------------- signing

// Slack signs every interaction with an HMAC over `v0:{timestamp}:{body}`.
// Verifying it is the only thing standing between this endpoint and anyone
// who guesses the Worker URL, so it runs before the payload is even parsed.
//
// `nowSeconds` is injectable purely so the replay-window tests don't depend
// on wall-clock time.
export async function verifySlackRequest(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signingSecret?.trim() || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  // Slack's documented replay window. Checked in both directions: a
  // far-future timestamp is as much a forgery signal as a stale one.
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;

  if (!signature.startsWith("v0=")) return false;
  const digest = hexToBytes(signature.slice(3));
  if (!digest) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // crypto.subtle.verify compares in constant time, which a manual string
  // === on the hex digest would not.
  return crypto.subtle.verify("HMAC", key, digest, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
}

function hexToBytes(hex: string): Uint8Array | null {
  // SHA-256 is always 32 bytes; anything else is malformed, and a
  // wrong-length buffer would make crypto.subtle.verify throw rather than
  // return false.
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------- payload

export function parseInteraction(rawBody: string): Interaction | null {
  const encoded = new URLSearchParams(rawBody).get("payload");
  if (!encoded) return null;

  let payload: any;
  try {
    payload = JSON.parse(encoded);
  } catch {
    return null;
  }
  // Interactivity also delivers view_submission, shortcuts and others; this
  // endpoint handles button clicks only.
  if (payload?.type !== "block_actions") return null;

  const action = payload.actions?.[0];
  if (!action || typeof action.value !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(ACTION_STATUS, action.action_id)) return null;

  const userId = payload.user?.id;
  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  if (!userId || !channelId || !messageTs) return null;

  return {
    actionId: action.action_id,
    jobId: action.value,
    userId,
    channelId,
    messageTs,
    blocks: payload.message.blocks ?? [],
    text: payload.message.text ?? "",
  };
}

export type SlashCommand = {
  command: string;
  text: string;
  teamId: string;
  triggerId: string | null;
  userId: string;
  channelId: string;
  responseUrl: string;
};

export function parseSlashCommand(rawBody: string): SlashCommand | null {
  const params = new URLSearchParams(rawBody);
  if (params.get("command") !== "/job") return null;
  const teamId = params.get("team_id");
  const userId = params.get("user_id");
  const channelId = params.get("channel_id");
  const responseUrl = params.get("response_url");
  if (!teamId || !userId || !channelId || !responseUrl) return null;

  return {
    command: params.get("command") ?? "",
    text: unwrapSlackLink((params.get("text") ?? "").trim()),
    teamId,
    triggerId: params.get("trigger_id"),
    userId,
    channelId,
    responseUrl,
  };
}

// Slack auto-links bare URLs into <https://x> or <https://x|display text>.
// Left as-is the brackets become part of the URL and every pasted link
// fails to parse, which would make the command look broken for its single
// most common input.
function unwrapSlackLink(text: string): string {
  const linked = /^<(https?:\/\/[^|>]+)(?:\|[^>]*)?>$/.exec(text);
  return linked ? linked[1] : text;
}

// Slash-command replies go back through response_url rather than
// chat.postMessage: it needs no channel, works even where the bot is not a
// member, and defaults to ephemeral so errors stay private to the caller.
export async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  await fetchWithDeadline(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}

// The /job answer for a posting the candidate already applied to.
export function alreadyAppliedText(application: { employer: string | null; title: string | null; status: string | null }): string {
  return `Already applied: ${application.employer ?? "(no employer)"} — ${application.title ?? "(no title)"} ` +
    `(${application.status}). Nothing was added.`;
}

// ----------------------------------------------------------------- blocks

export function renderJobBlocks(job: NormalizedJob, verdict: Verdict, decision?: ScreeningDecision): any[] {
  const lines = [`*<${job.url}|${escapeMrkdwn(job.title)}>*`, `${escapeMrkdwn(job.company)} · ${escapeMrkdwn(job.location)}`];
  if (job.compensation) lines.push(escapeMrkdwn(job.compensation));
  else if (decision) lines.push(decision.evidence.some(fact => fact.field === "compensation")
    ? "Pay details appear in the quoted posting evidence below."
    : "Compensation unavailable in supplied evidence.");
  if (decision) lines.push(`*${screeningLabel(decision)}*`);
  lines.push(`_${verdict.lane ? `Lane ${verdict.lane} · ` : ""}${escapeMrkdwn(verdict.reason)}_`);

  return [
    {
      type: "section",
      // The update path finds this block by id and rebuilds everything after
      // it, so a click never has to re-derive the posting from D1.
      block_id: "job_detail",
      // Clamped after escaping, because escapeMrkdwn can grow the string.
      text: { type: "mrkdwn", text: clamp(lines.join("\n"), SLACK_SECTION_TEXT_LIMIT) },
    },
    ...(decision ? screeningBlocks(decision) : []),
    ...renderTail(job.id, null),
  ];
}

// Replace everything after the posting details with the tail for `mark`
// (null = the unmarked button row). Rebuilding rather than patching is what
// makes undo land back on precisely the message that was posted.
export function applyMark(blocks: any[], jobId: string, mark: Mark | null): any[] {
  const details = blocks.filter((b) => b?.block_id === "job_detail" ||
    (typeof b?.block_id === "string" &&
      (b.block_id.startsWith("screening_") || b.block_id.startsWith("manual_intake_"))));
  return [...details, ...renderTail(jobId, mark)];
}

function screeningLabel(decision: ScreeningDecision): string {
  return { match: "Possible match", no_match: "Does not meet screening criteria", needs_review: "Needs evidence review", retry: "Screening unavailable; retry needed" }[decision.state];
}

function screeningBlocks(decision: ScreeningDecision): any[] {
  const groups = [
    ["qualifications", "Qualifications to confirm", decision.qualificationWarnings],
    ["gaps", "Evidence gaps", decision.gaps],
    ["evidence", "Retained source evidence", decision.evidence.map(fact => `${({ description: "Posting", compensation: "Compensation", location: "Location", employmentType: "Employment type", title: "Title", department: "Department", companyCategory: "Verified company category", workplaceType: "Workplace type", secondaryLocations: "Other locations" })[fact.sourceField]}: “${fact.excerpt}”`)],
  ] as const;
  return groups.flatMap(([id, title, values]) => {
    if (!values.length) return [];
    const chunks: string[] = [];
    let current = title;
    for (const value of values) {
      // Plain text keeps quotations inert and avoids escaping expanding them
      // beyond Slack limits. Split groups without dropping later warnings.
      for (let offset = 0; offset < value.length; offset += 2800) {
        const line = `• ${value.slice(offset, offset + 2800)}`;
        if (current.length + line.length + 1 > SLACK_SECTION_TEXT_LIMIT) { chunks.push(current); current = title; }
        current += `\n${line}`;
      }
    }
    chunks.push(current);
    return chunks.map((text, index) => ({ type: "section", block_id: `screening_${id}_${index}`, text: { type: "plain_text", text } }));
  });
}

function renderTail(jobId: string, mark: Mark | null): any[] {
  if (!mark) {
    return [
      {
        type: "actions",
        block_id: "job_actions",
        elements: [
          button("mark_materials", "📄 Needs Materials", jobId),
          button("mark_applied", "✅ Applied", jobId, "primary"),
          button("mark_passed", "🚫 Pass", jobId),
        ],
      },
    ];
  }

  const receipt = STATUS_RECEIPT[mark.status] ?? mark.status;
  const unix = Math.floor(mark.at.getTime() / 1000);
  return [
    {
      type: "context",
      block_id: "job_receipt",
      elements: [
        {
          type: "mrkdwn",
          // <!date^…> renders in each viewer's own timezone, so the Worker
          // never has to guess one.
          text: `${receipt} · <@${mark.userId}> · <!date^${unix}^{time}|${mark.at.toISOString()}>`,
        },
      ],
    },
    {
      type: "actions",
      block_id: "job_actions",
      elements: [button("mark_undo", "Undo", jobId)],
    },
  ];
}

function button(actionId: string, label: string, value: string, style?: string) {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: clamp(label, SLACK_BUTTON_TEXT_LIMIT), emoji: true },
    value,
    ...(style ? { style } : {}),
  };
}

// Slack mrkdwn treats these three as control characters; a posting title
// containing one would otherwise break the link or the bold run around it.
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// -------------------------------------------------------------- transport

// `mark` posts the message already classified — used by /job, where adding a
// posting by hand is itself the expression of interest, so arriving with
// unpressed buttons would misstate what D1 already says.
export async function postMatch(
  env: SlackPostEnv,
  job: NormalizedJob,
  verdict: Verdict,
  mark?: Mark,
  decision?: ScreeningDecision,
): Promise<void> {
  const blocks = renderJobBlocks(job, verdict, decision);
  await slackApi(env.SLACK_BOT_TOKEN, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    // Shown in the notification and by clients that don't render blocks.
    text: `${job.title} — ${job.company}${decision ? ` · ${screeningLabel(decision)}` : ""}`,
    blocks: mark ? applyMark(blocks, job.id, mark) : blocks,
    unfurl_links: false,
  });
}

export async function postText(env: SlackPostEnv, text: string): Promise<void> {
  await slackApi(env.SLACK_BOT_TOKEN, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    text,
    unfurl_links: false,
  });
}

// Like postText, but with blocks, and returns the message's ts so it can be
// rewritten later (a lifecycle question once it is answered).
export async function postBlocks(env: SlackPostEnv, text: string, blocks: unknown[]): Promise<string> {
  const json = await slackApi(env.SLACK_BOT_TOKEN, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    text,
    blocks,
    unfurl_links: false,
  });
  return json.ts as string;
}

export async function updateMessage(
  env: SlackEnv,
  channelId: string,
  ts: string,
  blocks: unknown[],
  text: string,
): Promise<void> {
  await slackApi(env.SLACK_BOT_TOKEN, "chat.update", { channel: channelId, ts, blocks, text });
}

async function slackApi(token: string, method: string, body: unknown): Promise<any> {
  const res = await fetchWithDeadline(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}: ${await res.text()}`);

  // Slack reports application errors (invalid_auth, not_in_channel,
  // channel_not_found) as HTTP 200 with ok:false, so the status code alone
  // would let a silently-undelivered message look like a success.
  const json: any = await res.json();
  if (!json.ok) throw new Error(`Slack ${method} error: ${json.error}`);
  return json;
}
