// Slack Block Kit for the lifecycle tracker: the daily summary, question
// messages, and their answered and undone forms.
import type { Question } from "../ledger/import/types";
import type { Change } from "./decide";

export const ANSWER_ACTION_PREFIX = "lifecycle_answer";
export const UNDO_ACTION = "lifecycle_undo";

export type SummaryItem =
  | { kind: "change"; messageId: string; change: Change; event: string; date: string }
  | { kind: "round"; messageId: string; employer: string; title: string | null; round: number; stage: string | null; date: string }
  | { kind: "scheduled"; messageId: string; employer: string; title: string | null; round: number; scheduledFor: string }
  | { kind: "fyi"; note: string }
  | { kind: "question"; text: string };

export type UpcomingRound = { employer: string; title: string | null; round: number; scheduledFor: string };

const MAX_BLOCKS = 50;
const EVENT_LABEL: Record<string, string> = {
  application_confirmation: "confirmation",
  rejection: "rejection",
  interview_invitation: "interview",
  offer: "offer",
};

// Slack mrkdwn treats ampersands and angle brackets as control characters.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const words = (s: string) => s.replace(/_/g, " ");
const shortDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// Presentation uses the selected instance zone; stored timestamps remain unchanged.
export const whenLabel = (iso: string, timezone: string) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short" });
const dayIn = (d: Date, timezone: string) => d.toLocaleDateString("en-CA", { timeZone: timezone });
const who = (employer: string, title: string | null) => `*${esc(employer)}*${title ? `, ${esc(title)}` : ""}`;
const section = (text: string, extra: Record<string, unknown> = {}) => ({ type: "section", text: { type: "mrkdwn", text }, ...extra });
const button = (actionId: string, label: string, value: string) => ({
  type: "button",
  action_id: actionId,
  text: { type: "plain_text", text: label.length > 75 ? `${label.slice(0, 74)}…` : label, emoji: true },
  value,
});

export function changeLine(change: Change, event: string, date: string): string {
  const when = `${EVENT_LABEL[event] ?? words(event)} ${shortDate(date)}`;
  if (change.kind === "added") return `➕ ${who(change.employer, change.title)}: *added as ${words(change.to)}* · ${when}`;
  const icon = change.to === "closed" ? "❌" : "✅";
  return `${icon} ${who(change.employer, change.title)}: ${words(change.from ?? "")} → *${words(change.to)}* · ${when}`;
}

export function roundLine(r: { employer: string; title: string | null; round: number; stage: string | null; date: string }): string {
  const stage = r.stage ? ` (${words(r.stage)})` : "";
  return `🗓 ${who(r.employer, r.title)}: *round ${r.round}*${stage} invite · ${shortDate(r.date)}`;
}

export function renderSummary(
  items: SummaryItem[],
  opts: { test: boolean; dateLabel: string; staleQuestions: number; timezone: string },
): Array<{ text: string; blocks: any[] }> {
  const header = opts.test ? `🧪 *Test mode, ${opts.dateLabel}: would change…*` : `📬 *Application updates, ${opts.dateLabel}*`;
  // One Undo per email: it reverses everything that email changed. An email
  // with a second line (an interview invitation's status and round) gives that
  // line its own block id, since Slack rejects a message whose ids repeat.
  const linesFor = new Map<string, number>();
  const undo = (messageId: string) => {
    if (opts.test) return {};
    const n = (linesFor.get(messageId) ?? 0) + 1;
    linesFor.set(messageId, n);
    return n === 1 ? { block_id: `lc:${messageId}`, accessory: button(UNDO_ACTION, "Undo", messageId) } : { block_id: `lc:${messageId}:${n}` };
  };
  const lines: any[] = [];
  for (const item of items) {
    if (item.kind === "change") {
      lines.push(section(changeLine(item.change, item.event, item.date), undo(item.messageId)));
    } else if (item.kind === "round") {
      lines.push(section(roundLine(item), undo(item.messageId)));
    } else if (item.kind === "scheduled") {
      // A time is not undoable: the next scheduling email simply overwrites it.
      lines.push(section(`🗓 ${who(item.employer, item.title)}: *round ${item.round}* on ${whenLabel(item.scheduledFor, opts.timezone)}`));
    } else if (item.kind === "fyi") {
      lines.push(section(`ℹ️ ${esc(item.note)}`));
    } else {
      lines.push(section(`❓ Would ask: ${esc(item.text)}`));
    }
  }
  if (opts.staleQuestions > 0) {
    const n = opts.staleQuestions;
    lines.push(section(`⏳ ${n} question${n === 1 ? "" : "s"} older than 2 days ${n === 1 ? "is" : "are"} still waiting for an answer.`));
  }
  const messages: Array<{ text: string; blocks: any[] }> = [];
  for (let i = 0; i < lines.length; i += MAX_BLOCKS - 1) {
    messages.push({ text: header.replace(/\*/g, ""), blocks: [section(header), ...lines.slice(i, i + MAX_BLOCKS - 1)] });
  }
  return messages;
}

