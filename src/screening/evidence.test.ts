import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, candidateCriteriaVersion, candidatePolicyHash } from "../config/candidate";
import { createPostingSnapshot as rawCreatePostingSnapshot } from "./snapshot";
import { anchorEvidence, validateScreeningDecision } from "../discovery/evidence";
import { CHICAGO_OPERATIONS, UK_REVIEW } from "../../tests/fixtures/candidates";
import { completePosting, fact, proposal } from "../../tests/fixtures/policy-postings";
import type { CandidatePolicy } from "../config/types";
const runtime = () => loadRuntimeConfig(CHICAGO_OPERATIONS);
async function withPolicy(patch: Partial<CandidatePolicy>) {
  const candidate = structuredClone(CHICAGO_OPERATIONS);
  candidate.policy = { ...candidate.policy, ...patch };
  candidate.approval.policySha256 = await candidatePolicyHash(candidate.policy);
  candidate.approval.configSha256 = await candidateCriteriaVersion(candidate);
  return loadRuntimeConfig(candidate);
}

describe("synthetic retained evidence regressions", () => {
  it("rescues typography and wrong-field quotes into exact posting offsets", async () => {
    const snapshot = await createPostingSnapshot(completePosting({ description: "Lead operations and improve workflows. Bachelor's degree required." }));
    const anchors = anchorEvidence("qualification", "location", "BACHELOR’S   degree required.", snapshot)!;
    expect(anchors).toEqual([{ sourceField: "description", excerpt: "Bachelor's degree required.", start: 39, end: 66, sourceUrl: snapshot.job.url }]);
    expect(anchorEvidence("location", "description", '"location":"Chicago, IL"', snapshot)?.[0].sourceField).toBe("location");
  });
  it("drops unanchored or incorrectly bound decisive quotes", async () => {
    const snapshot = await createPostingSnapshot(completePosting(), "applied AI");
    for (const binding of [{ excerpt: "Invented responsibilities" }, { snapshotId: "wrong" }, { start: 1 }, { sourceUrl: "https://wrong.example/job" }]) {
      const raw = proposal();
      Object.assign(raw.evidence[0], binding);
      const checked = validateScreeningDecision(raw, snapshot, await runtime());
      expect(checked.state).toBe("needs_review");
      expect(checked.evidence.filter(f => f.field === "function")).toHaveLength(0);
    }
  });
  it("rejects omission markers as evidence and prevents absence conclusions from truncated bodies", async () => {
    const job = completePosting({ description: "Lead operations. [snapshot text omitted] Unrelated duties." });
    const snapshot = await createPostingSnapshot(job);
    expect(anchorEvidence("function", "description", "[snapshot text omitted]", snapshot)).toBeNull();
    const raw = { ...proposal(), state: "no_match", lane: null, evidence: [fact("function", "description", "Unrelated duties.")] };
    expect(validateScreeningDecision(raw, snapshot, await runtime()).state).toBe("needs_review");
  });
  it("preserves distinct unconfirmed qualifications without rejecting a supported function", async () => {
    const description = "Lead operations and improve workflows. A license is required. Degree or equivalent experience is required.";
    const raw = proposal(null, [fact("qualification", "description", "A license is required."), fact("qualification", "description", "Degree or equivalent experience is required.")]);
    const checked = validateScreeningDecision(raw, await createPostingSnapshot(completePosting({ description })), await runtime());
    expect(checked.state).toBe("match");
    expect(checked.qualificationWarnings).toEqual(["A license is required.", "Degree or equivalent experience is required."]);
  });
  it("rejects malformed positives rather than salvaging an incomplete contract", async () => {
    const snapshot = await createPostingSnapshot(completePosting());
    expect(() => validateScreeningDecision({ match: true }, snapshot, {} as never)).toThrow();
    expect(() => validateScreeningDecision({ ...proposal(), reason: "" }, snapshot, { candidate: CHICAGO_OPERATIONS, criteriaVersion: "synthetic" })).toThrow(/structure/);
  });
  it("does not accept a conflicting location rejection even with an exact outside-place quote", async () => {
    const job = completePosting({ location: "Remote - US", description: "Lead operations. Must attend the Boston office weekly." });
    const raw = { state: "no_match", lane: null, hardExclude: "location", reason: "Boston office.", gaps: [], evidence: [fact("location", "description", "Must attend the Boston office weekly.")] };
    expect(validateScreeningDecision(raw, await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
  it("respects allowed contract employment instead of a full-time-only default", async () => {
    const config = await withPolicy({ employmentTypes: ["contract"] });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ employmentType: "contract" })), config).state).toBe("match");
    const raw = proposal("employment", [fact("employment", "employmentType", "contract")]);
    expect(validateScreeningDecision(raw, await createPostingSnapshot(completePosting({ employmentType: "contract" })), config).state).toBe("needs_review");
  });
  it.each(["allow", "review", "exclude_active"] as const)("applies clearance mode %s to positive and negative model proposals", async clearance => {
    const config = await withPolicy({ clearance });
    const excerpt = "Must already hold active clearance at application.";
    const snapshot = await createPostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${excerpt}` }));
    expect(validateScreeningDecision(proposal(), snapshot, config).state).toBe(clearance === "allow" ? "match" : "needs_review");
    expect(validateScreeningDecision(proposal("clearance", [fact("clearance", "description", excerpt)]), snapshot, config).state).toBe(clearance === "exclude_active" ? "no_match" : "needs_review");
  });
  it("keeps obtain-after-start clearance distinct from active-at-application requirements", async () => {
    const excerpt = "Must be eligible to obtain clearance after starting.";
    const snapshot = await createPostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${excerpt}` }));
    expect(validateScreeningDecision(proposal("clearance", [fact("clearance", "description", excerpt)]), snapshot, await withPolicy({ clearance: "exclude_active" })).state).toBe("needs_review");
  });
  it("supports a nullable floor and comparable non-USD pay without claiming conversion", async () => {
    const config = await loadRuntimeConfig(UK_REVIEW);
    const compensation = "Annual base salary GBP 20,000 - GBP 30,000";
    const snapshot = await createPostingSnapshot(completePosting({ compensation }));
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), snapshot, config).state).toBe("needs_review");
  });
  it("does not reject a partial field or a higher alternative band", async () => {
    const compensation = "Annual base salary USD 70,000 - USD 90,000";
    const job = completePosting({ compensation, description: "Lead operations. Annual base salary USD 110,000 - USD 120,000 for this office." });
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
    job.contentProvenance!.description.truncated = true;
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("explicit unknowns cannot become confident positive decisions", () => {
  it("reviews unknown or conflicting employment", async () => {
    for (const employmentType of [null, "Full-time or contract", "Unknown"] as const) {
      expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ employmentType })), await runtime()).state).toBe("needs_review");
    }
  });
  it("reviews required clearance with ambiguous timing under review/exclude modes", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. Security clearance is required." });
    for (const clearance of ["review", "exclude_active"] as const) {
      expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await withPolicy({ clearance })).state).toBe("needs_review");
    }
  });
  it("does not let a separate ability-to-obtain clause hide an active requirement", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. Must already hold active clearance at application. Other assignments offer ability to obtain clearance." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await withPolicy({ clearance: "exclude_active" })).state).toBe("needs_review");
  });
  it("preserves noncomparable pay as unknown in gaps on an otherwise possible match", async () => {
    const config = await runtime();
    const job = completePosting({ compensation: "Base pay USD 40 - USD 50 hourly" });
    const checked = validateScreeningDecision(proposal(), await createPostingSnapshot(job), config);
    expect(checked.state).toBe("match");
    expect(checked.gaps.join(" ")).toMatch(/compensation.*(?:unknown|comparab)/);
  });
  it("requires every disclosed pay band to be comparable before using a lower ceiling", async () => {
    const compensation = "Annual base salary USD 70,000 - USD 90,000";
    const job = completePosting({ compensation, description: "Lead operations. Base salary USD 80 - USD 100 per hour for an alternative office." });
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("pay and employment evidence conflicts", () => {
  it("does not mistake a lower range for the ceiling when a higher fixed amount is also offered", async () => {
    const compensation = "Annual base salary USD 70,000 - USD 90,000 or USD 120,000";
    const job = completePosting({ compensation });
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
  it("does not treat annual non-base salary as comparable base pay", async () => {
    const compensation = "Annual salary USD 70,000 - USD 90,000";
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(completePosting({ compensation })), await runtime()).state).toBe("needs_review");
  });
  it("holds a contract exclusion when structured employment explicitly says full-time", async () => {
    const job = completePosting({ description: "Lead operations. This role is contract employment." });
    expect(validateScreeningDecision(proposal("employment", [fact("employment", "description", "This role is contract employment.")]), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("unparsed pay text is not a known ceiling", () => {
  it.each(["Annual base salary USD 70,000 - unknown", "Annual base salary USD 70,000 - USD 90,000 or 120000 for another location"])("holds an incomplete band or unparsed alternative: %s", compensation => {
    return runtime().then(async config => {
      expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(completePosting({ compensation })), config).state).toBe("needs_review");
    });
  });
});

describe("review repair I1 fixed alternatives", () => {
  it.each(["Annual base salary USD 70,000 or 120000 for another location", `Annual base salary USD 70,000 or USD ${"9".repeat(310)}`])("cannot use a partial or nonfinite fixed alternative as a ceiling: %s", async compensation => {
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), await createPostingSnapshot(completePosting({ compensation })), await runtime()).state).toBe("needs_review");
  });
});

describe("review repair I2 observed employment conflicts", () => {
  it.each(["full-time", null])("does not let structured %s or a selected allowed excerpt hide mixed body employment", async employmentType => {
    const description = "Lead operations and improve workflows. This role is full-time or contract employment.";
    const raw = proposal(null, [fact("employment", "description", "full-time")]);
    expect(validateScreeningDecision(raw, await createPostingSnapshot(completePosting({ employmentType, description })), await runtime()).state).toBe("needs_review");
  });
  it("keeps a structured allowed type when body arrangement evidence is absent", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. This role coordinates projects and contract negotiations." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("match");
  });
  it("holds an observed unsupported body arrangement alongside allowed metadata", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. This role is seasonal employment." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("review repair I3 compound clearance scope", () => {
  it.each(["review", "exclude_active"] as const)("cannot accept mandatory active plus later clearance under %s", async clearance => {
    const description = "Lead operations and improve workflows. Must already hold active clearance at application and be eligible to obtain additional clearance after starting.";
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ description })), await withPolicy({ clearance })).state).toBe("needs_review");
  });
  it("reviews unsupported disjunction rather than assuming every active mention is mandatory", async () => {
    const excerpt = "Must already hold active clearance at application or be eligible to obtain clearance after starting.";
    const job = completePosting({ description: `Lead operations and improve workflows. ${excerpt}` });
    expect(validateScreeningDecision(proposal("clearance", [fact("clearance", "description", excerpt)]), await createPostingSnapshot(job), await withPolicy({ clearance: "exclude_active" })).state).toBe("needs_review");
  });
  it("does not turn a negated active requirement into an exclusion", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. No active clearance is required at application and employees may obtain additional clearance after starting." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await withPolicy({ clearance: "exclude_active" })).state).toBe("match");
  });
});

