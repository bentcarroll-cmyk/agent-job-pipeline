import { describe, expect, it } from "vitest";
import { resolvePostingUrl } from "./resolve";
import type { EmployerSource, SafePage, SafePageFetcher } from "./types";

const careerUrl = "https://careers.fixture.test/jobs/operations-17";
const workdayUrl = "https://fixture.wd1.myworkdayjobs.com/External/job/US/Operations_R17";
const workdayDetail = "https://fixture.wd1.myworkdayjobs.com/wday/cxs/fixture/External/job/US/Operations_R17";
const source: EmployerSource = { key: "fixture", name: "Fixture Health",
  careerHosts: ["careers.fixture.test"], atsHosts: ["fixture.wd1.myworkdayjobs.com"],
  evidenceUrl: careerUrl, verifiedAt: "2026-09-22", adapter: "workday", boardUrl: null };
const native = { "@context": "https://schema.org", "@type": "JobPosting",
  title: "Director Operations", identifier: { value: "R17" }, hiringOrganization: { name: "Fixture Health" },
  url: careerUrl, description: "Lead operations transformation in Arlington.",
  jobLocation: { address: { addressLocality: "Arlington", addressRegion: "Virginia", addressCountry: "US" } } };
const page = (url: string, body: string, status = 200): SafePage => ({ requestedUrl: url, finalUrl: url,
  status, body, contentType: "text/html", redirects: [], requestCount: 1,
  fetchedAt: "2026-09-22T12:00:00Z" });
const html = (link?: string) => `<script type="application/ld+json">${JSON.stringify(native)}</script>${link ? `<a href="${link}">Apply</a>` : ""}`;
// Fabricated provider response with whitespace around a requisition hyphen.
const spacedUrl = "https://fixture.wd1.myworkdayjobs.com/External/job/US/Operations_REQ-17";
const spacedDetail = (url: string): SafePage => ({ ...page(url, JSON.stringify({ jobPostingInfo: {
  jobReqId: "REQ -17", title: "Director Operations", jobDescription: "Full posting", externalUrl: spacedUrl } })),
  contentType: "application/json" });

describe("shared employer URL resolver", () => {
  it("keeps a strict direct ATS identity without an employer fetch", async () => {
    let calls = 0;
    const result = await resolvePostingUrl({ url: "https://jobs.lever.co/fixture/ABC" }, {
      registry: [], now: () => "2026-09-22T12:00:00Z", fetchPage: async () => { calls++; throw new Error("unexpected"); },
    });
    expect(result).toMatchObject({ kind: "resolved", posting: { kind: "ats", jobId: "lever:fixture:abc" } });
    expect(calls).toBe(0);
  });

  it("holds an unknown employer URL without fetching it", async () => {
    let calls = 0;
    const result = await resolvePostingUrl({ url: "https://unknown.fixture.test/jobs/17" }, {
      registry: [source], now: () => "2026-09-22T12:00:00Z", fetchPage: async () => { calls++; throw new Error("unexpected"); },
    });
    expect(result).toMatchObject({ kind: "held", reason: "unsupported" });
    expect(calls).toBe(0);
  });

  it("binds an embedded Workday link to same-job detail evidence", async () => {
    const visited: string[] = [];
    const fetchPage: SafePageFetcher = async url => {
      visited.push(url);
      if (url === careerUrl) return page(url, html(workdayUrl));
      if (url === workdayDetail) return { ...page(url, JSON.stringify({ jobPostingInfo: {
        jobReqId: "R17", title: "Director Operations", jobDescription: "Full posting",
        externalUrl: workdayUrl,
      } })), contentType: "application/json" };
      throw new Error("unexpected URL");
    };
    const result = await resolvePostingUrl({ url: careerUrl }, { registry: [source], fetchPage,
      now: () => "2026-09-22T12:00:00Z" });
    expect(result).toMatchObject({ kind: "resolved", posting: { kind: "ats", jobId: "workday:fixture:r17" },
      aliases: expect.arrayContaining([careerUrl, workdayUrl]) });
    expect(visited).toEqual([careerUrl, workdayDetail]);
  });

  it("binds an embedded Workday link despite a stray space in the detail requisition", async () => {
    const employer = `<script type="application/ld+json">${JSON.stringify({ ...native, identifier: { value: "REQ-17" } })}</script><a href="${spacedUrl}">Apply</a>`;
    const fetchPage: SafePageFetcher = async url => url === careerUrl ? page(url, employer) : spacedDetail(url);
    const result = await resolvePostingUrl({ url: careerUrl }, { registry: [source], fetchPage,
      now: () => "2026-09-22T12:00:00Z" });
    expect(result).toMatchObject({ kind: "resolved", posting: { jobId: "workday:fixture:req-17" },
      evidence: [{ requisitionId: "REQ-17" }, { requisitionId: "REQ-17" }] });
  });

  it("records a spaced detail requisition in URL form when the employer URL redirects to the posting", async () => {
    const fetchPage: SafePageFetcher = async url => url === careerUrl
      ? { ...page(url, "<html></html>"), finalUrl: spacedUrl, redirects: [spacedUrl] } : spacedDetail(url);
    const result = await resolvePostingUrl({ url: careerUrl }, { registry: [source], fetchPage,
      now: () => "2026-09-22T12:00:00Z" });
    expect(result).toMatchObject({ kind: "resolved", evidence: [{ requisitionId: "REQ-17" }, { requisitionId: "REQ-17" }] });
  });

  it("holds a wrong-requisition HTTP 200 and an access-denied detail without calling either closed", async () => {
    for (const detail of [
      { ...page(workdayDetail, JSON.stringify({ jobPostingInfo: { jobReqId: "R99", title: "Wrong" } })), contentType: "application/json" },
      page(workdayDetail, "forbidden", 403),
    ]) {
      const fetchPage: SafePageFetcher = async url => url === careerUrl ? page(url, html(workdayUrl)) : detail;
      const result = await resolvePostingUrl({ url: careerUrl }, { registry: [source], fetchPage,
        now: () => "2026-09-22T12:00:00Z" });
      expect(result).toMatchObject({ kind: "held", reason: detail.status === 403 ? "blocked" : "invalid_identity" });
      if (result.kind === "held" && detail.status === 403) expect(result.retryable).toBe(true);
    }
  });

  it("holds incompatible embedded posting identities", async () => {
    const other = "https://fixture.wd1.myworkdayjobs.com/External/job/US/Operations_R99";
    const result = await resolvePostingUrl({ url: careerUrl }, { registry: [source],
      fetchPage: async () => page(careerUrl, html(workdayUrl) + `<a href="${other}">other</a>`),
      now: () => "2026-09-22T12:00:00Z" });
    expect(result).toMatchObject({ kind: "held", reason: "ambiguous" });
  });

  it("accepts a native JobPosting when no same-job ATS link is observed", async () => {
    const result = await resolvePostingUrl({ url: careerUrl }, { registry: [{ ...source, atsHosts: [], adapter: "jobposting" }],
      fetchPage: async () => page(careerUrl, html("https://fixture.wd1.myworkdayjobs.com/External/login")),
      now: () => "2026-09-22T12:00:00Z" });
    expect(result).toMatchObject({ kind: "resolved", posting: { kind: "employer", jobId: "employer:fixture:R17" } });
  });
});
