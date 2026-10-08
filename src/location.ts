import type { CandidatePolicy } from "./config/types";
import type { Verdict } from "./criteria";
import type { NormalizedJob } from "./sources";

export type LocationEligibility = { state: "eligible" | "ineligible" | "review"; reason: string; evidence: string[] };
export class LocationEligibilityError extends Error {}
const normalized = (text: string) => text.toLowerCase().replace(/u\.s\.(?:a\.)?/g, "us").replace(/d\.c\./g, "dc").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const regionNames = "uk|united kingdom|canada|emea|europe|apac|australia|india|germany|france|ireland|united states|us|usa";
const remoteRegion = new RegExp(`^(?:${regionNames})$`);
const cityNames = "san francisco|new york(?: city)?|chicago|seattle|austin|boston|los angeles|denver|atlanta|baltimore|london|toronto|barcelona|budapest|bengaluru|manila|istanbul";
const elsewhere = new RegExp(`^(?:${cityNames})(?:, [a-z ]+)?$`);
const countryAliases: Record<string, string[]> = { US: ["us", "usa", "united states", "united states of america", "north america"], GB: ["gb", "uk", "united kingdom"], CA: ["ca", "canada"], AU: ["au", "australia"], DE: ["de", "germany"], FR: ["fr", "france"], IE: ["ie", "ireland"] };
const subdivisionNames: Record<string, string> = { IL: "illinois", MA: "massachusetts", MD: "maryland", VA: "virginia", CA: "california", NY: "new york", TX: "texas", WA: "washington", ENG: "england", SCT: "scotland", WLS: "wales", NIR: "northern ireland" };
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function geography(policy: CandidatePolicy) {
  const aliases = countryAliases[policy.location.countryCode] ?? [policy.location.countryCode.toLowerCase()];
  const subdivision = policy.location.subdivisionCode?.split("-").slice(1).join("-").toLowerCase();
  const subdivisions = subdivision ? [subdivision, subdivisionNames[subdivision.toUpperCase()]].filter(Boolean) : [];
  const allowedRegion = new RegExp(`^(?:${[...aliases, ...subdivisions].map(escapePattern).join("|")})$`);
  const configured = policy.location.commuteLocations.map(normalized);
  const variants = configured.flatMap(label => {
    const expanded = label.replace(/, ([a-z]{2})$/, (_, code: string) => `, ${subdivisionNames[code.toUpperCase()] ?? code}`);
    return [label, expanded, ...aliases.map(alias => `${label}, ${alias}`), label.replace(/, /g, " - ")];
  });
  const local = new RegExp(`^(?:${variants.map(escapePattern).join("|") || "(?!)"})$`);
  const workdayLocal = new RegExp(`^(?:${aliases.map(escapePattern).join("|")}) - (?:${configured.map(label => escapePattern(label.replace(/, /g, " - "))).join("|") || "(?!)"})$`);
  const localAlternative = new RegExp(`(?:^|[, ])(?:${variants.map(escapePattern).join("|") || "(?!)"})(?=$|[, ])`);
  return { allowedRegion, local, workdayLocal, localAlternative, aliases, subdivisions };
}
// "Based on" usually means "on the basis of" (pay, performance, analysis).
// It stays location wording before a place-like object: "based on the West
// Coast", "based on client premises", "based on geographic location".
const basedOnBasis = /\bbased on (?!(?:the )?(?:[a-z]+ )?coast\b|(?:client |customer )?(?:premises|sites?|campus)\b|(?:your |the |a )?(?:geograph\w*|location|residence)\b)/g;

// Scope words around a country do not narrow it: "Remote within the U.S.",
// "US - Remote (Any location)", "Remote (Anywhere in the US)", "US-based remote".
function countryWide(region: string, policy: CandidatePolicy): boolean {
  const scope = region.replace(/\b(?:anywhere|any location|within|in|across|throughout|the|only|based)\b/g, " ").replace(/\s+/g, " ").trim();
  return geography(policy).allowedRegion.test(scope);
}
// Provider labels list alternatives with these marks, and "or" joins
// alternatives inside one label ("San Francisco, CA or Remote (USA)").
const officeSeparator = /\s*(?:\||;|\n|\s\/\s|\sor\s)\s*/;

