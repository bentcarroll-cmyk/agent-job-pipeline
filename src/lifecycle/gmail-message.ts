// Gmail API message → the few fields the tracker uses. The text is read only
// to classify the email inside a single Workflow step; it is never stored.
import { htmlToText } from "../description";

export type GmailPart = {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPart[];
};

export type GmailApiMessage = { id: string; threadId: string; internalDate?: string; payload?: GmailPart };

export type EmailMessage = { id: string; threadId: string; from: string; subject: string; date: string; text: string };

// Enough for any confirmation, rejection or invitation; the rest of a long
// email is signatures, legal text and quoted history.
export const MAX_TEXT_CHARS = 6000;

export function decodeBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return undefined;
}

export function extractText(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain.body!.data!).trim().slice(0, MAX_TEXT_CHARS);
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(decodeBase64Url(html.body!.data!), MAX_TEXT_CHARS) ?? "";
  return "";
}

// "Name <addr@example.invalid>" → "addr@example.invalid", lowercased: the form sender rules match on.
export function senderAddress(from: string): string {
  const bracketed = /<([^>]+)>/.exec(from);
  return (bracketed ? bracketed[1] : from).trim().toLowerCase();
}

export function parseMessage(msg: GmailApiMessage): EmailMessage {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const date = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(header("Date"));
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: senderAddress(header("From")),
    subject: header("Subject"),
    date: date.toISOString(),
    text: extractText(msg.payload),
  };
}

// The only trace of an email that is ever stored.
export const evidenceLine = (m: Pick<EmailMessage, "date" | "from" | "subject">) => `${m.date.slice(0, 10)} · ${m.from} · ${m.subject}`;