// The reminder window covers the next 48 hours; labels use the
// configured timezone.
export function renderUpcoming(rounds: UpcomingRound[], now: string, timezone: string): string | null {
  const from = Date.parse(now);
  const soon = rounds
    .map((r) => ({ ...r, at: Date.parse(r.scheduledFor) }))
    .filter((r) => r.at >= from && r.at <= from + 48 * 3_600_000)
    .sort((a, b) => a.at - b.at);
  if (!soon.length) return null;
  const today = dayIn(new Date(from), timezone);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const lines = soon.map((r) => {
    const day = dayIn(new Date(r.at), timezone);
    const label = day === today ? "*Today*, " : day === tomorrow ? "*Tomorrow*, " : "";
    return `• ${label}${whenLabel(r.scheduledFor, timezone)}: ${who(r.employer, r.title)} (round ${r.round})`;
  });
  return `🗓 *Coming up*\n${lines.join("\n")}`;
}

const FIXED_LABELS: Record<string, string> = { new: "Add as new", skip: "Ignore", apply: "Apply", keep: "Keep as is" };

// The planner identifies row choices by ledger ID; Slack buttons display
// the corresponding employer and role labels.
export function questionText(question: Question): string {
  return question.options.reduce((text, o) => text.split(`${o} = `).join(""), question.text);
}

export function renderQuestion(question: Question, messageId: string, evidence: string): any[] {
  // Up to three "it's this one" rows, then the fixed choices.
  const rowOptions = question.options.filter((o) => !(o in FIXED_LABELS)).slice(0, 3);
  const fixed = question.options.filter((o) => o in FIXED_LABELS);
  const buttons = [...rowOptions, ...fixed].map((o, i) =>
    button(`${ANSWER_ACTION_PREFIX}:${i}`, question.optionLabels?.[o] ?? FIXED_LABELS[o] ?? o, `${messageId}|${o}`),
  );
  return [
    section(`❓ ${esc(questionText(question))}`, { block_id: "lc_question" }),
    { type: "context", elements: [{ type: "mrkdwn", text: esc(evidence) }] },
    { type: "actions", block_id: `lc_answers:${messageId}`, elements: buttons },
  ];
}

export function renderAnswered(question: Question, outcome: string, messageId: string): any[] {
  return [
    section(`❓ ${esc(questionText(question))}`, { block_id: "lc_question" }),
    section(outcome, { block_id: `lc:${messageId}`, accessory: button(UNDO_ACTION, "Undo", messageId) }),
  ];
}

// Rewrites only this email's lines: a summary can hold many others.
export function markUndone(blocks: any[], messageId: string): any[] {
  const mine = (id: unknown) => id === `lc:${messageId}` || (typeof id === "string" && id.startsWith(`lc:${messageId}:`));
  return blocks.map((b) => (mine(b?.block_id) ? section(`↩️ Undone: ${b.text.text}`, { block_id: b.block_id }) : b));
}