type Place = { label: string; local: boolean; remoteEligible: boolean; remoteOther: boolean; knownOther: boolean };
function place(label: string, arrangement: string, policy: CandidatePolicy): Place {
  const value = normalized(label);
  const { local, workdayLocal } = geography(policy);
  // Only provider location labels enter this parser. Never mine arbitrary
  // company/travel prose for a familiar city name.
  const explicitlyRemote = /\bremote\b/.test(value) || arrangement === "remote";
  const region = value.replace(/\bremote\b/g, "").replace(/[(),\-]/g, " ").replace(/\s+/g, " ").trim();
  return { label, local: local.test(value) || workdayLocal.test(value), remoteEligible: explicitlyRemote && countryWide(region, policy),
    remoteOther: explicitlyRemote && (remoteRegion.test(region) || new RegExp(`^(?:${usStates})$`).test(region) || elsewhere.test(region) || cityState.test(label) && !/\b(?:except|excluding|approval|and|or|not)\b/.test(region)) && !countryWide(region, policy), knownOther: elsewhere.test(value) || cityState.test(label) };
}

export function resolveLocationEligibility(job: NormalizedJob, policy: CandidatePolicy): LocationEligibility {
  const { local, localAlternative, aliases } = geography(policy);
  const metadata = job.locationMetadata;
  const arrangement = normalized(metadata?.workplaceType ?? "").replace(/[ -]/g, "");
  const offices = [job.location, ...(metadata?.secondaryLocations ?? [])]
    .flatMap(label => label.split(officeSeparator)).filter(Boolean).map(label => place(label, arrangement, policy));
  const evidence = offices.map(item => item.label);
  const result = (state: LocationEligibility["state"], reason: string): LocationEligibility => ({ state, reason, evidence });
  const coverage = job.contentProvenance;
  const complete = !!job.description?.trim() && coverage?.description.provided === true &&
    coverage.description.truncated === false && !coverage.coverageGaps.some(gap =>
      !gap.startsWith("compensation:") && !gap.startsWith("baseSalary:")) &&
    !/\[(?:middle of posting|snapshot text) omitted\]/i.test(job.description);
  const body = normalized(job.description ?? "");
  const clauses = (job.description ?? "").replace(/u\.s\.(?:a\.)?/gi, "US").replace(/d\.c\./gi, "DC")
    .split(/(?<=[.!?;])\s+|\n+/).map(normalized);
  // A narrowly recognized role-specific allowance can override optional Hybrid
  // hubs. Unrecognized prose remains reviewable; isRemote is never proof.
  const remoteAllowance = clauses.find(clause =>
    new RegExp(`^(?:location: *)?(?:this|the) (?:role|position|job) (?:can|may) be (?:based )?remote(?:ly)? (?:anywhere in|from anywhere in|within|in|across) (?:the )?(?:${aliases.map(escapePattern).join("|")})(?=[.,; ]|$)`).test(clause));
  // This branch aligns complete, explicitly unrestricted role evidence with
  // the existing policy. A provider flag alone never reaches it.
  const unscopedPrefix = /^(?:location: *)?(?:this|the) (?:role|position|job) is (?:fully|entirely|completely|100%) remote(?=[.!?;]|$| and\b)/;
  const unscopedAllowance = clauses.find(clause => unscopedPrefix.test(clause));
  const unscopedSource = arrangement === "remote" && offices.length > 0 &&
    offices.every(item => normalized(item.label) === "remote");
  const unscopedContext = clauses.find(clause => {
    const rest = clause.replace(unscopedPrefix, "");
    // A bare section heading adds no scope. Any populated location heading,
    // permission limit or office/residency wording remains unresolved here.
    // This path proves an unrestricted allowance; it does not guess whether
    // an unrecognized condition would ultimately exclude the candidate.
    if (/^location:?$/.test(rest)) return false;
    return /\b(?:locations?|offices?|residen\w*|restricted|limited)\b/.test(rest) ||
      /\b(?:not (?:open|available|eligible|permitted|allowed)|only (?:open|available|eligible|permitted|allowed))\b/.test(rest) ||
      /\bhome base\b/.test(rest) ||
      /\b(?:based|located|live|living|residing|residence) (?:in|within|near|at)\b/.test(rest) ||
      /\b(?:work(?:ing|s)?|employ(?:ed|ment)?) (?:remotely )?(?:in|from|within)\b/.test(rest) ||
      /\b(?:candidates|applicants|employees)\b.{0,60}\b(?:in|from|within)\b/.test(rest) ||
      /\b(?:remote eligibility|employment location|eligible (?:countries|states)|geographic|geographical|hybrid|on[ -]?site|relocat\w*|commut\w*)\b/.test(rest) ||
      /\bremote(?:ly)? (?:in|from|within|across|outside|except)\b/.test(rest) ||
      /\boffice attendance\b/.test(rest) ||
      remoteRegion.test(rest.replace(/[.!?;]$/, "")) || elsewhere.test(rest.replace(/[.!?;]$/, ""));
  });
  const roleOffices = clauses.flatMap(clause => {
    const match = /^(?:location: *)?(?:this|the) (?:(hybrid|onsite|on[- ]site) )?(?:role|position|job) is based in (?:one of )?(?:our |the )?([^.!?]{1,400}?) offices?\b/.exec(clause);
    // "and" may mean two mandatory workplaces, whereas "or" expresses an
    // alternative. Unknown wording is held rather than inferred.
    return match && !/\band\b/.test(match[2]) ? [{ label: match[2], arrangement: (match[1] ?? "").replace(/[ -]/g, "") }] : [];
  });
  const bodyLocal = roleOffices.find(item => localAlternative.test(item.label));
  const bodyWorkplaceClaims = clauses.flatMap(clause => {
    const prefix = /^(?:location: *)?(?:this|the) (hybrid|onsite|on[- ]site) (?:role|position|job)\b/.exec(clause);
    const assertion = /^(?:location: *)?(?:this|the) (?:role|position|job) (?:is|will be|must be|requires) (?:fully )?(hybrid|onsite|on[- ]site)\b/.exec(clause);
    const type = prefix?.[1] ?? assertion?.[1];
    return type ? [{ type: type.replace(/[ -]/g, ""), ambiguous: /\b(?:or|either|may|can|optional|alternativ\w*|if|unless|not)\b/.test(clause) }] : [];
  });
  const bodyArrangements = [...new Set(bodyWorkplaceClaims.map(claim => claim.type))];
  const mandatoryLocalOffice = (clause: string) => {
    const match = /\b(?:at|in|from) (?:our |the )?(.{1,150}?) office\b/.exec(clause);
    return !!match && local.test(match[1]) && (clause.match(/\boffices?\b/g)?.length ?? 0) === 1 && !/\band\b/.test(clause);
  };
  // These phrases use geographic-looking words for a different purpose. Mask
  // only the non-geographic phrase, never the rest of the sentence: a genuine
  // residency/office requirement in the same sentence must still be held.
  const restrictionClauses = clauses.map(original => ({ original, text: original
    .replace(/\b(proficiency (?:with|in)|experience using) microsoft office\b/g, "$1 software")
    .replace(/\bmicrosoft office proficiency\b/g, "software proficiency")
    .replace(/\b(?:us|usa|united states) permanent resident\b/g, "US immigration status")
    .replace(basedOnBasis, "depending on ")
    .replace(/\bgo-live\b/g, "launch")
    .replace(/\bconsiders qualified applicants with arrest and conviction records, as required by law\b/g,
      "considers qualified applicants with arrest and conviction records") }));
  const mandatoryOffice = (text: string) => {
    // Optional arrangements do not make a separate travel obligation into an
    // office obligation. Retain any office/residency terms after "requires".
    const clause = text.replace(/\b(?:may|can) be remote or hybrid(?= and requires (?:regular |occasional |periodic )?travel\b)/g, "");
    // A countrywide remote label does not override a same-sentence mandatory
    // presence in a named place outside the commute region. Immigration-status
    // wording may precede this clause and is masked separately above.
    const elsewhereRequired = new RegExp(`\\b(?:must|(?:required|expected) to)(?: be| work| live| reside| be located| be based) in (?:${usStates}|${cityNames}|${regionNames})\\b`).test(clause);
    return (
    elsewhereRequired ||
    (/\b(?:must|required|requires|expected)\b/.test(clause) || /^office attendance:/.test(clause)) &&
    /\b(?:office|on[ -]?site|hybrid|relocat\w*|resid\w*|commut\w*|located|live|living|based)\b/.test(clause) &&
    !mandatoryLocalOffice(clause));
  };
  const restrictedPermission = (clause: string) =>
    !/^(?:location: *)?remote - (?:us|usa|united states) only[.!?]?$/.test(clause) &&
    (/\b(?:remote\w*|resid\w*|relocat\w*|work(?:ing)? from|based|located|live|living)\b/.test(clause) ||
      /\b(?:hire|hiring|employ|candidates|applicants)\b.{0,100}\b(?:in|from|within)\b/.test(clause)) &&
    /\b(?:except|excluding|only|cannot|unable|not (?:available|permitted|eligible|allowed)|approval|until)\b/.test(clause);
  const restriction = restrictionClauses.find(({ text }) => mandatoryOffice(text) || restrictedPermission(text));
  const strongPositive = offices.some(item => item.local || item.remoteEligible) || !!remoteAllowance || !!bodyLocal || (unscopedSource && !!unscopedAllowance);
  if (strongPositive && restriction) {
    evidence.push(restriction.original);
    return result("review", `Location eligibility needs review: remote/local evidence coexists with a role-location restriction. Source clause: ${restriction.original.slice(0, 200)}`);
  }
  if (metadata?.coverageGaps.length || (arrangement && !["remote", "hybrid", "onsite"].includes(arrangement))) {
    return result("review", "Location eligibility needs review: source location coverage or workplace arrangement is unresolved.");
  }
  if (bodyWorkplaceClaims.some(claim => claim.ambiguous))
    return result("review", "Location eligibility needs review: role workplace alternatives or conditions do not establish one mandatory arrangement.");
  if (bodyArrangements.length > 1 || arrangement && bodyArrangements.some(type => type !== arrangement) || remoteAllowance && bodyArrangements.length)
    return result("review", "Location eligibility needs review: role-specific office workplace evidence conflicts with another arrangement.");
  const resolvedArrangement = arrangement || bodyArrangements[0] || "";
  if ((resolvedArrangement === "remote" && !policy.location.allowRemote) || (resolvedArrangement === "hybrid" && !policy.location.allowHybrid) || (resolvedArrangement === "onsite" && !policy.location.allowOnsite))
    return result(complete ? "ineligible" : "review", "The source workplace arrangement is outside the approved policy.");
  if ((!arrangement || arrangement === "remote") && (remoteAllowance || offices.some(item => item.remoteEligible) || unscopedSource) && !policy.location.allowRemote)
    return result("review", "Remote work is outside the approved policy; an allowed office arrangement is not established.");
  if (!resolvedArrangement && (bodyLocal || offices.some(item => item.local)) && !(policy.location.allowOnsite && policy.location.allowHybrid))
    return result("review", "The local office's work arrangement is unknown under the approved policy.");
  if (remoteAllowance) {
    evidence.push(remoteAllowance);
    return complete
      ? result("eligible", "The posting explicitly allows this role to be performed remotely in the approved country.")
      : result("review", "Location eligibility needs review: the remote exception's surrounding policy is incomplete.");
  }
  if (bodyLocal) {
    evidence.push(bodyLocal.label);
    return complete ? result("eligible", "The posting explicitly lists an approved commute office as a location for this role.")
      : result("review", "Location eligibility needs review: the role's office alternatives have incomplete surrounding context.");
  }
  if (offices.some(item => item.local)) return result("eligible", "A listed role location is in the approved commute region.");
  if (offices.some(item => item.remoteEligible)) {
    if (arrangement === "hybrid" || arrangement === "onsite") return result("review", "Location eligibility needs review: remote-US location conflicts with the workplace arrangement.");
    return result("eligible", "The structured role location explicitly permits remote work in the approved country/subdivision.");
  }
  if (unscopedSource && unscopedAllowance && complete && !unscopedContext) {
    evidence.push(unscopedAllowance);
    return result("eligible", "The complete posting explicitly makes this role fully remote with no stated geographic restriction.");
  }
  if (!complete) return result("review", "Location eligibility needs review: incomplete posting context cannot rule out an eligible alternative.");
  // Other remote/location wording may contain an exception this bounded parser
  // does not understand. Never turn that uncertainty into a permanent rejection.
  if (/\b(?:remote\w*|work(?:ing)? from home|location|relocat\w*|offices?|based|resid\w*|located)\b/.test(body.replace(basedOnBasis, "depending on ")) || roleOffices.length) {
    return result("review", "Location eligibility needs review: unrecognized remote or location conditions need assessment.");
  }
  if (offices.length && offices.every(item => item.remoteOther)) {
    return result("ineligible", "Every stated remote region is outside the approved country/subdivision.");
  }
  if (["hybrid", "onsite"].includes(arrangement) && offices.length && offices.every(item => item.knownOther || item.remoteOther)) {
    return result("ineligible", "The posting requires Hybrid/OnSite work and all listed offices are outside the approved commute region.");
  }
  return result("review", "Location eligibility needs review: no supported approved commute office or remote option was established.");
}

