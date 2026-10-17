import { describe, expect, it } from "vitest";
import { jobRefId, parseJobUrl } from "./discovery";

describe("parseJobUrl — Oracle Recruiting Cloud", () => {
  // Oracle hosts name the customer's pod, not the employer, and the career
  // site code (often Oracle's default "CX_1") is shared across employers,
  // so the pod is the identity and the site only reaches the public URL.
  const posting = "https://fixture-pod.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/fixture_careers/job/1001";

  it("extracts the pod and job id and drops tracking parameters", () => {
    const ref = parseJobUrl(`${posting}?bid=1&tid=x_00000000-0000-4000-8000-000000000000&utm_medium=Unknown`, "Manager");
    expect(ref).toEqual({ ats: "oracle", slug: "fixture-pod", postingId: "1001", url: posting, title: "Manager" });
    expect(jobRefId(ref!)).toBe("oracle:fixture-pod:1001");
  });

  it("reads application-form and preview links as the posting", () => {
    for (const url of [`${posting}/apply/email`, `${posting}/`,
      "https://fixture-pod.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/fixture_careers/requisitions/preview/1001"]) {
      expect(parseJobUrl(url, "")).toMatchObject({ ats: "oracle", postingId: "1001", url: posting });
    }
  });

  it("keeps the site's case and a regional locale", () => {
    const url = "https://fixture-two.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/fr-CA/sites/CX_1/job/180";
    expect(parseJobUrl(url, "")).toMatchObject({ ats: "oracle", slug: "fixture-two", postingId: "180", url });
  });

  it("rejects Oracle URLs that name no job, and lookalike hosts", () => {
    expect(parseJobUrl("https://fixture-two.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs", "")).toBeNull();
    expect(parseJobUrl("https://fixture-two.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/abc", "")).toBeNull();
    expect(parseJobUrl("https://fixture-two.fa.us2.oraclecloud.com/hcmUI/Other/en/sites/CX_1/job/180", "")).toBeNull();
    expect(parseJobUrl("https://fixture-two.fa.us2.oraclecloud.com.evil.com/hcmUI/CandidateExperience/en/sites/CX_1/job/180", "")).toBeNull();
    expect(parseJobUrl("https://fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/180", "")).toBeNull();
  });
});
