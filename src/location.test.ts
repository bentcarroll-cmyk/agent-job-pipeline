import { describe, expect, it } from "vitest";
import { resolveLocationEligibility, locationFactNamesPlaceOutside } from "./location";
import { CHICAGO_OPERATIONS, UK_REVIEW } from "../tests/fixtures/candidates";
import { completePosting } from "../tests/fixtures/policy-postings";
const policy = CHICAGO_OPERATIONS.policy;
const workplace = (workplaceType: string | null, secondaryLocations: string[] = [], coverageGaps: string[] = []) => ({ workplaceType, secondaryLocations, coverageGaps, sourceFields: ["synthetic"] });

describe("configured location adversarial regressions", () => {
  it.each([
    "We are unable to hire in Illinois.",
    "This role is open only to candidates in California.",
    "Office attendance: three days per week in San Francisco.",
    "Applicants must be located in California.",
    "Illinois residents are not eligible for this role.",
    "This role requires working from our Chicago, IL office on Mondays and our New York office on Fridays.",
    "These must be verified before go-live, and applicants must live in California.",
  ])("holds restrictions even alongside positive remote metadata: %s", description => {
    expect(resolveLocationEligibility(completePosting({ location: "Remote - US", locationMetadata: workplace("Remote"), description }), policy).state).toBe("review");
  });
  it.each([
    "Our company has global offices in Chicago, IL, London, and New York.",
    "Travel to client meetings in Chicago, IL is required twice per year.",
    "It is not true that this role can be based remotely anywhere in the US.",
  ])("does not mine employer/travel/negated prose for role eligibility: %s", description => {
    expect(resolveLocationEligibility(completePosting({ location: "San Francisco, CA", locationMetadata: workplace("Hybrid"), description }), policy).state).not.toBe("eligible");
  });
  it.each([
    "Only candidates with a Master's degree will be considered.",
    "The salary range is an estimate based on compensation factors only.",
    "These must be instrumented and verified before go-live.",
  ])("does not mistake non-geographic text for a restriction: %s", description => {
    expect(resolveLocationEligibility(completePosting({ location: "Remote - US", locationMetadata: workplace("Remote"), description }), policy).state).toBe("eligible");
  });
  it("requires role permission, context and remote geographic scope", () => {
    expect(resolveLocationEligibility(completePosting({ location: "Remote", isRemote: true }), policy).state).toBe("review");
    expect(resolveLocationEligibility(completePosting({ location: "Remote", locationMetadata: workplace("Remote"), description: "This role is fully remote. Lead operations." }), policy).state).toBe("eligible");
    expect(resolveLocationEligibility(completePosting({ location: "Remote", locationMetadata: workplace("Remote"), description: "This role is fully remote. Must reside in Illinois." }), policy).state).toBe("review");
  });
  it("honors secondary offices and workplace conflicts", () => {
    expect(resolveLocationEligibility(completePosting({ location: "Boston, MA", locationMetadata: workplace("Hybrid", ["Chicago, IL"]) }), policy).state).toBe("eligible");
    expect(resolveLocationEligibility(completePosting({ location: "Remote - US", locationMetadata: workplace("Hybrid") }), policy).state).toBe("review");
    expect(resolveLocationEligibility(completePosting({ location: "Chicago, IL", locationMetadata: workplace("Hybrid", [], ["secondary locations unknown"]) }), policy).state).toBe("review");
  });
  it("requires complete context before rejecting an outside location", () => {
    const job = completePosting({ location: "Boston, MA", locationMetadata: workplace("OnSite") });
    expect(resolveLocationEligibility(job, policy).state).toBe("ineligible");
    delete job.contentProvenance;
    expect(resolveLocationEligibility(job, policy).state).toBe("review");
  });
  it("honors workplace choices and does not claim worldwide coverage", () => {
    const remoteOnly = { ...policy, location: { ...policy.location, allowOnsite: false, allowHybrid: false } };
    expect(resolveLocationEligibility(completePosting({ locationMetadata: workplace("OnSite") }), remoteOnly).state).toBe("ineligible");
    expect(resolveLocationEligibility(completePosting({ location: "Unknown regional hub", locationMetadata: workplace("Hybrid") }), UK_REVIEW.policy).state).toBe("review");
  });
  it("anchors outside-place evidence under the candidate's own commute policy", () => {
    const job = completePosting({ location: "Chicago, IL; Boston, MA", locationMetadata: workplace("Hybrid") });
    expect(locationFactNamesPlaceOutside({ sourceField: "location", excerpt: "Boston, MA", start: 13, end: 23 }, job, policy)).toBe(true);
    expect(locationFactNamesPlaceOutside({ sourceField: "location", excerpt: job.location, start: 0, end: job.location.length }, job, policy)).toBe(false);
    expect(locationFactNamesPlaceOutside({ sourceField: "description", excerpt: "#LI-Hybrid", start: 0, end: 10 }, job, policy)).toBe(false);
  });
});