describe("review repair M1 concrete outside commute exclusion", () => {
  it("accepts a fully observed Springfield office exclusion using its exact anchored quote", async () => {
    const job = completePosting({ location: "Springfield, IL", locationMetadata: { workplaceType: "OnSite", secondaryLocations: [], coverageGaps: [], sourceFields: ["synthetic"] } });
    const raw = { state: "no_match", lane: null, hardExclude: "location", reason: "Outside commute.", gaps: [], evidence: [fact("location", "location", job.location)] };
    const checked = validateScreeningDecision(raw, await createPostingSnapshot(job), await runtime());
    expect(checked).toMatchObject({ state: "no_match", hardExclude: "location" });
    expect(checked.evidence[0]).toMatchObject({ excerpt: "Springfield, IL", start: 0, end: 15 });
  });
});

describe("review repair I3 unsupported combined timing", () => {
  it("holds active-at-application plus later-clearance wording when conjunction scope is unsupported", async () => {
    const description = "Lead operations and improve workflows. Must already hold active clearance at application with ability to obtain additional clearance after starting.";
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ description })), await runtime()).state).toBe("needs_review");
  });
});

describe("review repair I2 explicitly configured body arrangement", () => {
  it("distinguishes unsupported arrangements from a candidate's explicit allowed type", async () => {
    const config = await withPolicy({ employmentTypes: ["seasonal"] });
    const job = completePosting({ employmentType: "seasonal", description: "Lead operations and improve workflows. This role is seasonal employment." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), config).state).toBe("match");
  });
});

