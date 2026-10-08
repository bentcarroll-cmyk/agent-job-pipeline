// Read-only Gmail access for the lifecycle tracker: a refresh token saved as
// a Worker secret is exchanged for a short-lived access token each run.
import type { GmailApiMessage } from "./gmail-message";

export class GmailAuthError extends Error {
  constructor() { super("Google sign-in expired, was revoked, or lacks read-only Gmail authorization"); }
}

// No provider response bodies, transport errors or credentials escape this boundary.
async function safeFetch(fetchImpl: typeof fetch, input: string, init: RequestInit, operation: string): Promise<Response> {
  try { return await fetchImpl(input, init); }
  catch { throw new Error(`${operation} failed`); }
}
function gmailStatus(res: Response, operation: string): void {
  if (res.status === 401 || res.status === 403) throw new GmailAuthError();
  if (!res.ok) throw new Error(`${operation} HTTP ${res.status}`);
}
async function safeJson(res: Response, operation: string): Promise<any> {
  try { return await res.json(); } catch { throw new Error(`${operation} returned invalid JSON`); }
}

export type GmailEnv = { GMAIL_CLIENT_ID: string; GMAIL_CLIENT_SECRET: string; GMAIL_REFRESH_TOKEN: string };

export async function getAccessToken(env: GmailEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await safeFetch(fetchImpl, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString(),
  }, "Google token exchange");
  const body: any = await safeJson(res, "Google token exchange");
  if (!res.ok) {
    // Expired (consent screen left in "Testing"), revoked, or invalidated by
    // a password change: only a new sign-in fixes it.
    if (body?.error === "invalid_grant") throw new GmailAuthError();
    throw new Error(`Google token exchange HTTP ${res.status}`);
  }
  if (typeof body?.access_token !== "string" || !body.access_token.trim()) throw new Error("Google token exchange returned no access token");
  return body.access_token;
}

// Broad receipt/interview search terms. The classifier resolves over-matches.
const INCLUDE = [
  '"application received"',
  '"thank you for applying"',
  '"thanks for applying"',
  '"received your application"',
  '"application has been received"',
  '"we received your application"',
  '"your application was sent"',
  '"your application to"',
  "subject:(application OR applying OR candidacy OR applied)",
  "unfortunately",
  '"not moving forward"',
  '"not be moving forward"',
  '"other candidates"',
  '"position has been filled"',
  '"regret to inform"',
  '"not to move forward"',
  '"thank you for your interest"',
  "interview",
  '"phone screen"',
  '"schedule a call"',
  '"your availability"',
  '"online assessment"',
  '"next steps"',
  '"offer letter"',
  '"pleased to offer"',
  '"offer of employment"',
  "from:indeedapply@indeed.com",
  "from:aiapplynotif.com",
];

// Job alerts and AIApply's digests only look like applications.
const EXCLUDE_SENDERS = ["jobalerts-noreply@linkedin.com", "match.indeed.com", "glassdoor.com", "ziprecruiter.com", "aiapplymail.com"];

// Category filtering can omit relevant receipt or interview mail.
export function buildSearchQuery(afterEpochSeconds: number): string {
  return `after:${afterEpochSeconds} {${INCLUDE.join(" ")}} -from:(${EXCLUDE_SENDERS.join(" OR ")})`;
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export async function listMessageIds(
  token: string,
  q: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ id: string; threadId: string }>> {
  const out: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(API);
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await safeFetch(fetchImpl, url.toString(), { headers: { authorization: `Bearer ${token}` } }, "Gmail messages.list");
    gmailStatus(res, "Gmail messages.list");
    const body: any = await safeJson(res, "Gmail messages.list");
    for (const m of body.messages ?? []) out.push({ id: m.id, threadId: m.threadId });
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

export async function getMessage(
  token: string,
  id: string,
  format: "full" | "metadata",
  fetchImpl: typeof fetch = fetch,
): Promise<GmailApiMessage> {
  const url = new URL(`${API}/${encodeURIComponent(id)}`);
  url.searchParams.set("format", format);
  if (format === "metadata") for (const h of ["From", "Subject", "Date"]) url.searchParams.append("metadataHeaders", h);
  const res = await safeFetch(fetchImpl, url.toString(), { headers: { authorization: `Bearer ${token}` } }, "Gmail messages.get");
  gmailStatus(res, "Gmail messages.get");
  return (await safeJson(res, "Gmail messages.get")) as GmailApiMessage;
}
