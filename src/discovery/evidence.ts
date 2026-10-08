import { activeAtApplication, belowSalaryFloor, observedSalaryAboveFloor, employmentEligibility, postingEmployment, compensationStatus, ambiguousClearance } from "../config/policy";
import type { RuntimeConfig } from "../config/types";
import type { CompanyCategory } from "../sources";
import type { EvidenceFact, EvidenceField, EvidenceSourceField, PostingSnapshot, ScreeningDecision } from "../screening/types";
import { locationFactNamesPlaceOutside, resolveLocationEligibility } from "../location";

export const SCREENING_VERSIONS = { promptVersion: "evidence-screening-config-v1", model: "@cf/zai-org/glm-5.3-flash" } as const;
const sources: Record<EvidenceField, EvidenceSourceField[]> = {
  location: ["description", "location", "workplaceType", "secondaryLocations"], employment: ["description", "employmentType"],
  compensation: ["description", "compensation"], clearance: ["description"], function: ["description"],
  company_category: ["description", "companyCategory"], qualification: ["description"],
};
const excludes = ["employment", "clearance", "compensation", "location"] as const;
const exclusionReasons = {
  employment: "Retained evidence identifies an employment arrangement outside the approved employment arrangements.",
  clearance: "Retained evidence requires active security clearance at the time of application.",
  compensation: "Retained evidence establishes an applicable disclosed base-pay ceiling below the approved compensation floor.",
  location: "Retained location evidence places the role outside the eligible work area.",
} satisfies Record<NonNullable<ScreeningDecision["hardExclude"]>, string>;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 24 && value.every(item => text(item, 500));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const OMISSION = /\[(?:middle of posting|snapshot text) omitted\]/i;
type Anchor = Pick<EvidenceFact, "sourceField" | "excerpt" | "sourceUrl" | "start" | "end">;

// The retained text each source field names. Office alternatives are joined
// one per line so a fact's offsets index a single string.
export function evidenceSourceText(snapshot: PostingSnapshot, sourceField: EvidenceSourceField): string | null {
  const metadata = snapshot.job.locationMetadata;
  if (sourceField === "companyCategory") return snapshot.companyCategory;
  if (sourceField === "workplaceType") return metadata?.workplaceType ?? null;
  if (sourceField === "secondaryLocations") return metadata?.secondaryLocations.length ? metadata.secondaryLocations.join("\n") : null;
  return snapshot.job[sourceField];
}

// Find a proposed quote in the posting. The claimed field is tried first. A
// quote the model labelled with the wrong field, wrapped in snapshot JSON, or
// retyped with other spacing, case or punctuation is rescued only into a
// field this fact may cite, and is anchored to the posting's own text.
export function anchorEvidence(field: EvidenceField, sourceField: string, excerpt: string, snapshot: PostingSnapshot): Anchor[] | null {
  if (OMISSION.test(excerpt)) return null;
  const permitted = sources[field];
  const at = (source: EvidenceSourceField, start: number, end: number): Anchor | null => {
    const excerpt = evidenceSourceText(snapshot, source)!.slice(start, end);
    // Rescue can normalize a retyped marker into synthetic omission text.
    // Validate the recovered source slice before accepting any anchor.
    if (OMISSION.test(excerpt)) return null;
    return { sourceField: source, excerpt, start, end,
      sourceUrl: source === "companyCategory" ? "configuration:fixed-sources" : snapshot.job.url };
  };
  const exact = (source: EvidenceSourceField, quote: string): Anchor | null => {
    const start = evidenceSourceText(snapshot, source)?.indexOf(quote) ?? -1;
    return start < 0 ? null : at(source, start, start + quote.length);
  };
  const claimed = permitted.find(source => source === sourceField);
  const direct = claimed ? exact(claimed, excerpt) : null;
  if (direct) return [direct];
  // (a) exact text in another permitted field
  for (const source of permitted) {
    const hit = source === claimed ? null : exact(source, excerpt);
    if (hit) return [hit];
  }
  // (b) a JSON or key: value slice whose keys are permitted fields
  const pairs = unwrapPairs(excerpt);
  const unwrapped = pairs.map(pair => {
    const source = permitted.find(item => item === pair.key);
    return source ? exact(source, pair.value) : null;
  });
  if (pairs.length && unwrapped.every(hit => hit !== null)) return unwrapped as Anchor[];
  // (c) the same text after whitespace, case and typography normalization
  const needle = looseText(excerpt);
  for (const source of permitted) {
    const text = evidenceSourceText(snapshot, source);
    if (!text || !needle) continue;
    const hay = loose(text), found = hay.text.indexOf(needle);
    if (found >= 0) {
      const hit = at(source, hay.from[found], hay.to[found + needle.length - 1]);
      if (hit) return [hit];
    }
  }
  return null;
}