describe("unrecognized remote scope is not outside-place proof", () => {
  it.each(["Remote - US except Illinois", "Remote - US and Canada with approval", "Remote - US-IL"])("holds unresolved compound scope: %s", location => {
    expect(resolveLocationEligibility(completePosting({ location, locationMetadata: workplace("Remote") }), policy).state).toBe("review");
  });
  it("does not approve an office elsewhere in the candidate's state", () => {
    expect(resolveLocationEligibility(completePosting({ location: "Springfield, IL", locationMetadata: workplace("OnSite") }), policy).state).toBe("ineligible");
  });
});

describe("review repair I4 office workplace permissions", () => {
  const remoteOnly = { ...policy, location: { ...policy.location, allowOnsite: false, allowHybrid: false } };
  it.each(["onsite", "hybrid", ""])("does not approve a body-only %s office for a remote-only policy", arrangement => {
    const job = completePosting({ location: "Unknown", description: `Lead operations. This ${arrangement ? `${arrangement} ` : ""}role is based in our Chicago, IL office.` });
    expect(resolveLocationEligibility(job, remoteOnly).state).not.toBe("eligible");
  });
  it("holds body workplace evidence contradicting a remote source arrangement", () => {
    const job = completePosting({ location: "Chicago, IL", locationMetadata: workplace("Remote"), description: "Lead operations. This onsite role is based in our Chicago, IL office." });
    expect(resolveLocationEligibility(job, remoteOnly).state).toBe("review");
  });
  it("can approve a recognized body onsite arrangement under an onsite-only policy", () => {
    const onsiteOnly = { ...policy, location: { ...policy.location, allowRemote: false, allowHybrid: false } };
    const job = completePosting({ location: "Unknown", description: "Lead operations. This onsite role is based in our Chicago, IL office." });
    expect(resolveLocationEligibility(job, onsiteOnly).state).toBe("eligible");
  });
});

describe("review repair M1 commute versus subdivision evidence", () => {
  it("permits concrete same-state outside-office evidence without expanding the commute", () => {
    const job = completePosting({ location: "Springfield, IL", locationMetadata: workplace("OnSite") });
    expect(resolveLocationEligibility(job, policy).state).toBe("ineligible");
    expect(locationFactNamesPlaceOutside({ sourceField: "location", excerpt: job.location, start: 0, end: job.location.length }, job, policy)).toBe(true);
    expect(locationFactNamesPlaceOutside({ sourceField: "description", excerpt: "This onsite role is based in Springfield, IL.", start: 0, end: 43 }, job, policy)).toBe(true);
    const remote = completePosting({ location: "Remote - Illinois", locationMetadata: workplace("Remote") });
    expect(locationFactNamesPlaceOutside({ sourceField: "location", excerpt: remote.location, start: 0, end: remote.location.length }, remote, policy)).toBe(false);
  });
});

describe("review repair I4 qualified body arrangement assertions", () => {
  it.each(["This role is onsite in our Chicago, IL office.", "This on site role is based in our Chicago, IL office."])("does not ignore a role arrangement contradicting a Remote source: %s", roleText => {
    const remoteOnly = { ...policy, location: { ...policy.location, allowOnsite: false, allowHybrid: false } };
    const job = completePosting({ location: "Chicago, IL", locationMetadata: workplace("Remote"), description: `Lead operations. ${roleText}` });
    expect(resolveLocationEligibility(job, remoteOnly).state).toBe("review");
  });
});

describe("round2 N2 workplace alternatives", () => {
  const remoteOnly = { ...policy, location: { ...policy.location, allowOnsite: false, allowHybrid: false } };
  it.each(["This role is onsite in our Chicago, IL office or fully remote within the US.", "This onsite role is based in our Chicago, IL office or can be remote within the US."])("holds a role-office alternative instead of assuming onsite is mandatory: %s", assertion => {
    expect(resolveLocationEligibility(completePosting({ location: "Unknown", description: `Lead operations. ${assertion}` }), remoteOnly).state).toBe("review");
  });
  it("holds alternative workplace wording even alongside an OnSite source", () => {
    const job = completePosting({ location: "Springfield, IL", locationMetadata: workplace("OnSite"), description: "Lead operations. This role is onsite in our Springfield, IL office or fully remote within the US." });
    expect(resolveLocationEligibility(job, remoteOnly).state).toBe("review");
  });
});
