// Public identity describes this operator's deployment; it does not claim
// that selecting an OAuth mode has verified the application with Google.
import type { InstanceConfig } from "../config/types";
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; }
  h2 { font-size: 1.1rem; margin-top: 1.75rem; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

function pages(instance: InstanceConfig): Record<string, string> {
  const operator = escapeHtml(instance.operator.displayName);
  const email = escapeHtml(instance.operator.contactEmail);
  const contact = escapeHtml(encodeURIComponent(instance.operator.contactEmail));
  const HOME = page(
    "agent-job-pipeline",
    `<h1>agent-job-pipeline</h1>
<p>agent-job-pipeline is a personal job-search assistant run by ${operator}. When enabled, it keeps the owner's record of job applications up to date by reading the job-application email in the owner's Gmail, read-only: confirmations, rejections, interview invitations and offers. It posts each change to the owner's own Slack channel.</p>
<p>Each operator runs a separate deployment in their own accounts. This deployment reads only the Gmail account that grants it permission.</p>
<p><a href="/privacy">Privacy policy</a></p>`,
  );

  const PRIVACY = page(
    "agent-job-pipeline privacy policy",
    `<h1>agent-job-pipeline privacy policy</h1>
<p>This policy describes the current instance configuration.</p>

<h2>Who uses it</h2>
<p>agent-job-pipeline is a personal tool operated by ${operator}. It reads only the Gmail account that signs in to it.</p>

<h2>What it reads</h2>
<p>With Google's read-only Gmail permission (<code>https://www.googleapis.com/auth/gmail.readonly</code>), agent-job-pipeline searches the account on the operator's configured schedule, or when the operator runs it, for job-application email from ${escapeHtml(instance.lifecycle.since)} onward: confirmations, rejections, interview scheduling and offers. Spam, trash and job-alert senders are skipped. For each matching email it reads the sender, subject, date, conversation and text. It never sends, deletes, labels or changes any email.</p>

<h2>How it uses what it reads</h2>
<p>The email's sender, subject, date and first 6,000 characters of text go to an AI model on Cloudflare Workers AI, in the owner's Cloudflare account. The model says whether the email confirms an application, rejects it, invites the owner to an interview or makes an offer, and names the employer and job. Logging and caching in Cloudflare's AI Gateway are turned off for these requests. The email text is never stored.</p>

<h2>Processing modes</h2>
<p>Live mode reconciles application records. Test mode saves test receipts and posts test summaries without changing the application ledger. Off mode, or disabling lifecycle tracking, reads no mail.</p>

<h2>What it keeps</h2>
<p>In the owner's Cloudflare D1 database it keeps, for each email: its Gmail message and conversation IDs, date, sender address and subject line; what the model read from it (the kind of email, employer, job title, requisition number, interview stage and time); and the resulting change to the owner's application records. It posts a summary of each change (employer, job title, new status, and the email's date, sender and subject) to the owner's own Slack channel. The Google sign-in token is kept as an encrypted secret in the owner's Cloudflare account.</p>

<h2>Sharing</h2>
<p>Nothing is sold, used for advertising or shared with anyone else. The only services that process this information are Cloudflare (hosting, database and the AI model) and Slack (the owner's own notifications), and only to run agent-job-pipeline.</p>
<p>agent-job-pipeline's use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Keeping and deleting</h2>
<p>Records stay in the owner's database until the owner deletes them. Access to Gmail can be revoked at any time at <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a>, after which agent-job-pipeline can no longer read the account.</p>

<h2>Contact</h2>
<p>Questions about this policy: ${operator}, <a href="mailto:${contact}">${email}</a>.</p>
<p><a href="/">agent-job-pipeline</a></p>`,
  );

  return { "/": HOME, "/privacy": PRIVACY };
}

// A page for a GET or HEAD of "/" or "/privacy"; null for anything else, which
// the Worker routes as before.
export function publicPage(request: Request, instance: InstanceConfig): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const html = pages(instance)[new URL(request.url).pathname];
  if (html === undefined) return null;
  return new Response(request.method === "HEAD" ? null : html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
