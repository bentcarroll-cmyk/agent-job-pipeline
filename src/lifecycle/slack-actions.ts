// Lifecycle buttons arrive on the same /slack/actions endpoint as the job
// buttons (a Slack app has one interactivity URL); this picks out ours.
import { ANSWER_ACTION_PREFIX, UNDO_ACTION } from "./slack-blocks";

type Where = { userId: string; channelId: string; messageTs: string; blocks: unknown[]; text: string };

export type LifecycleAction = ({ kind: "answer"; messageId: string; option: string } | { kind: "undo"; messageId: string }) & Where;

export function parseLifecycleAction(rawBody: string): LifecycleAction | null {
  const encoded = new URLSearchParams(rawBody).get("payload");
  if (!encoded) return null;
  let payload: any;
  try {
    payload = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (payload?.type !== "block_actions") return null;
  const action = payload.actions?.[0];
  if (!action || typeof action.value !== "string" || typeof action.action_id !== "string") return null;
  const where: Where = {
    userId: payload.user?.id,
    channelId: payload.channel?.id,
    messageTs: payload.message?.ts,
    blocks: payload.message?.blocks ?? [],
    text: payload.message?.text ?? "",
  };
  if (!where.userId || !where.channelId || !where.messageTs) return null;

  if (action.action_id === UNDO_ACTION) return { kind: "undo", messageId: action.value, ...where };
  if (action.action_id.startsWith(`${ANSWER_ACTION_PREFIX}:`)) {
    const split = action.value.indexOf("|");
    if (split < 0) return null;
    return { kind: "answer", messageId: action.value.slice(0, split), option: action.value.slice(split + 1), ...where };
  }
  return null;
}