// Generic geographic recognition makes an outside-place quote concrete.
// Membership in the candidate's approved commute area is checked separately.
const usStates = "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|wisconsin|wyoming";
const placeWording = /\b(?:based|located|location|onsite|on-site|on site|in-office|in office|offices?|hubs?|headquarter\w*|campus|resid\w*|relocat\w*|commut\w*|hybrid|remote\w*)\b/;
// Recognized geographic labels are separate from candidate eligibility.
// Unfamiliar labels still require review.
const exclusionPlaces = "abu dhabi|uae|united arab emirates|singapore|hanoi|vietnam|northlake,? il|sydney|new south wales|milpitas|mumbai|gurugram|noida|col springs|colorado springs|wilmington,? de|de-wilmington|launceston|waterloo|halifax|montr[eé]al|ontario|qu[eé]bec|nova scotia|new brunswick|alberta|british columbia|manitoba|saskatchewan|newfoundland(?: and labrador)?|prince edward island|prague|ostrava|brno|cdmx|hørsholm";
const namedPlace = new RegExp(`\\b(?:${cityNames}|nyc|${regionNames}|spain|poland|portugal|${exclusionPlaces}|${usStates})\\b`);
const cityState = /\b[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+)*, (?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|WA|WV|WI|WY)\b/;

