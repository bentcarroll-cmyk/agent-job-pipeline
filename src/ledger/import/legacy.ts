// Import selected legacy application records and explicit confirmation evidence.
import { sameEmployer } from "../match";
import { identityKey, normalizeEmployer, normalizeTitle } from "../normalize";
import { statusRank } from "../transitions";
import type { LedgerStatus } from "../types";
import type { Candidate, Question } from "./types";

export type LegacyRecord = {
  employer: string;
  title: string;
  urls?: string[];
  explicit_requisition_id?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  linear_reference?: { linear_id?: string } | null;
  review?: { review_decision?: string } | null;
  historical_state?: {
    pipeline_stage?: string | null;
    application_status?: { state?: string; submitted_at?: string; confirmed_on?: string } | null;
  } | null;
};

export type RegisterRecord = {
  company: string;
  role: string | null;
  stage: string;
  confirmationDate: string | null;
  applicationDate?: string | null;
  latestEventDate?: string | null;
  linearIssue?: string;
  source?: string;
};

export type LinearIssue = { id: string; title: string };

// Explicit resolutions supplied by the selected import.
export type PursueResolution = {
  applied_confirmed_by_email: Array<{
    linear_id: string | null;
    employer: string;
    title?: string;
    evidence_date: string;
    submitted_at?: string;
    merge_into?: string;
  }>;
  applied_confirmed_by_user: Array<string | { linear_id: string; confirmed_on?: string; source?: string }>;
  not_applied: string[];
};

const APPLIED_STATES = new Set(["applied", "applied_confirmed", "application_received"]);
const UNCONFIRMED_STATES = new Set(["possibly_applied_unconfirmed", "unconfirmed"]);

const REGISTER_STATUS: Record<string, LedgerStatus> = {
  "Application received": "applied",
  "Application submitted — user confirmed": "applied",
  Rejected: "closed",
  "Closed — role no longer accepting applications": "closed",
};

const ANSWER_STATUS: Record<string, LedgerStatus> = {
  applied: "applied",
  not_pursuing: "not_pursuing",
  closed: "closed",
};

const dateOnly = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a.slice(0, 10) <= b.slice(0, 10) ? a : b;
}

// Two records for one application: keep the further-along status (the
// newer one on a tie) and fill gaps from the other.
function combine(a: Candidate, b: Candidate): Candidate {
  const bWins =
    statusRank(b.status) > statusRank(a.status) ||
    (statusRank(b.status) === statusRank(a.status) && (b.statusAt ?? "") > (a.statusAt ?? ""));
  const [hi, lo] = bWins ? [b, a] : [a, b];
  return {
    ...hi,
    sourceJobId: hi.sourceJobId ?? lo.sourceJobId,
    title: hi.title ?? lo.title,
    postingUrl: hi.postingUrl ?? lo.postingUrl,
    requisitionId: hi.requisitionId ?? lo.requisitionId,
    appliedAt: earliest(hi.appliedAt, lo.appliedAt),
    mergeInto: hi.mergeInto ?? lo.mergeInto,
    evidence: `${hi.evidence}; ${lo.evidence}`,
  };
}

// Register rows mostly lack a Linear id. Linear titles read "Employer — Role".
function findIssue(r: RegisterRecord, issues: LinearIssue[]): string | null {
  const hits = issues.filter((i) => {
    const [employer, ...rest] = i.title.split(" — ");
    if (!rest.length || !sameEmployer(employer, r.company)) return false;
    return !r.role || normalizeTitle(rest.join(" — ")) === normalizeTitle(r.role);
  });
  return hits.length === 1 ? hits[0].id : null;
}

type Resolved = Pick<Candidate, "status" | "statusAt" | "appliedAt" | "mergeInto" | "evidence">;

function resolvePursue(r: LegacyRecord, lid: string | null, p: PursueResolution): Resolved {
  const email = p.applied_confirmed_by_email.find((e) =>
    e.linear_id
      ? e.linear_id === lid
      : sameEmployer(e.employer, r.employer) && (!e.title || normalizeTitle(e.title) === normalizeTitle(r.title)),
  );
  if (email) {
    return {
      status: "applied",
      statusAt: dateOnly(email.submitted_at),
      appliedAt: dateOnly(email.submitted_at),
      mergeInto: email.merge_into ?? null,
      evidence: `Confirmation email ${email.evidence_date}`,
    };
  }
  const user = lid && p.applied_confirmed_by_user.find(item => (typeof item === "string" ? item : item.linear_id) === lid);
  if (user) {
    const provenance = typeof user === "string" ? "" : user.source ? `: ${user.source}` : "";
    const confirmation = typeof user !== "string" && user.confirmed_on ? `confirmed ${user.confirmed_on}` : "undated";
    // The observation date of a confirmation does not establish the application date.
    return { status: "applied", statusAt: null, appliedAt: null, mergeInto: null, evidence: `User confirmed applying${provenance} (${confirmation})` };
  }
  return { status: "new", statusAt: null, appliedAt: null, mergeInto: null, evidence: "Marked pursue; not applied" };
}