// Model quotes of the serialized snapshot, e.g. `location":"Mumbai` or
// `"secondaryLocations":["Pune","Delhi"]`. Nulls, booleans and numbers are
// not text and are never unwrapped.
function unwrapPairs(excerpt: string): { key: string; value: string }[] {
  if (!/"\s*:|^\s*[\[{]|^\s*"?[A-Za-z]+"?\s*:\s|;\s*"?[A-Za-z]+"?\s*:\s/.test(excerpt)) return [];
  const pairs: { key: string; value: string }[] = [];
  for (const match of excerpt.matchAll(/"?([A-Za-z]+)"?\s*:\s*(\[[^\]]*\]?|"[^"]*"?|[^;,\]\[{}"]*)/g)) {
    const raw = match[2].trim();
    const values = raw.startsWith("[") ? raw.replace(/^\[|\]$/g, "").split(/"\s*,\s*"/).map(item => item.replace(/^"|"$/g, "").trim())
      : [raw.replace(/^"|"$/g, "").trim()];
    for (const value of values) if (value && !/^(?:null|true|false|\d+(?:\.\d+)?)$/i.test(value)) pairs.push({ key: match[1], value });
  }
  return pairs;
}

const typography = (value: string) => value.normalize("NFKC").replace(/[‘’‚‛′]/g, "'")
  .replace(/[“”„″]/g, '"').replace(/[‐-―−]/g, "-").replace(/ /g, " ").toLowerCase();
// Normalizes whitespace, case and typography while remembering the source
// offsets of each character, so a loose match maps back to exact text.
function loose(value: string): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [], to: number[] = [];
  for (let i = 0; i < value.length;) {
    const width = value.codePointAt(i)! > 0xffff ? 2 : 1;
    for (const char of typography(value.slice(i, i + width))) {
      if (/\s/.test(char)) {
        if (!text || text.endsWith(" ")) continue;
        text += " ";
      } else text += char;
      // String search offsets count UTF-16 units, including both halves of astral characters.
      for (let unit = 0; unit < char.length; unit++) { from.push(i); to.push(i + width); }
    }
    i += width;
  }
  return { text, from, to };
}
export const looseText = (value: string): string => loose(value).text.trim();

// Without authoritative configuration, the entire description field must be an
// explicit, unqualified employer self-statement naming an existing category.
// Normalize whitespace across the whole field: wrapping must not erase attribution
// or negation. Additional prose is deliberately reviewable, not classified here.
const categories: readonly CompanyCategory[] = ["frontier AI", "AI infrastructure", "defense/autonomy", "applied AI"];
function descriptionCategory(anchor: Anchor, snapshot: PostingSnapshot): CompanyCategory | null {
  const coverage = snapshot.job.contentProvenance?.description;
  if (coverage?.provided !== true || coverage.truncated !== false || coverage.originalChars === null) return null;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subject = `(?:we are|our (?:company|organization|business) is|${escape(looseText(snapshot.job.company))} is)`;
  const statement = new RegExp(`^${subject} an? (${categories.map(category => escape(looseText(category))).join("|")}) (?:company|organization|business)[.!]?$`);
  const description = looseText(snapshot.job.description ?? "");
  const value = statement.exec(description)?.[1];
  const category = categories.find(category => looseText(category) === value);
  const normalized = (text: string) => looseText(text).replace(/[.!]$/, "");
  return category && normalized(anchor.excerpt) === normalized(description) ? category : null;
}

