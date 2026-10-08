import type { CandidatePolicy } from "./types";
import type { CompanyCategory, NormalizedJob } from "../sources";
import type { Verdict } from "../criteria";

const unsupportedEmploymentTokens = ["seasonal", "permanent", "internship", "freelance", "casual"] as const;
const employmentName = (value: string) => value.toLowerCase().replace(/[-_ ]/g, "").replace(/^contractor$/, "contract");
export function employmentEligibility(value: string, policy: CandidatePolicy): "allowed" | "excluded" | "unknown" {
  if (policy.employmentTypes.map(employmentName).includes(employmentName(value))) return "allowed";
  const configured = policy.employmentTypes.map(type => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const known = new RegExp(`\\b(full[- ]?time|part[- ]?time|contract(?:or)?|consulting|fractional|interim|temporary|${configured.join("|")})\\b`, "gi");
  // Negated arrangements are not positive evidence of an excluded type.
  const cleaned = value.replace(/\b(?:not|no)\s+(?:a\s+)?(?:full[- ]?time|part[- ]?time|contract(?:or)?|temporary)\b/gi, "");
  // An observed alternative cannot disappear merely because it is outside
  // the bounded token grammar. Known unsupported types also remain unknown.
  const unsupported = unsupportedEmploymentTokens.filter(type => !policy.employmentTypes.map(employmentName).includes(type));
  if (unsupported.some(type => new RegExp(`\\b${type}\\b`, "i").test(cleaned)) ||
      cleaned.split(/\s+or\s+/i).some(part => !new RegExp(known.source, "i").test(part))) return "unknown";
  const found = [...cleaned.matchAll(known)].map(match => employmentName(match[1]));
  if (!found.length) return "unknown";
  const allowed = policy.employmentTypes.map(employmentName);
  const states = found.map(type => allowed.includes(type));
  if (states.some(Boolean) && states.some(item => !item)) return "unknown";
  return states.every(Boolean) ? "allowed" : "excluded";
}
const clauses = (value: string) => value.split(/(?<=[.!?;])\s+|\n+/);
const clearanceParts = (clause: string) => clause.split(/\s+(?:and|but|while|however)\s+|,\s*/i);
const requiresClearance = (part: string) => /clearance|TS\/SCI/i.test(part) && /requir|must|hold|possess/i.test(part);
const laterOrNegatedClearance = (part: string) => /\bno\b|not required|obtain|after|ability to|eligible/i.test(part);
const mandatoryActive = (part: string) => requiresClearance(part) && /active|current|currently/i.test(part) &&
  /application|applying|apply|currently (?:hold|possess)|must (?:already|currently)/i.test(part) && !laterOrNegatedClearance(part);
const conflictingClearance = (value: string): boolean => {
  const parts = clauses(value).flatMap(clearanceParts);
  return parts.some(mandatoryActive) && parts.some(part => requiresClearance(part) &&
    /\bno\b|not (?:required|necessary)|does not require|need not/i.test(part) && !/obtain|after|additional/i.test(part));
};
export function activeAtApplication(value: string): boolean {
  // Disjunctions do not prove the active option mandatory. Conjunctions scope
  // later/negated wording to their own requirement rather than hiding another.
  return !conflictingClearance(value) && clauses(value).some(clause => !/\bor\b/i.test(clause) && clearanceParts(clause).some(mandatoryActive));
}
export function ambiguousClearance(value: string): boolean {
  return conflictingClearance(value) || clauses(value).some(clause =>
    clearanceParts(clause).some(part => requiresClearance(part) && !mandatoryActive(part) && (!laterOrNegatedClearance(part) || /active|current|currently/i.test(part) && /application|applying|apply/i.test(part) && !/\bno\b|not required/i.test(part))) ||
    /\bor\b/i.test(clause) && clearanceParts(clause).some(part => requiresClearance(part) && /active|current|currently/i.test(part) && /application|applying|apply/i.test(part)));
}
export function postingEmployment(job: NormalizedJob, policy: CandidatePolicy): "allowed" | "excluded" | "unknown" {
  // Only arrangement assertions about this role count. Incidental contract work,
  // consulting with clients, and generic employment prose are not arrangements.
  const tokens = ["full[- ]?time", "part[- ]?time", "contract(?:or)?", "consulting", "fractional", "interim", "temporary", ...unsupportedEmploymentTokens, ...policy.employmentTypes.map(type => type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|");
  const supportedAssertion = (clause: string) =>
    /^employment(?: type| arrangement)?\s*(?::|is\b)/i.test(clause.trim()) ||
    new RegExp(`^(?:this|the) (?:role|position|job) (?:is|will be|may be|can be) (?:an? )?(?:${tokens})\\b`, "i").test(clause.trim()) ||
    new RegExp(`\\b(?:${tokens}) employment\\b`, "i").test(clause) ||
    new RegExp(`^(?:this|the) (?:${tokens}) (?:role|position|job)\\b`, "i").test(clause.trim());
  const unresolvedAssertion = (clause: string) =>
    /^(?:this|the) (?:role|position|job)\b/i.test(clause.trim()) && /\b(?:employment|arrangement)\b/i.test(clause) && !supportedAssertion(clause);
  const observed = clauses(job.description ?? "").filter(clause => supportedAssertion(clause) || unresolvedAssertion(clause));
  const body = observed.some(unresolvedAssertion) ? "unknown" : employmentEligibility(observed.join(" "), policy);
  if (!job.employmentType) return body;
  const structured = employmentEligibility(job.employmentType, policy);
  if (!observed.length) return structured;
  return body === "unknown" || structured === "unknown" || structured !== body ? "unknown" : structured;
}

/** No conversion or annualization. Only explicit annual base-pay bounds in the policy currency count. */
export function salaryUpperBounds(value: string, policy: CandidatePolicy): number[] {
  const currency = policy.compensation.currency;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!/\bbase (?:pay|salary)\b/i.test(value) || !/\b(?:annual(?:ly)?|year(?:ly)?|per year|per annum)\b/i.test(value) ||
      /\bhour(?:ly)?\b|\bmonth(?:ly)?\b|total compensation|\bote\b|starting|minimum|\bat least\b|\bfrom\b|\+/.test(value.toLowerCase())) return [];
  const currencies = value.match(/\b(?:USD|CAD|AUD|EUR|GBP|JPY|CHF|INR)\b/gi) ?? [];
  if (currencies.some(item => item.toUpperCase() !== currency) ||
      (currency !== "USD" && /US\$/.test(value)) || (currency !== "GBP" && /£/.test(value)) || (currency !== "EUR" && /€/.test(value))) return [];
  const marker = currency === "USD" ? "(?:USD|US\\$)" : currency === "GBP" ? "(?:GBP|£)" : currency === "EUR" ? "(?:EUR|€)" : escape(currency);
  if (!new RegExp(marker, "i").test(value)) return [];
  const money = `${marker}\\s*[$£€]?\\s*(\\d[\\d,]*(?:\\.\\d+)?)(k)?`;
  const range = new RegExp(`${money}\\s*(?:-|–|—|to)\\s*(?:${marker}\\s*)?[$£€]?\\s*(\\d[\\d,]*(?:\\.\\d+)?)(k)?`, "gi");
  const amount = (number: string, k?: string) => Number(number.replaceAll(",", "")) * (k ? 1000 : 1);
  const matches = [...value.matchAll(range)];
  if (matches.length) {
    const bounds = matches.map(m => { const low = amount(m[1], m[2]), high = amount(m[3], m[4]); return low > 0 && high >= low ? high : NaN; });
    if (!bounds.every(Number.isFinite)) return [];
    const unconsumed = value.replace(range, "");
    const fixed = [...unconsumed.matchAll(new RegExp(money, "gi"))].map(m => amount(m[1], m[2]));
    if (!fixed.every(n => Number.isFinite(n) && n > 0) || /\d|[-–—]/.test(unconsumed.replace(new RegExp(money, "gi"), ""))) return [];
    return [...bounds, ...fixed.filter(n => n > 0)];
  }
  // A fixed disclosed base amount is comparable; open-ended or broken ranges are not.
  if (/\bto\b|[-–—]|\b(?:range|between)\b/i.test(value)) return [];
  const singles = [...value.matchAll(new RegExp(money, "gi"))].map(m => amount(m[1], m[2]));
  if (!singles.every(n => Number.isFinite(n) && n > 0) || /\d/.test(value.replace(new RegExp(money, "gi"), ""))) return [];
  return singles;
}
export function belowSalaryFloor(value: string, policy: CandidatePolicy): boolean {
  const floor = policy.compensation.minimumBase;
  const bounds = salaryUpperBounds(value, policy);
  return floor !== null && bounds.length > 0 && bounds.every(bound => bound < floor);
}
export function compensationStatus(job: NormalizedJob, policy: CandidatePolicy): "below" | "clears" | "unknown" {
  const texts = [job.compensation, ...clauses(job.description ?? "").filter(clause => /salary|base pay|compensation/i.test(clause) && /\d|[$£€]/.test(clause))].filter((text): text is string => !!text);
  const bounds = texts.map(text => salaryUpperBounds(text, policy));
  if (!bounds.length || bounds.some(list => !list.length)) return "unknown";
  const floor = policy.compensation.minimumBase;
  return floor !== null && bounds.flat().every(bound => bound < floor) ? "below" : "clears";
}
export function observedSalaryAboveFloor(job: NormalizedJob, policy: CandidatePolicy): boolean {
  const floor = policy.compensation.minimumBase;
  return floor === null || [job.description, job.compensation].some(value => value !== null && salaryUpperBounds(value, policy).some(bound => bound >= floor));
}
export function supportedLane(laneId: Verdict["lane"], policy: CandidatePolicy, category?: CompanyCategory | null): boolean {
  const lane = policy.functionLanes.find(item => item.id === laneId);
  return !!lane && (lane.companyCategories.length === 0 || !!category && lane.companyCategories.includes(category));
}
function fullBody(job: NormalizedJob): boolean {
  const coverage = job.contentProvenance;
  return !!job.description?.trim() && coverage?.description.truncated === false && coverage.description.originalChars !== null &&
    !coverage.coverageGaps.length && !/\[(?:middle of posting|snapshot text) omitted\]/i.test(job.description);
}
export function enforcePolicyVerdict(job: NormalizedJob, verdict: Verdict, policy: CandidatePolicy, category?: CompanyCategory): Verdict {
  const reject = (rule: string, reason: string): Verdict => ({ match: false, lane: null, hard_exclude: rule, reason });
  const employment = postingEmployment(job, policy);
  const active = activeAtApplication(job.description ?? "");
  const below = fullBody(job) && compensationStatus(job, policy) === "below" && (!job.compensation || job.contentProvenance?.compensation.truncated === false);
  if (verdict.match) {
    if (!supportedLane(verdict.lane, policy, category)) throw new Error("Model lane is not supported by candidate policy/company evidence");
    if (employment === "unknown") throw new Error("Employment eligibility requires review under the approved policy");
    if (ambiguousClearance(job.description ?? "") && policy.clearance !== "allow") throw new Error("Clearance timing requires review under the approved policy");
    if (employment === "excluded") return reject("1", "The disclosed employment arrangement is outside the approved policy.");
    if (active && policy.clearance === "exclude_active") return reject("2", "Active clearance at application is excluded by the approved policy.");
    if (active && policy.clearance === "review") throw new Error("Active clearance requires review under the approved policy");
    if (below) return reject("3", "Disclosed comparable annual base pay is below the approved floor.");
  } else {
    if (verdict.hard_exclude === null && !fullBody(job)) throw new Error("No-function-fit requires complete posting context; review required");
    // Unsupported model hard exclusions are retried, never recorded as a permanent rejection.
    if (verdict.hard_exclude === "1" && employment !== "excluded" ||
        verdict.hard_exclude === "2" && !(active && policy.clearance === "exclude_active") ||
        verdict.hard_exclude === "3" && !below) throw new Error("Model hard exclusion is not supported by candidate policy/evidence");
  }
  return verdict;
}