function officeSpans(text: string): { label: string; start: number; end: number }[] {
  const spans: { label: string; start: number; end: number }[] = [];
  let from = 0;
  for (const separator of text.matchAll(new RegExp(officeSeparator.source, "g"))) {
    spans.push({ label: text.slice(from, separator.index), start: from, end: separator.index! });
    from = separator.index! + separator[0].length;
  }
  spans.push({ label: text.slice(from), start: from, end: text.length });
  return spans.filter(span => span.label.trim());
}

function mentionsEligiblePlace(value: string, policy: CandidatePolicy): boolean {
  const places = policy.location.commuteLocations.map(label => normalized(label).split(",")[0]);
  return places.some(label => new RegExp(`(?:^|[^a-z])${escapePattern(label)}(?:$|[^a-z])`).test(value));
}
function labelOutside(label: string, arrangement: string, policy: CandidatePolicy): boolean {
  const value = normalized(label), where = place(label, arrangement, policy);
  // Only positive place evidence can support exclusion. Unknown bare labels
  // stay reviewable; residual arrangement or attendance words prove nothing.
  if (/\b(?:unspecified|unknown|tbd)\b/.test(value)) return false;
  return (namedPlace.test(value) || cityState.test(label)) &&
    !where.local && !where.remoteEligible && !mentionsEligiblePlace(value, policy);
}

