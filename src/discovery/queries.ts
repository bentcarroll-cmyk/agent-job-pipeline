import type { RuntimeConfig } from "../config/types";
import { immutableConfig } from "../config/candidate";
import { buildSearchQuery } from "../unbounded/discovery";

export type QueryFamily = "baseline" | "function" | "company" | "open_web" | "catchup";
export type QuerySpec = {
  id: string;
  version: string;
  family: QueryFamily;
  mode: "exact_phrase" | "all_terms";
  terms: readonly string[];
  hosts: readonly string[];
  recency: "month" | "any";
  employerKey: string | null;
};
export type QueryPageRequest = { queryId: string; page: number; q: string; tbs?: "qdr:m" };
export type VerifiedEmployer = { key: string; careerHosts: readonly string[]; verified: boolean };

export const ATS_SEARCH_HOSTS = ["boards.greenhouse.io", "job-boards.greenhouse.io",
  "jobs.ashbyhq.com", "jobs.lever.co", "myworkdayjobs.com"] as const;

/** Query identities are positional within an approved, versioned search bank. */
export function buildQueryBanks(config: RuntimeConfig): { baseline: readonly QuerySpec[]; exploration: readonly QuerySpec[]; rotation: readonly QuerySpec[] } {
  const search = config.candidate.search;
  const version = `q-${config.criteriaVersion}`;
  const make = (phrases: readonly string[], family: "baseline" | "function" | "open_web", prefix: string): QuerySpec[] =>
    phrases.map((phrase, index) => ({ id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
      version, family, mode: family === "baseline" ? "exact_phrase" : "all_terms",
      terms: [phrase], hosts: family === "open_web" ? [] : ATS_SEARCH_HOSTS, recency: "month", employerKey: null }));
  const baseline = make(search.baselinePhrases, "baseline", "baseline");
  const functions = make(search.functionPhrases, "function", "function");
  const open = make(search.openWebPhrases, "open_web", "open");
  const exploration = [...functions, ...open];
  if (!baseline.length && !exploration.length) throw new Error("Search requires approved query phrases");
  for (const query of [...baseline, ...exploration]) compileQuery(query, 1);
  // Include every phrase exactly once even when bank sizes differ. Distribute
  // function phrases between open-web phrases to preserve coverage rotation.
  const rotation: QuerySpec[] = [];
  const width = open.length ? Math.max(1, Math.ceil(functions.length / open.length)) : functions.length;
  for (let index = 0; index < Math.max(open.length, Math.ceil(functions.length / Math.max(1, width))); index++) {
    rotation.push(...functions.slice(index * width, (index + 1) * width));
    if (open[index]) rotation.push(open[index]);
  }
  return immutableConfig({ baseline, exploration, rotation });
}

function safeHost(host: string): boolean {
  return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
}

export function compileQuery(query: QuerySpec, page: number,
  registry: readonly VerifiedEmployer[] = []): QueryPageRequest {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid query page");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(query.id) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(query.version)) {
    throw new Error("Invalid query identity or version");
  }
  if (!Array.isArray(query.terms) || query.terms.length === 0 ||
    query.terms.some(term => typeof term !== "string" || term.length > 120 ||
      !/^[\p{L}\p{N}][\p{L}\p{N} .&-]*$/u.test(term.trim()))) throw new Error("Invalid query term");
  if (!Array.isArray(query.hosts) || query.hosts.some(host => typeof host !== "string" || !safeHost(host)) ||
    new Set(query.hosts).size !== query.hosts.length) throw new Error("Invalid query host");
  if (query.mode === "exact_phrase" && query.terms.length !== 1) throw new Error("Exact phrase requires one term");
  if (query.mode !== "exact_phrase" && query.mode !== "all_terms") throw new Error("Invalid query mode");
  if (query.recency !== "month" && query.recency !== "any") throw new Error("Invalid query recency");
  if (query.family === "company") {
    const employer = registry.find(item => item.key === query.employerKey && item.verified);
    if (!employer) throw new Error("Company query requires verified registry membership");
    if (query.hosts.length === 0 || query.hosts.some(host => !employer.careerHosts.includes(host))) {
      throw new Error("Company query host is outside its verified registry entry");
    }
  } else if (query.employerKey !== null) throw new Error("Non-company query cannot claim an employer key");
  if (query.family === "open_web" && query.hosts.length) throw new Error("Open-web query cannot have a host filter");
  if (query.family === "baseline" &&
    (query.mode !== "exact_phrase" || query.hosts.join("|") !== ATS_SEARCH_HOSTS.join("|") || query.recency !== "month")) {
    throw new Error("Baseline query policy changed");
  }
  const phrase = query.terms.map(term => term.trim().replace(/\s+/g, " ")).join(" ");
  const filter = query.hosts.length === 0 ? "" : query.hosts.length === 1 ? `site:${query.hosts[0]}` :
    `(${query.hosts.map(host => `site:${host}`).join(" OR ")})`;
  const q = query.family === "baseline" ? buildSearchQuery(phrase) :
    `${filter}${filter ? " " : ""}${query.mode === "exact_phrase" ? `"${phrase}"` : phrase}`;
  return { queryId: query.id, page, q, ...(query.recency === "month" ? { tbs: "qdr:m" as const } : {}) };
}

export function selectExplorationQueries(bank: readonly QuerySpec[], cursor: number, limit: number):
  { queries: QuerySpec[]; nextCursor: number } {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > bank.length) {
    throw new Error("Invalid exploration cursor or limit");
  }
  if (bank.length === 0) return { queries: [], nextCursor: 0 };
  const start = cursor % bank.length;
  return { queries: Array.from({ length: limit }, (_, index) => bank[(start + index) % bank.length]),
    nextCursor: (start + limit) % bank.length };
}

export function companyQueryTemplates(employer: VerifiedEmployer, phrases: readonly string[]): QuerySpec[] {
  if (!employer.verified || !employer.key || !employer.careerHosts.length ||
    employer.careerHosts.some(host => !safeHost(host))) throw new Error("Unverified employer registry entry");
  return phrases.map((terms, index) => ({
    id: `company-${employer.key}-${String(index + 1).padStart(3, "0")}`,
    version: "discovery-q1", family: "company", mode: "all_terms", terms: [terms],
    hosts: employer.careerHosts, recency: "month", employerKey: employer.key,
  }));
}
