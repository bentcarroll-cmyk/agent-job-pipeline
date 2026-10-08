import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { validateScreeningDecision } from "../../src/discovery/evidence";
import { resolveLocationEligibility } from "../../src/location";
import { createPostingSnapshot as rawCreatePostingSnapshot } from "../../src/screening/snapshot";
import { CHICAGO_OPERATIONS, BOSTON_ENGINEERING, UK_REVIEW } from "../fixtures/candidates";
import { completePosting, proposal, fact } from "../fixtures/policy-postings";

describe("candidate policy rather than a default person's rules", () => {
  it("uses the approved salary floor and criteria version", async () => {
    const job = completePosting({ compensation: "Annual base salary USD 110,000 - USD 120,000" });
    const snapshot = await createPostingSnapshot(job, "applied AI");
    const raw = proposal("compensation", [fact("compensation", "compensation", job.compensation!)]);
    const chicago = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const boston = await loadRuntimeConfig(BOSTON_ENGINEERING);
    expect(validateScreeningDecision(raw, snapshot, chicago)).toMatchObject({ state: "needs_review", hardExclude: null, criteriaVersion: "d5c13c7f8c8abbc3dc82f607241ac34aa14b2b0b5f4fb212944fa8e72406f7e6" });
    expect(validateScreeningDecision(raw, snapshot, boston)).toMatchObject({ state: "no_match", hardExclude: "compensation", criteriaVersion: "b62f625205395fbb19dec5eef924b87560852185f86a41608478f8e19b6ef8da" });
  });
  it.each(["Annual base salary EUR 80,000 - EUR 90,000", "Base pay USD 40 - USD 50 per hour", "Base salary starting at USD 90,000", "Total compensation USD 80,000 - USD 90,000 annually", "Annual base salary CAD 80,000 - CAD 90,000"])("cannot reject noncomparable or partial pay: %s", async compensation => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const snapshot = await createPostingSnapshot(completePosting({ compensation }), "applied AI");
    expect(validateScreeningDecision(proposal("compensation", [fact("compensation", "compensation", compensation)]), snapshot, runtime)).toMatchObject({ state: "needs_review", hardExclude: null });
  });
  it("keeps undisclosed pay a gap while allowing a supported possible match", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const snapshot = await createPostingSnapshot(completePosting(), "applied AI");
    const checked = validateScreeningDecision(proposal(), snapshot, runtime);
    expect(checked.state).toBe("match");
    expect(checked.gaps.join(" ")).toMatch(/compensation.*unavailable/);
  });
  it("uses the selected commute region and subdivision", () => {
    expect(resolveLocationEligibility(completePosting(), CHICAGO_OPERATIONS.policy).state).toBe("eligible");
    expect(resolveLocationEligibility(completePosting({ locationMetadata: { workplaceType: "OnSite", secondaryLocations: [], coverageGaps: [], sourceFields: ["synthetic"] } }), BOSTON_ENGINEERING.policy).state).toBe("ineligible");
    expect(resolveLocationEligibility(completePosting({ location: "Remote - Illinois" }), CHICAGO_OPERATIONS.policy).state).toBe("eligible");
    expect(resolveLocationEligibility(completePosting({ location: "Remote - Illinois" }), BOSTON_ENGINEERING.policy).state).toBe("ineligible");
    expect(resolveLocationEligibility(completePosting({ location: "Remote - UK" }), UK_REVIEW.policy).state).toBe("eligible");
  });
  it("holds conflicting office and remote evidence", () => {
    const job = completePosting({ location: "Remote - US", description: "Lead operations. You must work in the Boston, MA office every week." });
    expect(resolveLocationEligibility(job, CHICAGO_OPERATIONS.policy).state).toBe("review");
  });
});

describe("positive decisions cannot bypass configured constraints", () => {
  it("holds active clearance for a review policy", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const job = completePosting({ description: "Lead operations and improve workflows. Must already hold active clearance at application." });
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(job, "applied AI"), runtime).state).toBe("needs_review");
  });
  it("holds employment outside the allowed set even when the model proposes match", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ employmentType: "contract" }), "applied AI"), runtime).state).toBe("needs_review");
  });
  it("holds a model lane absent from the approved profile", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    const raw = { ...proposal(), lane: "B" };
    expect(validateScreeningDecision(raw, await createPostingSnapshot(completePosting(), "applied AI"), runtime).state).toBe("needs_review");
  });
  it("holds a positive that ignores supported below-floor compensation", async () => {
    const runtime = await loadRuntimeConfig(CHICAGO_OPERATIONS);
    expect(validateScreeningDecision(proposal(), await createPostingSnapshot(completePosting({ compensation: "Annual base salary USD 70,000 - USD 90,000" }), "applied AI"), runtime).state).toBe("needs_review");
  });
});

describe("supported fixed pay and boundary values", () => {
  it("compares a disclosed annual base amount directly without a fallback floor", async () => {
    const compensation = "Annual base salary USD 120000";
    const snapshot = await createPostingSnapshot(completePosting({ compensation }));
    const raw = proposal("compensation", [fact("compensation", "compensation", compensation)]);
    expect(validateScreeningDecision(raw, snapshot, await loadRuntimeConfig(CHICAGO_OPERATIONS)).state).toBe("needs_review");
    expect(validateScreeningDecision(raw, snapshot, await loadRuntimeConfig(BOSTON_ENGINEERING)).state).toBe("no_match");
  });
  it("passes the exact approved floor", async () => {
    const compensation = "Annual base salary USD 80,000 - USD 100,000";
    const snapshot = await createPostingSnapshot(completePosting({ compensation }));
    expect(validateScreeningDecision(proposal(), snapshot, await loadRuntimeConfig(CHICAGO_OPERATIONS)).state).toBe("match");
  });
});

describe("review repair I1 fixed amount completeness", () => {
  it.each([
    ["unparsed alternative", "Annual base salary USD 70,000 or 120000 for another location"],
    ["nonfinite fixed", `Annual base salary USD ${"9".repeat(310)}`],
    ["nonfinite range alternative", `Annual base salary USD 70,000 - USD 90,000 or USD ${"9".repeat(310)}`],
  ])("keeps %s unknown in the shared parser", async (_name, value) => {
    const { salaryUpperBounds } = await import("../../src/config/policy");
    expect(salaryUpperBounds(value, CHICAGO_OPERATIONS.policy)).toEqual([]);
  });
});

describe("round2 N3 whole-posting clearance contradiction", () => {
  it.each(["Must already hold active clearance at application, but active clearance is not required at application.", "Must already hold active clearance at application. No active clearance is required at application.", "Must already hold active clearance at application. No clearance is required for this role."])("holds conflicting requirements instead of creating a firm exclusion: %s", description => {
    return import("../../src/config/policy").then(({ enforcePolicyVerdict }) => {
      expect(() => enforcePolicyVerdict(completePosting({ description }), { match: true, lane: "A", hard_exclude: null, reason: "Synthetic proposal." }, { ...CHICAGO_OPERATIONS.policy, clearance: "exclude_active" }, "applied AI")).toThrow(/review/);
    });
  });
});

const createPostingSnapshot: typeof rawCreatePostingSnapshot = (job,category="applied AI") => rawCreatePostingSnapshot(job,category);