// Evidence for a location exclusion must name somewhere concrete outside the
// eligible area. Office labels are read like the offices above, using every
// label the quote touches; posting prose counts only when location wording
// names a recognized place. Arrangement words alone ("Hybrid", "#LI-Hybrid",
// "Remote") never qualify.
export function locationFactNamesPlaceOutside(fact: { sourceField: string; excerpt: string; start: number; end: number }, job: NormalizedJob, policy: CandidatePolicy): boolean {
  if (fact.sourceField === "description") {
    const value = normalized(fact.excerpt);
    return placeWording.test(value) && (namedPlace.test(value) || cityState.test(fact.excerpt)) && !mentionsEligiblePlace(value, policy) && !place(fact.excerpt, "", policy).remoteEligible;
  }
  const text = fact.sourceField === "location" ? job.location
    : fact.sourceField === "secondaryLocations" ? (job.locationMetadata?.secondaryLocations ?? []).join("\n") : "";
  const arrangement = normalized(job.locationMetadata?.workplaceType ?? "").replace(/[ -]/g, "");
  const touched = officeSpans(text).filter(span => span.start < fact.end && span.end > fact.start);
  return touched.length > 0 && touched.every(span => labelOutside(span.label, arrangement, policy));
}

export function enforceLocationVerdict(job: NormalizedJob, verdict: Verdict, policy: CandidatePolicy): Verdict {
  if (!verdict.match && verdict.hard_exclude !== "4") return verdict;
  const location = resolveLocationEligibility(job, policy);
  if (!verdict.match && location.state !== "ineligible") throw new LocationEligibilityError("Model location exclusion is not established by approved policy");
  if (location.state === "eligible") return verdict;
  if (location.state === "review") throw new LocationEligibilityError(location.reason);
  return { match: false, hard_exclude: "4", lane: null, reason: location.reason };
}
