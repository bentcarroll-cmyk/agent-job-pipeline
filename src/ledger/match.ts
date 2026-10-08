import { parseJobUrl, workdaySite } from "../unbounded/discovery";
import { employerVariants, normalizeTitle } from "./normalize";
import type { LedgerRow } from "./types";

export type MatchQuery = {
  employer: string;
  title: string | null;
  requisitionId: string | null;
  // The email's From address: its Workday tenant names the employer's account
  // when the email names a brand, and its own domain can confirm a title
  // match (see senderKeys).
  sender?: string | null;
  postingUrl?: string | null;
};

// `exact` rows are the same application: same employer, plus a matching
// requisition number or title. When none is, `near` rows carry the same title
// worded a little differently (see nearTitle). `sameEmployer` is every row at
// the employer, the candidates offered when the evidence is too vague for
// either.
export type MatchResult = { exact: LedgerRow[]; near: LedgerRow[]; sameEmployer: LedgerRow[] };

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Spacing, punctuation and a web suffix are ignored: pipeline rows name the
// company from the job board's URL slug ("syntheticlabs" → "Synthetic Labs"),
// emails spell it out, and some companies go by their domain ("synthetic.test").
const nameKeys = (name: string) =>
  employerVariants(name.replace(/\.(com|io|ai|co|net|org|jobs)\b/gi, "")).map((v) => v.replace(/ /g, ""));

// Senders that relay mail for many employers, by site name: applicant-tracking
// systems, HR and payroll platforms, job boards, AIApply, calendars and
// personal mailboxes. Their domain says nothing about whose email it is.
const RELAYS = new Set([
  "ashbyhq", "bamboohr", "greenhouse", "greenhousemail", "icims", "jobvite", "lever", "myworkday", "rippling", "smartrecruiters", "workable", "workablemail",
  "adp", "ceridian", "dayforce", "dayforcehcm", "oracle", "oraclecloud", "paycom", "paycomonline", "paylocity", "sap", "successfactors", "taleo", "ukg", "ultipro",
  "aiapply", "aiapplymail", "aiapplynotif", "glassdoor", "indeed", "jobgether", "linkedin", "seek", "ziprecruiter",
  "calendly", "gmail", "google", "googlemail", "hotmail", "icloud", "outlook", "yahoo",
]);

// A host's registered name: "mail.amazon.jobs" → "amazon", "seek.com.au" → "seek".
function siteName(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  const n = labels.length;
  const countrySuffix = n > 2 && labels[n - 1].length === 2 && ["ac", "co", "com", "gov", "net", "org"].includes(labels[n - 2]);
  return compact(labels[n - (countrySuffix ? 3 : 2)] ?? "");
}

// The accounts an email's sender speaks for. The Workday tenant in
// "example@myworkday.test" (the employer's) is the employer's own. Any other domain
// might be a platform no list names that mails for many employers, so it may
// only confirm a matching title or requisition number (see findMatches).
function senderKeys(address: string): { tenant: string | null; domain: string | null } {
  const at = address.lastIndexOf("@");
  if (at < 0) return { tenant: null, domain: null };
  const domain = address.slice(at + 1).toLowerCase();
  if (domain === "myworkday.com") return { tenant: compact(address.slice(0, at)) || null, domain: null };
  const site = siteName(domain);
  return { tenant: null, domain: site && !RELAYS.has(site) ? site : null };
}

// The employer account a posting URL belongs to: its ATS board or Workday
// tenant, or a .jobs career site, which is
// registered to the employer it names ("amazon.jobs"). Any other host may be
// shared (to.indeed.com, ats.rippling.com, a Google search link), so it names
// no one.
function postingKeys(url: string | null): string[] {
  if (!url) return [];
  const ref = parseJobUrl(url, "");
  if (ref) return [compact(ref.slug)];
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".jobs") ? [siteName(host)] : [];
  } catch {
    return [];
  }
}

export function sameEmployer(a: string, b: string): boolean {
  const theirs = new Set(nameKeys(b));
  return nameKeys(a).some((k) => theirs.has(k));
}