export function validateScreeningDecision(raw: unknown, snapshot: PostingSnapshot, config: RuntimeConfig): ScreeningDecision {
  const policy = config.candidate.policy;
  if (!record(raw) || typeof raw.state !== "string" || !["match", "no_match", "needs_review"].includes(raw.state) ||
      !["A", "B", null].includes(raw.lane as string | null) || !text(raw.reason, 1500) ||
      !(raw.hardExclude === null || excludes.includes(raw.hardExclude as typeof excludes[number])) ||
      !strings(raw.gaps) || !Array.isArray(raw.evidence) || raw.evidence.length > 24) throw new Error("invalid screening decision structure");
  const evidence: EvidenceFact[] = [];
  const gaps: string[] = [];
  for (const proposed of raw.evidence) {
    if (!record(proposed) || !text(proposed.field, 40) || !Object.hasOwn(sources, proposed.field) ||
        !text(proposed.sourceField, 40) || !text(proposed.excerpt, 1200) || !text(proposed.value, 500)) throw new Error("invalid screening evidence structure");
    const field = proposed.field as EvidenceField;
    const anchors = anchorEvidence(field, proposed.sourceField, proposed.excerpt, snapshot);
    // A model-supplied binding that disagrees with the anchor is not rescued:
    // the quote may be real text from another posting or source.
    if (!anchors || anchors.some(anchor => (proposed.snapshotId !== undefined && proposed.snapshotId !== snapshot.id) ||
        (proposed.sourceUrl !== undefined && proposed.sourceUrl !== anchor.sourceUrl) ||
        (proposed.start !== undefined && proposed.start !== anchor.start) || (proposed.end !== undefined && proposed.end !== anchor.end))) {
      // Drop only this quote. The decisive-field checks below decide whether
      // the remaining evidence still supports the decision.
      gaps.push(`${field}: evidence could not be anchored to this snapshot/source`); continue;
    }
    for (const anchor of anchors) {
      let value = proposed.value;
      if (field === "company_category") {
        const category = anchor.sourceField === "companyCategory" ? snapshot.companyCategory : descriptionCategory(anchor, snapshot);
        if (!category || looseText(proposed.value) !== looseText(category) ||
            (snapshot.companyCategory !== null && category !== snapshot.companyCategory)) {
          gaps.push("company_category: model value is unsupported or contradicts the authoritative source");
          continue;
        }
        value = category;
      }
      evidence.push({ field, value, snapshotId: snapshot.id, ...anchor });
    }
  }
  const coverage = snapshot.job.contentProvenance;
  gaps.push(...(coverage?.coverageGaps ?? []));
  for (const field of ["description", "compensation"] as const) {
    const p = coverage?.[field];
    if (!snapshot.job[field]) {
      // Pay may be quoted in the posting body even when its separate field is
      // empty. Only retained, anchored evidence can suppress this missing gap.
      if (field !== "compensation" || !evidence.some(fact => fact.field === "compensation")) gaps.push(`${field}: unavailable in supplied evidence`);
    }
    else if (p?.truncated) gaps.push(`${field}: retained text is truncated; omitted text may contain additional requirements`);
    else if (p?.truncated !== false || p.originalChars === null) gaps.push(`${field}: source coverage is unknown`);
  }
  if ((snapshot.job.compensation || evidence.some(fact => fact.field === "compensation")) && compensationStatus(snapshot.job, policy) === "unknown") gaps.push("compensation: comparable annual base pay is unknown; currency, period or upper-bound evidence is unsupported");
  const fullBody = !!snapshot.job.description && coverage?.description.provided === true && coverage.description.truncated === false &&
    coverage.description.originalChars !== null && !/\[(?:middle of posting|snapshot text) omitted\]/i.test(snapshot.job.description) && !coverage.coverageGaps.some(g => /description|location|list|omitt|unknown|unsupported/i.test(g));
  const has = (field: EvidenceField) => evidence.some(item => item.field === field);
  // A credential-only downgrade violates the selected policy. Resample once
  // rather than inventing a lane or persisting the model's mistaken rejection.
  const qualificationGap = (value: string) => /qualification|credential|licen[sc]e|certification|experience|degree|education|bachelor|master|doctorate|Ph\.?D/i.test(value) && /unconfirm|unknown|not confirmed|not supplied|not provided|candidate|profile/i.test(value);
  if (raw.state !== "match" && raw.hardExclude === null && has("qualification") && has("function") && has("location") &&
      evidence.some(e => e.field === "function" && !qualificationOnly(e.excerpt)) && qualificationGap(raw.reason) && raw.gaps.every(gap => qualificationGap(gap) || /compensation|salary/i.test(gap) && /unknown|unavailable|undisclosed|not disclosed|not supplied|not provided|missing/i.test(gap))) {
    throw new Error("qualification uncertainty alone cannot downgrade a possible match");
  }
  let state = raw.state as ScreeningDecision["state"];
  let hardExclude = raw.hardExclude as ScreeningDecision["hardExclude"];
  const review = (gap: string) => { state = "needs_review"; hardExclude = null; gaps.push(gap); };
  if (state === "match") {
    const location = resolveLocationEligibility(snapshot.job, config.candidate.policy);
    if (location.state !== "eligible") review(location.reason);
    if (postingEmployment(snapshot.job, policy) !== "allowed") review("Employment eligibility conflicts with or is unknown under the approved employment arrangements");
    const lane = policy.functionLanes.find(lane => lane.id === raw.lane);
    if (!lane) review("Function lane is not available under the approved policy");
    if ((activeAtApplication(snapshot.job.description ?? "") || ambiguousClearance(snapshot.job.description ?? "")) && policy.clearance !== "allow") review("Active clearance conflicts with or requires review under the approved policy");
    if (fullBody && compensationStatus(snapshot.job, policy) === "below") review("Comparable disclosed base pay is below the approved compensation floor");
    if (raw.lane === null || hardExclude !== null || !has("function") || !has("location")) review("Positive function and eligible-location evidence with a valid lane are required");
    if (lane?.companyCategories.length) {
      const supported = snapshot.companyCategory !== null
        ? lane.companyCategories.includes(snapshot.companyCategory)
        : evidence.some(fact => fact.field === "company_category" && lane.companyCategories.some(category => category === fact.value));
      if (!supported) review("Lane company category is outside the approved categories or unsupported");
      if (supported && !has("company_category") && snapshot.companyCategory) evidence.push({ field: "company_category", value: snapshot.companyCategory, excerpt: snapshot.companyCategory,
        sourceField: "companyCategory", sourceUrl: "configuration:fixed-sources", snapshotId: snapshot.id, start: 0, end: snapshot.companyCategory.length });
    }
  }
  if (state === "no_match") {
    if (hardExclude === null && (!fullBody || !has("function") || evidence.filter(e => e.field === "function").every(e => qualificationOnly(e.excerpt)))) review("No-function-fit requires sufficiently complete posting evidence");
    if (hardExclude !== null && !has(hardExclude)) review("Hard exclusion lacks supporting evidence");
    if (hardExclude === "employment" && (postingEmployment(snapshot.job, policy) !== "excluded" || !evidence.filter(e => e.field === "employment").some(e => employmentEligibility(e.excerpt, policy) === "excluded"))) review("Employment evidence does not establish excluded employment");
    if (hardExclude === "location" && !fullBody) review("Incomplete posting cannot establish absence of an eligible location");
    if (hardExclude === "location") {
      // An exclusion must quote somewhere concrete outside the eligible area
      // and must not contradict the deterministic location check.
      if (!evidence.some(e => e.field === "location" && locationFactNamesPlaceOutside(e, snapshot.job, config.candidate.policy))) review("Location exclusion lacks a place outside the eligible area");
      if (resolveLocationEligibility(snapshot.job, config.candidate.policy).state !== "ineligible") review("Location exclusion is not established or conflicts with the posting location");
    }
    if (hardExclude === "compensation") {
      const facts = evidence.filter(e => e.field === "compensation");
      if (!fullBody || compensationStatus(snapshot.job, policy) !== "below" || observedSalaryAboveFloor(snapshot.job, policy) || !facts.every(e => belowSalaryFloor(e.excerpt, policy)) || facts.some(e => e.sourceField === "compensation" && coverage?.compensation.truncated !== false)) review("Incomplete compensation evidence cannot establish an upper bound");
    }
    if (hardExclude === "clearance") {
      const facts = evidence.filter(e => e.field === "clearance");
      if (policy.clearance !== "exclude_active" || !activeAtApplication(snapshot.job.description ?? "") || ambiguousClearance(snapshot.job.description ?? "") || !facts.some(e => activeAtApplication(e.excerpt)) || facts.some(e => !activeAtApplication(e.excerpt))) review("Clearance timing requires review; obtaining clearance is not an exclusion");
    }
  }
  if (state === "needs_review") hardExclude = null;
  const retainedGaps = state === raw.state ? [...raw.gaps.filter(isUncertaintyGap), ...gaps] : gaps;
  if (state === "needs_review" && retainedGaps.length === 0) retainedGaps.push("A reliable decision could not be established from the retained evidence.");
  // The proposal's reason remains available to safety checks above. Display
  // only the validated outcome; free-form prose can add unproved exclusions.
  const reason = state === "match" ? "Retained role and location evidence support a possible match." :
    state === "no_match" ? (hardExclude === null ? "Retained responsibilities fall outside the target functions." : exclusionReasons[hardExclude]) :
    "Available posting evidence is insufficient or inconsistent; review the gaps before deciding.";
  return { state, lane: state === "match" ? raw.lane as "A" | "B" : null, hardExclude,
    reason,
    evidence, gaps: [...new Set(retainedGaps)], qualificationWarnings: [...new Set(evidence.filter(e => e.field === "qualification").map(e => e.value))], ...SCREENING_VERSIONS, criteriaVersion: config.criteriaVersion };
}