export function legacyCandidates(input: {
  legacy: LegacyRecord[];
  register: RegisterRecord[];
  issues: LinearIssue[];
  pursue: PursueResolution;
  holdForReview: string[];
  answers: Record<string, string>;
  // Register "company" values that are labels rather than employers
  // mapped to the employer's real name.
  aliases?: Record<string, string>;
}): { candidates: Candidate[]; questions: Question[] } {
  const questions: Question[] = [];
  const entries: Candidate[] = [];
  const index = new Map<string, number>();

  // A record is found again under its Linear id or its employer+title, so
  // the register and legacy state collapse into one candidate.
  const keysOf = (c: Candidate) =>
    [c.sourceJobId, identityKey(c.employer, c.title), c.title ? null : `employer:${normalizeEmployer(c.employer)}`].filter(
      (k): k is string => !!k,
    );
  const add = (c: Candidate) => {
    const at = keysOf(c)
      .map((k) => index.get(k))
      .find((i) => i !== undefined);
    const i = at ?? entries.length;
    entries[i] = at === undefined ? c : combine(entries[at], c);
    for (const k of keysOf(entries[i])) index.set(k, i);
  };

  const askOrResolve = (id: string, text: string, base: Omit<Candidate, "status">) => {
    const answer = input.answers[id];
    if (answer === undefined) {
      questions.push({ id, kind: "unconfirmed_legacy", text, evidence: base.evidence, options: ["applied", "not_pursuing", "closed", "skip"] });
      return;
    }
    const status = ANSWER_STATUS[answer];
    if (status) add({ ...base, status, ...(status === "applied" ? { statusAt: base.appliedAt } : {}) });
  };

  for (const r of input.legacy) {
    const lid = r.linear_reference?.linear_id ?? null;
    const app: { state?: string; submitted_at?: string; confirmed_on?: string } = r.historical_state?.application_status ?? {};
    const stage = r.historical_state?.pipeline_stage ?? null;
    const decision = r.review?.review_decision ?? null;
    const submitted = dateOnly(app.submitted_at);
    const base: Omit<Candidate, "status"> = {
      source: "linear_legacy",
      sourceJobId: lid,
      employer: r.employer,
      title: r.title,
      statusAt: null,
      appliedAt: null,
      postingUrl: r.urls?.[0] ?? null,
      requisitionId: r.explicit_requisition_id ?? null,
      mergeInto: null,
      evidence: `Linear ${lid ?? "(no issue)"}: ${stage ?? decision ?? "no stage"}${app.confirmed_on ? `; confirmed ${app.confirmed_on}` : ""}`,
    };

    if (stage === "recruiter_screening_invited") {
      add({ ...base, status: "interviewing", statusAt: dateOnly(r.last_seen), appliedAt: submitted });
    } else if (APPLIED_STATES.has(app.state ?? "") || stage === "applied" || stage === "applied_waiting") {
      add({ ...base, status: "applied", statusAt: submitted, appliedAt: submitted });
    } else if (decision === "pass" || stage === "not_pursuing" || app.state === "not_pursuing") {
      add({ ...base, status: "not_pursuing", statusAt: dateOnly(r.last_seen) });
    } else if (decision === "hold" || UNCONFIRMED_STATES.has(app.state ?? "")) {
      askOrResolve(
        `legacy:${lid ?? normalizeEmployer(r.employer)}`,
        `Did you apply to ${r.employer} — ${r.title}? The legacy record says ${app.state ?? decision}.`,
        base,
      );
    } else if (decision === "pursue") {
      add({ ...base, ...resolvePursue(r, lid, input.pursue) });
    }
    // Anything else was never reviewed, which is out of scope.
  }

  for (const raw of input.register) {
    const r = { ...raw, company: input.aliases?.[raw.company] ?? raw.company };
    const issue = r.linearIssue ?? findIssue(r, input.issues);
    const status = REGISTER_STATUS[r.stage];
    const base: Omit<Candidate, "status"> = {
      source: "linear_legacy",
      sourceJobId: issue,
      employer: r.company,
      title: r.role,
      statusAt: status === "applied" ? dateOnly(r.applicationDate) : dateOnly(r.latestEventDate),
      appliedAt: dateOnly(r.applicationDate),
      postingUrl: null,
      requisitionId: null,
      mergeInto: null,
      evidence: `${r.source ?? "Application register"}: ${r.stage} (${dateOnly(r.confirmationDate) ?? "undated"})`,
    };
    const held = input.holdForReview.some((h) => sameEmployer(h, r.company));
    if (!status || held) {
      askOrResolve(
        `register:${issue ?? normalizeEmployer(r.company)}`,
        `Did you apply to ${r.company}${r.role ? ` — ${r.role}` : ""}? The selected register says "${r.stage}".`,
        base,
      );
      continue;
    }
    add({ ...base, status });
  }

  return { candidates: entries, questions };
}