// Words that carry nothing on their own, and words that set a job's level: a
// title that adds one of those is another job ("Manager" vs "Senior Manager").
const FILLER = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "the", "to", "with"]);
const LEVELS = new Set([
  "senior", "junior", "jr", "associate", "assistant", "principal", "staff", "lead", "head", "chief", "director", "manager",
  "vp", "vice", "president", "svp", "evp", "avp", "executive", "intern", "i", "ii", "iii", "iv",
]);

const titleWords = (title: string) => new Set(normalizeTitle(title).split(" ").filter((w) => w && !FILLER.has(w)));

// The same job's title worded a little differently: the same words in any
// order, give or take one that doesn't set the level ("Strategy - Director of
// Strategy and Operations" for "Director of Strategy and Operations", "VA
// Program Director, Federal" for "Program Director, Federal"). Three words at
// least: a title like "Head of Product" stands for too many jobs.
export function nearTitle(a: string, b: string): boolean {
  const [short, long] = [titleWords(a), titleWords(b)].sort((x, y) => x.size - y.size);
  if (short.size < 3 || long.size - short.size > 1) return false;
  return [...short].every((w) => long.has(w)) && [...long].every((w) => short.has(w) || !LEVELS.has(w));
}

/** Explicit identifiers take precedence over title or temporal similarity. */
export function conflictingIdentity(q: Pick<MatchQuery, "requisitionId" | "postingUrl">, r: Pick<LedgerRow, "requisitionId" | "postingUrl">): boolean {
  const incoming = q.postingUrl ? parseJobUrl(q.postingUrl, "") : null;
  const stored = r.postingUrl ? parseJobUrl(r.postingUrl, "") : null;
  if (q.requisitionId && r.requisitionId && compact(q.requisitionId) !== compact(r.requisitionId)) return true;
  if (incoming && stored && (incoming.ats !== stored.ats || incoming.slug.toLowerCase() !== stored.slug.toLowerCase() || compact(incoming.postingId) !== compact(stored.postingId))) return true;
  if (incoming?.ats === "workday" && stored?.ats === "workday" && workdaySite(q.postingUrl!) !== workdaySite(r.postingUrl!)) return true;
  const left = q.requisitionId ?? incoming?.postingId;
  const right = r.requisitionId ?? stored?.postingId;
  return !!left && !!right && compact(left) !== compact(right);
}

export function findMatches(q: MatchQuery, rows: LedgerRow[]): MatchResult {
  // An employer is every name and account it goes by: the email's names and
  // Workday tenant against each row's name and posting URL.
  const sender = q.sender ? senderKeys(q.sender) : { tenant: null, domain: null };
  const keys = new Set([...nameKeys(q.employer), ...(sender.tenant ? [sender.tenant] : [])]);
  const rowKeys = (r: LedgerRow) => [...nameKeys(r.employer), ...postingKeys(r.postingUrl)];
  const atEmployer = rows.filter((r) => rowKeys(r).some((k) => keys.has(k)));
  // Rows that only the sender's own domain points to can be the application
  // when the title or requisition matches, but they are never the employer's
  // other rows: not candidates, and never a reason to ask instead of adding.
  const viaDomain = sender.domain ? rows.filter((r) => !atEmployer.includes(r) && rowKeys(r).includes(sender.domain!)) : [];
  const req = q.requisitionId ? compact(q.requisitionId) : "";
  const title = q.title ? normalizeTitle(q.title) : "";
  const exact = [...atEmployer, ...viaDomain].filter((r) => {
    if (conflictingIdentity(q, r)) return false;
    // Requisition numbers are often recorded only inside the title
    // ("... (Hybrid) SYN-12345") or, for a posting the pipeline found, only
    // in its URL ("..._SYN-12345"), so all three places are checked. The
    // URL check needs a real id: a short one would be found in any URL.
    if (req && ((r.requisitionId && compact(r.requisitionId) === req) || (r.title && compact(r.title).includes(req)))) {
      return true;
    }
    if (req.length >= 5 && r.postingUrl && compact(r.postingUrl).includes(req)) return true;
    return !!title && !!r.title && normalizeTitle(r.title) === title;
  });
  const asked = q.title;
  const near = exact.length || !asked ? [] : atEmployer.filter((r) => !conflictingIdentity(q, r) && !!r.title && nearTitle(asked, r.title));
  return { exact, near, sameEmployer: atEmployer };
}