// These guards reject explicit contradictions and ambiguous upper bounds. They
// do not replace semantic model evaluation: exact source presence is necessary,
// but responsibilities, geography and applicability still require interpretation.
function qualificationOnly(value: string): boolean {
  return /licen[sc]e|certification|credential|degree|education|bachelor|master|doctorate|Ph\.?D|years? of .*experience/i.test(value) &&
    !/lead|manage|deliver|deploy|oversee|transform|operate|responsibilit|develop|build|design|research/i.test(value);
}
function isUncertaintyGap(value: string): boolean {
  // Gaps explain uncertainty. They must not reinstate a discarded exclusion
  // or invent an exception to a hard constraint. The original proposal is not
  // authoritative when validation changes its outcome.
  if (/all (?:hard )?exclu(?:des|sions).{0,30}(?:pass|clear)|(?:none|not) needed for (?:this|the) lane|decisive.{0,40}exclu(?:de|sion)/i.test(value)) return false;
  return /unknown|uncertain|unconfirmed|unavailable|undisclosed|missing|incomplete|unclear|ambigu|contradict|conflict|inconsisten|omitt|truncat|unverified|not (?:establish|provid|suppl|retain|observ)|cannot (?:establish|confirm|determine|verify)|no .*profile/i.test(value);
}
