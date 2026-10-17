import { describe, expect, it } from "vitest";
import { parseJobUrl } from "../unbounded/discovery";
import { fetchResolvedPosting } from "./fetch";
import type { ResolvedPosting, SafePage, SafePageFetcher } from "./types";

const now = "2026-01-05T12:00:00Z";
const page = (url: string, status: number, body: string): SafePage => ({ requestedUrl: url,
  finalUrl: url, status, body, contentType: "text/html", redirects: [], requestCount: 1, fetchedAt: now });
const deps = (fetchPage: SafePageFetcher) => ({ registry: [], fetchPage, now: () => now });

describe("classified resolved-posting fetch — Oracle Recruiting Cloud", () => {
  // Oracle's API answers the posting, and the posting page names the
  // employer. Both stay on the posting's own host.
  const oraclePage = "https://fixture-pod.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/fixture_careers/job/1001";
  const oracleApi = "https://fixture-pod.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/" +
    "recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%221001%22,siteNumber=fixture_careers";
  const oracleRef = parseJobUrl(`${oraclePage}?bid=1&utm_medium=Unknown`, "")!;
  const oraclePosting: ResolvedPosting = { kind: "ats", jobId: "oracle:fixture-pod:1001", canonicalUrl: oracleRef.url, ref: oracleRef };
  const oracleItem = (id = "1001") => ({ Id: id, Title: "Regional Operations Manager", PrimaryLocation: "Springfield, IL, United States",
    WorkplaceTypeCode: "ORA_HYBRID", WorkplaceType: "Hybrid", ExternalDescriptionStr: "<p>Lead regional operations.</p>" });
  const oracleFetcher = (api: string, site: SafePage | Error = page(oraclePage, 200,
    '<meta property="og:site_name" content="Fixture Employer"/>')): SafePageFetcher => async url => {
    if (url === oracleApi) return { ...page(url, 200, api), contentType: "application/json" };
    if (url === oraclePage) { if (site instanceof Error) throw site; return site; }
    throw new Error(`unexpected ${url}`);
  };
  it("fetches an Oracle posting and names its employer from the career site", async () => {
    const result = await fetchResolvedPosting(oraclePosting, deps(oracleFetcher(JSON.stringify({ items: [oracleItem()], hasMore: false }))));
    expect(result).toMatchObject({ kind: "fetched", sourceUrl: oracleApi, job: { id: "oracle:fixture-pod:1001",
      company: "Fixture Employer", title: "Regional Operations Manager", url: oraclePage, isRemote: false } });
  });
  it("keeps an Oracle posting whose career site cannot be read, named by its site code", async () => {
    const body = JSON.stringify({ items: [oracleItem()], hasMore: false });
    for (const site of [page(oraclePage, 503, "unavailable"), new Error("timeout")]) {
      const result = await fetchResolvedPosting(oraclePosting, deps(oracleFetcher(body, site)));
      expect(result).toMatchObject({ kind: "fetched", job: { company: "Fixture Careers" } });
    }
  });
  it("classifies a closed, mismatched or unreadable Oracle answer", async () => {
    for (const [body, expected] of [
      [JSON.stringify({ items: [], count: 0, hasMore: false }), { kind: "not_found", reason: "absent_complete_board" }],
      [JSON.stringify({ items: [oracleItem("1002")], hasMore: false }), { kind: "held", reason: "invalid_identity" }],
      [JSON.stringify({ items: [], hasMore: true }), { kind: "held", reason: "incomplete" }],
      [JSON.stringify({ items: [{ ...oracleItem(), ExternalDescriptionStr: "" }], hasMore: false }), { kind: "held", reason: "incomplete" }],
    ] as const) {
      expect(await fetchResolvedPosting(oraclePosting, deps(oracleFetcher(body)))).toMatchObject(expected);
    }
  });
});