describe("round2 I2 unsupported employment alternatives", () => {
  it.each(["This role is full-time or seasonal employment.", "This role is full-time or an unspecified arrangement."])("retains unsupported alternatives alongside an allowed type: %s", async assertion => {
    const job = completePosting({ description: `Lead operations and improve workflows. ${assertion}` });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("round2 N1 uncertain role employment assertions", () => {
  it.each(["full-time", null])("does not discard an arrangement assertion with structured %s", async employmentType => {
    const job = completePosting({ employmentType, description: "Lead operations and improve workflows. This role has a contract arrangement." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
  it("holds an unrecognized role employment assertion without relying on approved tokens", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. This role follows an unusual employment arrangement." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
  it("retains incidental contract-negotiation responsibilities as absence", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. This role is responsible for contract negotiations." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("match");
  });
});

describe("round2 N1 employment label boundary", () => {
  it("keeps conflicting explicit employment labels observable", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. Employment type: full-time or contract." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

describe("round2 N2 selected office cannot hide remote alternative", () => {
  it("holds an anchored outside-office exclusion while the body offers remote work", async () => {
    const location = { ...CHICAGO_OPERATIONS.policy.location, allowOnsite: false, allowHybrid: false };
    const job = completePosting({ location: "Springfield, IL", locationMetadata: { workplaceType: "OnSite", secondaryLocations: [], coverageGaps: [], sourceFields: ["synthetic"] }, description: "Lead operations. This role is onsite in our Springfield, IL office or fully remote within the US." });
    const raw = { state: "no_match", lane: null, hardExclude: "location", reason: "Outside commute.", gaps: [], evidence: [fact("location", "location", job.location)] };
    expect(validateScreeningDecision(raw, await createPostingSnapshot(job), await withPolicy({ location })).state).toBe("needs_review");
  });
});

describe("round2 N3 selected active quote cannot hide contradiction", () => {
  it.each([", but active clearance is not required at application.", ". No active clearance is required at application.", ". No clearance is required for this role."])("reconciles the whole posting before accepting a clearance exclusion: %s", suffix => {
    return withPolicy({ clearance: "exclude_active" }).then(async config => {
      const active = "Must already hold active clearance at application";
      const job = completePosting({ description: `Lead operations and improve workflows. ${active}${suffix}` });
      const checked = validateScreeningDecision(proposal("clearance", [fact("clearance", "description", active)]), await createPostingSnapshot(job), config);
      expect(checked.state).toBe("needs_review");
      expect(checked.evidence[0].snapshotId).toBeTruthy();
    });
  });
});

describe("round2 I2 observed type independent of approval", () => {
  it("observes an unsupported role employment type even without an employment suffix", async () => {
    const job = completePosting({ description: "Lead operations and improve workflows. This role is seasonal." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job), await runtime()).state).toBe("needs_review");
  });
});

const createPostingSnapshot: typeof rawCreatePostingSnapshot = (job,category="applied AI") => rawCreatePostingSnapshot(job,category);

// A quoted string anchors a source; it does not validate a model's category label.
describe.each(["A", "B"] as const)("category provenance for lane %s", lane => {
  const configured = (companyCategories: CandidatePolicy["functionLanes"][number]["companyCategories"] = ["applied AI"]) =>
    withPolicy({ functionLanes: [{ id: lane, description: "Synthetic operations", companyCategories }] });
  const proposed = (sourceField: string, excerpt: string, value: string) => ({ ...proposal(), lane,
    evidence: [...proposal().evidence, { field: "company_category", sourceField, excerpt, value }] });
  it("does not relabel an authoritative outside category through a contradictory model value", async () => {
    const snapshot = await rawCreatePostingSnapshot(completePosting(), "frontier AI");
    const result = validateScreeningDecision(proposed("companyCategory", "frontier AI", "applied AI"), snapshot, await configured());
    expect(result.state).toBe("needs_review");
    expect(result.evidence.some(e => e.field === "company_category" && e.value === "applied AI")).toBe(false);
  });
  it.each([
    "Lead operations and improve workflows.",
    "We work with applied AI companies.",
    "We are not an applied AI company.",
    "We are an applied AI company?",
    "Our client says: We are an applied AI company.",
  ])("does not classify the employer from an arbitrary or unsupported quote: %s", async excerpt => {
    const snapshot = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${excerpt}` }));
    const result = validateScreeningDecision(proposed("description", excerpt, "applied AI"), snapshot, await configured());
    expect(result.state).toBe("needs_review");
    expect(result.evidence.filter(e => e.field === "company_category")).toHaveLength(0);
  });
  it("does not rescue a positive substring of a negated or attributed statement", async () => {
    for (const sentence of ["It is false that we are an applied AI company.", "Our client says: we are an applied AI company."]) {
      const snapshot = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${sentence}` }));
      expect(validateScreeningDecision(proposed("description", "we are an applied AI company", "applied AI"), snapshot, await configured()).state).toBe("needs_review");
    }
  });
  it.each(["We are an applied AI company.", "We are an\napplied AI company."])("preserves a complete employer self-statement and its source binding: %s", async excerpt => {
    const snapshot = await rawCreatePostingSnapshot(completePosting({ description: excerpt }));
    const result = validateScreeningDecision(proposed("description", excerpt, "applied AI"), snapshot, await configured());
    // Category support alone supplies no responsibilities: the function gap remains.
    expect(result.state).toBe("needs_review");
    expect(result.evidence.find(e => e.field === "company_category")).toMatchObject({ value: "applied AI", excerpt, sourceField: "description", sourceUrl: snapshot.job.url, snapshotId: snapshot.id });
  });
  it.each([true, null])("does not infer complete category context when description truncation is %s", async truncated => {
    const excerpt = "We are an applied AI company.";
    const job = completePosting({ description: excerpt });
    job.contentProvenance!.description = { ...job.contentProvenance!.description, truncated, originalChars: truncated ? 500 : null };
    const snapshot = await rawCreatePostingSnapshot(job);
    const result = validateScreeningDecision(proposed("description", excerpt, "applied AI"), snapshot, await configured());
    expect(result.evidence.filter(e => e.field === "company_category")).toHaveLength(0);
  });
  it.each([
    "Our client says:\nWe are an applied AI company.",
    "It is false that\nWe are an applied AI company.",
    "Our client says:\r\nWe are an applied AI company.",
    "It is false that\tWe are an applied AI company.",
    "Other context.\nWe are an applied AI company.",
    "We are an applied AI company.\nOther context.",
  ])("keeps the complete source context when evaluating %s", async description => {
    const snapshot = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${description}` }));
    const result = validateScreeningDecision(proposed("description", "We are an applied AI company.", "applied AI"), snapshot, await configured());
    expect(result.state).toBe("needs_review");
    expect(result.evidence.filter(e => e.field === "company_category")).toHaveLength(0);
  });
  it("holds a contradictory label, conflicting self-descriptions and an attempt to override configuration", async () => {
    const excerpt = "We are a frontier AI company.";
    const wrong = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${excerpt}` }));
    expect(validateScreeningDecision(proposed("description", excerpt, "applied AI"), wrong, await configured()).state).toBe("needs_review");
    const allowed = "We are an applied AI company.";
    const negated = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${allowed} We are not an applied AI company.` }));
    expect(validateScreeningDecision(proposed("description", allowed, "applied AI"), negated, await configured()).state).toBe("needs_review");
    const conflict = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${allowed} ${excerpt}` }));
    expect(validateScreeningDecision(proposed("description", allowed, "applied AI"), conflict, await configured()).state).toBe("needs_review");
    const authoritative = await rawCreatePostingSnapshot(completePosting({ description: `Lead operations and improve workflows. ${allowed}` }), "frontier AI");
    expect(validateScreeningDecision(proposed("description", allowed, "applied AI"), authoritative, await configured()).state).toBe("needs_review");
  });
  it("uses the authoritative allowed category without retaining a false model label", async () => {
    const snapshot = await rawCreatePostingSnapshot(completePosting(), "applied AI");
    const result = validateScreeningDecision(proposed("companyCategory", "applied AI", "frontier AI"), snapshot, await configured());
    expect(result.state).toBe("match");
    expect(result.evidence.filter(e => e.field === "company_category")).toEqual([expect.objectContaining({ value: "applied AI", sourceField: "companyCategory", sourceUrl: "configuration:fixed-sources" })]);
  });
  it("leaves an empty category list unrestricted while dropping unsupported facts", async () => {
    const snapshot = await rawCreatePostingSnapshot(completePosting());
    const result = validateScreeningDecision(proposed("description", snapshot.job.description!, "applied AI"), snapshot, await configured([]));
    expect(result.state).toBe("match");
    expect(result.evidence.filter(e => e.field === "company_category")).toHaveLength(0);
  });
});
