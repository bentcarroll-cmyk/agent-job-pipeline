import { appliedApplicationForUrl } from "../db";
import { alreadyAppliedText, parseSlashCommand, verifySlackRequest, type SlackEnv } from "../slack";
import { acceptIntake, readIntake } from "./store";

export type CommandEnv = Pick<SlackEnv, "SLACK_SIGNING_SECRET" | "SLACK_ALLOWED_USER_ID"> & {
  DB: D1Database; MANUAL_INTAKE_MODE?: "legacy" | "durable";
};

const MAX_BODY_BYTES = 32 * 1024;
const MAX_URL_CHARS = 4096;
// Leaves most of Slack's three seconds for saving the request.
const KNOWN_CHECK_MS = 500;
const privateSuffix = /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example)$/i;

function reply(text: string, status = 200): Response {
  return Response.json({ response_type: "ephemeral", text },
    { status, headers: { "Cache-Control": "no-store" } });
}

async function boundedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function admissiblePublicUrl(value: string): boolean {
  if (!value || value.length > MAX_URL_CHARS || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !host.startsWith("[") && !/^\d+(?:\.\d+){3}$/.test(host) &&
      host.includes(".") && !privateSuffix.test(host);
  } catch { return false; }
}

// A link the candidate already applied to is answered instead of saved. The check only
// reads and fails open: a replay of an admitted request keeps its answer, and
// an error, a timeout or anything short of an applied match saves the request
// as before.
async function alreadyApplied(db: D1Database, id: string, url: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), KNOWN_CHECK_MS); });
  try {
    return await Promise.race([Promise.all([readIntake(db, id), appliedApplicationForUrl(db, url)])
      .then(([admitted, applied]) => admitted ? null : applied), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function intakeRequestId(teamId: string, triggerId: string | null,
  signedTimestamp: string, rawBody: string): Promise<string> {
  const input = triggerId ? [teamId, triggerId] : [teamId, signedTimestamp, rawBody];
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleIntakeCommand(request: Request, env: CommandEnv,
  kick: (id: string) => void): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let rawBody: string | null;
  try { rawBody = await boundedBody(request); }
  catch { return reply("Invalid command body.", 400); }
  if (rawBody === null) return reply("Command body is too large.", 413);
  const signedTimestamp = request.headers.get("x-slack-request-timestamp");
  if (!env.SLACK_SIGNING_SECRET || !await verifySlackRequest(env.SLACK_SIGNING_SECRET,
    request.headers.get("x-slack-signature"), signedTimestamp, rawBody)) {
    return reply("Bad signature.", 401);
  }
  const command = parseSlashCommand(rawBody);
  if (!command) return reply("Invalid /job command.", 400);
  if (!env.SLACK_ALLOWED_USER_ID || command.userId !== env.SLACK_ALLOWED_USER_ID) {
    return reply("This command is not available to you.", 403);
  }
  const status = /^status\s+([a-f0-9]{64})$/.exec(command.text);
  if (status) {
    let intake;
    try { intake = await readIntake(env.DB, status[1]); }
    catch { return reply("Could not read this request right now.", 503); }
    if (!intake || intake.teamId !== command.teamId || intake.userId !== command.userId) {
      return reply("Request not found.", 404);
    }
    let job: { url:string;application_status:string;notified_at:string|null } | null = null;
    let delivery: { state:string;channel_id:string|null;message_ts:string|null } | null = null;
    if (intake.jobId) {
      try {
        job = await env.DB.prepare(`SELECT url,application_status,notified_at FROM jobs WHERE id=?`)
          .bind(intake.jobId).first<{url:string;application_status:string;notified_at:string|null}>();
        delivery = await env.DB.prepare(`SELECT state,channel_id,message_ts
          FROM manual_intake_deliveries WHERE job_id=?`).bind(intake.jobId)
          .first<{state:string;channel_id:string|null;message_ts:string|null}>();
      }
      catch { return reply("Could not read this request right now.", 503); }
    }
    const lines = [`Request ${intake.id}: ${intake.state} (${intake.stage}).`];
    lines.push(`Submitted: ${intake.inputUrl}`);
    if (intake.failureCode) lines.push(`Reason: ${intake.failureCode}.`);
    if (job?.url) lines.push(`Posting: ${job.url}`);
    if (job) lines.push(`Application: ${job.application_status}.`);
    if (delivery) lines.push(delivery.state === "delivered" && delivery.channel_id && delivery.message_ts
      ? `Delivery: accepted in ${delivery.channel_id} at ${delivery.message_ts}.`
      : `Delivery: ${delivery.state}; accepted message receipt unavailable.`);
    else if (job?.notified_at) lines.push(`Prior notification recorded at ${job.notified_at}; message identity unavailable.`);
    return reply(lines.join("\n"));
  }
  if (command.text.startsWith("status")) return reply("Use /job status <request-id>.", 400);
  if (!admissiblePublicUrl(command.text)) return reply("Provide one public HTTPS posting URL.", 400);
  const id = await intakeRequestId(command.teamId, command.triggerId,
    signedTimestamp!, rawBody);
  const applied = await alreadyApplied(env.DB, id, command.text);
  if (applied) {
    console.log(JSON.stringify({ event: "intake_known_application", requestId: id, status: applied.status }));
    return reply(alreadyAppliedText(applied));
  }
  try {
    const saved = await acceptIntake(env.DB, { id, teamId: command.teamId,
      userId: command.userId, channelId: command.channelId,
      inputUrl: command.text, now: new Date().toISOString() });
    try { kick(saved.id); }
    catch { console.error("Manual intake dispatch kick could not be scheduled", { requestId: saved.id }); }
    return reply(`Saved request ${saved.id}. Processing will continue in the background. ` +
      `Use /job status ${saved.id} to check it. Current state: ${saved.state}.`);
  } catch {
    return reply("Could not confirm this request was saved. Retrying the same command delivery is safe.", 503);
  }
}
