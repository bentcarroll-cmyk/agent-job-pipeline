// Radar buttons arrive on the same /slack/actions endpoint as the job and
// lifecycle buttons (a Slack app has one interactivity URL); this picks out
// the radar's and applies them.
import { updateMessage, type SlackEnv } from "../slack";
import { applyFeedback, undoFeedback, type Mark } from "./db";
import { markItem, RADAR_ACTIONS, unmarkItem } from "./digest-blocks";

export type RadarAction = {
  kind: Mark | "undo";
  postId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  blocks: unknown[];
  text: string;
};

const KINDS: Record<string, RadarAction["kind"]> = {
  [RADAR_ACTIONS.useful]: "useful",
  [RADAR_ACTIONS.notUseful]: "not_useful",
  [RADAR_ACTIONS.mute]: "mute",
  [RADAR_ACTIONS.undo]: "undo",
};

export function parseRadarAction(rawBody: string): RadarAction | null {
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
  if (!action || typeof action.value !== "string" || !Object.prototype.hasOwnProperty.call(KINDS, action.action_id)) return null;
  const userId = payload.user?.id;
  const channelId = payload.channel?.id;
  const messageTs = payload.message?.ts;
  if (!userId || !channelId || !messageTs) return null;
  return {
    kind: KINDS[action.action_id],
    postId: action.value,
    userId,
    channelId,
    messageTs,
    blocks: payload.message.blocks ?? [],
    text: payload.message.text ?? "",
  };
}

// A mark that didn't apply (already marked, or the post is gone) leaves the
// message as it is, so a double tap can't flip it back and forth.
export async function handleRadarAction(env: SlackEnv & { DB: D1Database }, action: RadarAction, now = new Date()): Promise<void> {
  const at = now.toISOString();
  if (action.kind === "undo") {
    if (await undoFeedback(env.DB, action.postId, at)) {
      await updateMessage(env, action.channelId, action.messageTs, unmarkItem(action.blocks as any[], action.postId), action.text);
    }
    return;
  }
  if (await applyFeedback(env.DB, action.postId, action.kind, at)) {
    await updateMessage(env, action.channelId, action.messageTs, markItem(action.blocks as any[], action.postId, action.kind), action.text);
  }
}
