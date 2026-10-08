import type { Source } from "./sources";
const sources: readonly Source[] = [{ company: "Example Automation", companyCategory: "applied AI", ats: "greenhouse", slug: "example-automation" }, { company: "Example Platform", companyCategory: "AI infrastructure", ats: "greenhouse", slug: "example-platform" }];
import { afterEach, describe, expect, it, vi } from "vitest";
import { AshbyBoardNotFoundError, canonicalizeAtsUrl, fetchAllPostings, fetchCompanyBoard, fetchPosting, matchesWorkdayRequisition, normalizeWorkdayRequisition, sameWorkdaySite } from "./sources";

describe("canonicalizeAtsUrl", () => {
  it("keys an employer page embedding a Greenhouse posting by gh_jid, as its board URL is keyed", () => {
    expect(canonicalizeAtsUrl("https://job-boards.greenhouse.io/fixture-fitness/jobs/700")).toBe("700");
    expect(canonicalizeAtsUrl("https://www.fixture-fitness.com/about/careers?gh_jid=700")).toBe("700");
    expect(canonicalizeAtsUrl("https://www.fixture-security.io/careers/job/701/:title?gh_jid=701")).toBe("701");
    expect(canonicalizeAtsUrl("https://www.fixture-monitor.com/jobs/?gh_jid=702&gh_src=abc123")).toBe("702");
  });

  it("leaves a page unkeyed when its gh_jid is not a posting id", () => {
    expect(canonicalizeAtsUrl("https://careers.example.com/job?gh_jid=:id")).toBeNull();
    expect(canonicalizeAtsUrl("https://careers.example.com/job?gh_jid=undefined")).toBeNull();
    expect(canonicalizeAtsUrl("https://careers.example.com/job?gh_jid=")).toBeNull();
    expect(canonicalizeAtsUrl("https://careers.example.com/job?gh_jid=700&gh_jid=703")).toBeNull();
  });

  it("leaves other employer pages unkeyed", () => {
    expect(canonicalizeAtsUrl("https://www.fixture-fitness.com/about/careers")).toBeNull();
    expect(canonicalizeAtsUrl("https://careers.example.com/jobs/700")).toBeNull();
  });
});

describe("fetchCompanyBoard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([{}, { jobs: null }, [], true, { jobs: [{}] }, { jobs: [{ id: "" }] },
    { jobs: [{ id: " 71 " }] }, { jobs: [{ id: 71 }] }])(
    "does not turn an unusable Ashby board identity list into absence: %j", async payload => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
      await expect(fetchCompanyBoard("ashby", "Fixture", "fixture")).rejects.toThrow();
    });

  it.each([null, { jobs: {} }, { jobs: [null] }])(
    "continues rejecting invalid Ashby containers: %j", async payload => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
      await expect(fetchCompanyBoard("ashby", "Fixture", "fixture")).rejects.toThrow();
    });

  it("retains an explicitly empty Ashby job list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jobs: [] })));
    await expect(fetchCompanyBoard("ashby", "Fixture", "fixture")).resolves.toEqual([]);
  });

  it("types a missing Ashby board without changing its message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const error = await fetchCompanyBoard("ashby", "Lime", "lime").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyBoardNotFoundError);
    expect((error as Error).message).toBe("ashby/lime: HTTP 404");
  });

  it("keeps other Ashby board failures untyped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const error = await fetchCompanyBoard("ashby", "Lime", "lime").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AshbyBoardNotFoundError);
    expect((error as Error).message).toBe("ashby/lime: HTTP 403");
  });

  it("fetches and normalizes a Greenhouse board", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          {
            id: 123,
            title: "Director of AI Enablement",
            absolute_url: "https://boards.greenhouse.io/testco/jobs/123",
            location: { name: "Remote - US" },
            departments: [{ name: "Operations" }],
            updated_at: "2026-09-01T00:00:00Z",
            content: "<p>Base salary $180,000. Remote US.</p>",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const jobs = await fetchCompanyBoard("greenhouse", "Testco", "testco");

    expect(mockFetch).toHaveBeenCalledWith("https://boards-api.greenhouse.io/v1/boards/testco/jobs?content=true", { signal: expect.any(AbortSignal) });
    expect(jobs).toMatchObject([
      {
        id: "greenhouse:Testco:123",
        company: "Testco",
        title: "Director of AI Enablement",
        url: "https://boards.greenhouse.io/testco/jobs/123",
        location: "Remote - US",
        department: "Operations",
        isRemote: null,
        employmentType: null,
        postedAt: "2026-09-01T00:00:00Z",
        compensation: null,
        description: "Base salary $180,000. Remote US.",
      },
    ]);
  });

  it("fetches and normalizes an Ashby board", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          {
            id: "abc",
            title: "Chief of Staff",
            jobUrl: "https://jobs.ashbyhq.com/testco2/abc",
            locationName: "Remote",
            department: "Operations",
            isRemote: true,
            employmentType: "FullTime",
            publishedAt: "2026-09-02T00:00:00Z",
            compensationTierSummary: "$150k-$200k",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const jobs = await fetchCompanyBoard("ashby", "Testco2", "testco2");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.ashbyhq.com/posting-api/job-board/testco2?includeCompensation=true",
      { signal: expect.any(AbortSignal) },
    );
    expect(jobs).toMatchObject([
      {
        id: "ashby:Testco2:abc",
        company: "Testco2",
        title: "Chief of Staff",
        url: "https://jobs.ashbyhq.com/testco2/abc",
        location: "Remote",
        department: "Operations",
        isRemote: true,
        employmentType: "FullTime",
        postedAt: "2026-09-02T00:00:00Z",
        compensation: "$150k-$200k",
        description: null,
      },
    ]);
  });

  it("retains Ashby's hybrid metadata and secondary offices independently of its remote flag", async () => {
    // Shape observed in the public Ashby posting API: secondary locations
    // are objects, and isRemote can be true for a Hybrid posting.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
      id: "hybrid", title: "Learning Designer", jobUrl: "https://jobs.ashbyhq.com/testco/hybrid",
      location: "San Francisco", isRemote: true, workplaceType: "Hybrid",
      secondaryLocations: [{ location: "Chicago" }, { location: "Washington, DC" }],
    }] })));

    const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

    expect(job.location).toBe("San Francisco");
    expect(job.isRemote).toBe(true);
    expect(job.locationMetadata).toEqual({
      workplaceType: "Hybrid", secondaryLocations: ["Chicago", "Washington, DC"], coverageGaps: [],
      sourceFields: ["location", "workplaceType", "secondaryLocations[0].location", "secondaryLocations[1].location"],
    });
  });

  it("does not replace an Ashby arrangement with remote wording from the posting body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
      id: "optional-hybrid", title: "Account Executive", locationName: "New York",
      jobUrl: "https://jobs.ashbyhq.com/testco/optional-hybrid", isRemote: true,
      workplaceType: "Hybrid", secondaryLocations: [],
      descriptionPlain: "Work remotely anywhere in the US, with optional hybrid office attendance.",
    }] })));

    const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

    expect(job.locationMetadata).toEqual({
      workplaceType: "Hybrid", secondaryLocations: [], coverageGaps: [],
      sourceFields: ["locationName", "workplaceType", "secondaryLocations"],
    });
    expect(job.description).toContain("remotely anywhere in the US");
    expect(job.isRemote).toBe(true);
  });

  it("retains usable Ashby offices while reporting unsupported location entries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
      id: "malformed", title: "Operations", location: "New York", isRemote: false,
      workplaceType: { type: "Remote" },
      secondaryLocations: [{ location: "Washington, DC" }, { location: "  " }, "Remote", null],
    }] })));

    const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

    expect(job.locationMetadata).toEqual({
      workplaceType: null, secondaryLocations: ["Washington, DC"],
      coverageGaps: [
        "workplaceType: unsupported location value",
        "secondaryLocations[1].location: no usable location text",
        "secondaryLocations[2]: unsupported location entry",
        "secondaryLocations[3]: unsupported location entry",
      ],
      sourceFields: ["location", "secondaryLocations[0].location"],
    });
    expect(job.isRemote).toBe(false);
  });

  it.each([
    [undefined, "secondaryLocations: not supplied"],
    [null, "secondaryLocations: not supplied"],
    ["Remote", "secondaryLocations: unsupported location collection"],
  ])("does not infer complete Ashby location coverage from %j", async (secondaryLocations, gap) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
      id: "missing", title: "Operations", secondaryLocations,
    }] })));

    const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

    expect(job.location).toBe("unspecified");
    expect(job.isRemote).toBeNull();
    expect(job.locationMetadata).toEqual({
      workplaceType: null, secondaryLocations: [], sourceFields: [],
      coverageGaps: ["location: not supplied", "workplaceType: not supplied", gap],
    });
  });

  it("uses Ashby's nested compensation summary without relabeling OTE as base pay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
      id: "nested-pay", title: "Account Executive", location: "US Remote",
      compensation: { compensationTierSummary: "<p>$200,000–$300,000 OTE</p>" },
      compensationTierSummary: "$90,000 legacy summary",
    }] })));

    const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

    expect(job.compensation).toBe("$200,000–$300,000 OTE");
    expect(job.contentProvenance?.compensation.sourceFields).toEqual(["compensation.compensationTierSummary"]);
  });

  it.each([undefined, null, "", { amount: 704 }])(
    "keeps legacy Ashby compensation when its nested summary is unusable: %j", async nestedSummary => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ jobs: [{
        id: "legacy-pay", title: "Operations", location: "US Remote",
        compensation: { compensationTierSummary: nestedSummary }, compensationTierSummary: "$150k-$200k",
      }] })));

      const [job] = await fetchCompanyBoard("ashby", "Testco", "testco");

      expect(job.compensation).toBe("$150k-$200k");
      expect(job.contentProvenance?.compensation.sourceFields).toEqual(["compensationTierSummary"]);
    },
  );

  it("fetches and normalizes a Lever board", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "xyz",
          text: "VP Business Operations",
          hostedUrl: "https://jobs.lever.co/testco3/xyz",
          categories: { location: "Remote - US", team: "Operations", commitment: "Full-time" },
          workplaceType: "remote",
          createdAt: 705,
        },
      ],
    });
    vi.stubGlobal("fetch", mockFetch);

    const jobs = await fetchCompanyBoard("lever", "Testco3", "testco3");

    expect(mockFetch).toHaveBeenCalledWith("https://api.lever.co/v0/postings/testco3?mode=json", { signal: expect.any(AbortSignal) });
    expect(jobs).toMatchObject([
      {
        id: "lever:Testco3:xyz",
        company: "Testco3",
        title: "VP Business Operations",
        url: "https://jobs.lever.co/testco3/xyz",
        location: "Remote - US",
        department: "Operations",
        isRemote: true,
        employmentType: "Full-time",
        postedAt: new Date(705).toISOString(),
        compensation: null,
        description: null,
      },
    ]);
  });

  it.each(["hybrid", "on-site", "remote"])("retains Lever's %s arrangement without changing its remote semantics", async workplaceType => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([{
      id: "lever-location", text: "Operations", hostedUrl: "https://jobs.lever.co/testco/lever-location",
      categories: { location: "New York", commitment: "Full-time" }, workplaceType,
    }])));

    const [job] = await fetchCompanyBoard("lever", "Testco", "testco");

    expect(job.location).toBe("New York");
    expect(job.isRemote).toBe(workplaceType === "remote");
    expect(job.locationMetadata).toEqual({
      workplaceType, secondaryLocations: [], coverageGaps: [], sourceFields: ["categories.location", "workplaceType"],
    });
  });

  it("throws on unsupported ats platform", async () => {
    await expect(fetchCompanyBoard("invalid" as any, "Testco", "testco")).rejects.toThrow(
      'fetchCompanyBoard: unsupported ats "invalid"',
    );
  });
});

describe("fetchPosting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and normalizes a single Greenhouse posting", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 123,
        title: "Director of AI Enablement",
        absolute_url: "https://boards.greenhouse.io/testco/jobs/123",
        location: { name: "Remote - US" },
        departments: [{ name: "Operations" }],
        updated_at: "2026-09-01T00:00:00Z",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const job = await fetchPosting({ ats: "greenhouse", slug: "testco", postingId: "123", url: "" }, "Testco");

    expect(mockFetch).toHaveBeenCalledWith("https://boards-api.greenhouse.io/v1/boards/testco/jobs/123", { signal: expect.any(AbortSignal) });
    expect(job).toMatchObject({ company: "Testco", title: "Director of AI Enablement", location: "Remote - US" });
  });

  it("fetches and normalizes a single Lever posting", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "xyz",
        text: "VP Business Operations",
        hostedUrl: "https://jobs.lever.co/testco3/xyz",
        categories: { location: "Remote - US", team: "Operations", commitment: "Full-time" },
        workplaceType: "remote",
        createdAt: 705,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const job = await fetchPosting({ ats: "lever", slug: "testco3", postingId: "xyz", url: "" }, "Testco3");

    expect(mockFetch).toHaveBeenCalledWith("https://api.lever.co/v0/postings/testco3/xyz", { signal: expect.any(AbortSignal) });
    expect(job).toMatchObject({ title: "VP Business Operations", isRemote: true });
  });

  // The reason this pipeline fetches single postings at all: the body is
  // where clearance, salary and the real location live.
  it("extracts Greenhouse's entity-encoded content as plain text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 123,
          title: "AI Enablement Lead",
          absolute_url: "https://boards.greenhouse.io/testco/jobs/123",
          location: { name: "Austin" },
          content:
            "&lt;p&gt;Based in Austin or Washington, DC.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Active clearance not required&lt;/li&gt;&lt;/ul&gt;",
        }),
      }),
    );

    const job = await fetchPosting({ ats: "greenhouse", slug: "testco", postingId: "123", url: "" }, "Testco");

    // The blank line is deliberate: a paragraph closed and a list opened,
    // and preserving that boundary costs nothing and keeps sections legible.
    expect(job!.description).toBe("Based in Austin or Washington, DC.\n\n• Active clearance not required");
  });

  // Lever splits requirements out of `description` into `lists`; dropping
  // them would cut the body off before the detail the criteria turn on.
  it("folds Lever's requirement lists into the description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: "xyz",
          text: "GTM Strategy Manager",
          hostedUrl: "https://jobs.lever.co/testco3/xyz",
          categories: { location: "Remote - US" },
          description: "<p>Own GTM strategy.</p>",
          lists: [{ text: "Requirements", content: "<li>DC metro or remote</li>" }],
          additional: "<p>Salary $160,000+</p>",
        }),
      }),
    );

    const job = await fetchPosting({ ats: "lever", slug: "testco3", postingId: "xyz", url: "" }, "Testco3");

    expect(job!.description).toContain("Own GTM strategy.");
    expect(job!.description).toContain("Requirements");
    expect(job!.description).toContain("• DC metro or remote");
    expect(job!.description).toContain("Salary $160,000+");
  });

  // Workday exposes a JSON detail endpoint under /wday/cxs/ that mirrors the
  // public URL's path. Deriving it needs the career-site name and external
  // path, neither of which can be rebuilt from tenant and requisition alone —
  // which is why the ref carries the original URL.
  it("derives Workday's JSON endpoint from the public posting URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jobPostingInfo: {
          title: "Director, Business Operations",
          jobReqId: "JR706",
          location: "US-IL-Chicago",
          additionalLocations: ["Washington, DC"],
          timeType: "Full time",
          startDate: "2026-09-01",
          jobDescription: "<p>Own the operating model.</p><ul><li>Hybrid, DC metro</li></ul>",
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const job = await fetchPosting(
      {
        ats: "workday",
        slug: "fixture-compute",
        postingId: "jr706",
        url: "https://fixture-compute.wd5.myworkdayjobs.com/en-US/External/job/US-IL-Chicago/Director--Business-Operations_JR706",
      },
      "Nvidia",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://fixture-compute.wd5.myworkdayjobs.com/wday/cxs/fixture-compute/External/job/US-IL-Chicago/Director--Business-Operations_JR706",
      { redirect: "manual", signal: expect.any(AbortSignal) },
    );
    expect(job).toMatchObject({
      company: "Nvidia",
      title: "Director, Business Operations",
      // timeType answers hard exclude 1 structurally instead of by inference.
      employmentType: "Full time",
    });
    expect(job!.description).toContain("Own the operating model.");
  });

  // A multi-office Workday posting qualifies on any one commutable office, so
  // every location has to reach the model, not just the primary one.
  it("carries additional Workday locations through to the filter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jobPostingInfo: {
            title: "AI Enablement Lead",
            jobReqId: "JR1",
            jobDescription: "<p>Lead AI adoption across offices.</p>",
            location: "Austin",
            additionalLocations: ["Chicago", "Washington, DC", "New York"],
          },
        }),
      }),
    );

    const job = await fetchPosting(
      { ats: "workday", slug: "acme", postingId: "jr1", url: "https://acme.wd1.myworkdayjobs.com/Careers/job/Austin/AI_JR1" },
      "Acme",
    );

    expect(job!.location).toContain("Austin");
    expect(job!.location).toContain("Washington, DC");
  });

  it("returns null on 404 rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchPosting({ ats: "greenhouse", slug: "t", postingId: "1", url: "" }, "T")).toBeNull();
  });

  it("throws on a non-404 error response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchPosting({ ats: "greenhouse", slug: "t", postingId: "1", url: "" }, "T")).rejects.toThrow("HTTP 500");
  });

  // Workday answers S22 "permission denied" for postings that are no longer
  // public. Only the tenant's live job search, not the 403, can show absence.
  describe("Workday permission-denied postings", () => {
    const ref = { ats: "workday" as const, slug: "acme", postingId: "jr1", url: "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/Austin/AI_JR1" };
    const detail = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Austin/AI_JR1";
    const search = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs";
    const denied = () => Response.json({ errorCode: "S22", httpStatus: 403, message: "permission denied" }, { status: 403 });
    const listing = (jobPostings: Array<{ externalPath: string }>, total = jobPostings.length) => Response.json({ total, jobPostings });
    function workday(detailResponse: () => Response, searchResponses: Array<() => Response>) {
      const searches: string[] = [];
      const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === detail) return detailResponse();
        if (url === search && init?.method === "POST") {
          searches.push(JSON.parse(String(init.body)).searchText);
          const next = searchResponses.shift();
          if (!next) throw new Error("unexpected extra search");
          return next();
        }
        throw new Error(`unexpected request ${url}`);
      });
      vi.stubGlobal("fetch", mockFetch);
      return searches;
    }

    it("treats a posting missing from the live job search as not found", async () => {
      const searches = workday(denied, [() => listing([])]);
      expect(await fetchPosting(ref, "Acme")).toBeNull();
      expect(searches).toEqual(["jr1"]);
    });

    it("stays retryable while the live job search still lists the posting", async () => {
      workday(denied, [() => listing([{ externalPath: "/job/Austin/AI_JR1" }])]);
      await expect(fetchPosting(ref, "Acme")).rejects.toThrow("workday/acme/jr1: HTTP 403");
    });

    it("stays retryable for a 403 without Workday's S22 code and skips the search", async () => {
      const searches = workday(() => new Response("Forbidden", { status: 403 }), []);
      await expect(fetchPosting(ref, "Acme")).rejects.toThrow("HTTP 403");
      expect(searches).toEqual([]);
    });

    it("stays retryable when the live job search fails", async () => {
      workday(denied, [() => new Response("", { status: 500 })]);
      await expect(fetchPosting(ref, "Acme")).rejects.toThrow("HTTP 403");
    });

    it("stays retryable when the live job search is truncated", async () => {
      const others = Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/Austin/Other_JR${100 + i}` }));
      workday(denied, [() => listing(others, 45)]);
      await expect(fetchPosting(ref, "Acme")).rejects.toThrow("HTTP 403");
    });

    it("searches the base requisition before closing a suffixed posting", async () => {
      const suffixed = { ...ref, postingId: "r-707-1", url: "https://acme.wd1.myworkdayjobs.com/Careers/job/Austin/Lead_R-707-1" };
      const suffixedDetail = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Austin/Lead_R-707-1";
      const searches: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === suffixedDetail) return denied();
        if (url === search && init?.method === "POST") {
          const text = JSON.parse(String(init.body)).searchText;
          searches.push(text);
          return text === "r-707" ? listing([{ externalPath: "/job/Austin/Lead_R-707-1" }]) : listing([]);
        }
        throw new Error(`unexpected request ${url}`);
      }));
      await expect(fetchPosting(suffixed, "Acme")).rejects.toThrow("HTTP 403");
      expect(searches).toEqual(["r-707-1", "r-707"]);
    });

    it("closes a suffixed posting only after both searches omit it", async () => {
      const suffixed = { ...ref, postingId: "r-707-1", url: "https://acme.wd1.myworkdayjobs.com/Careers/job/Austin/Lead_R-707-1" };
      const suffixedDetail = "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/job/Austin/Lead_R-707-1";
      let searches = 0;
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        if (url === suffixedDetail) return denied();
        if (url === search && init?.method === "POST") { searches++; return listing([]); }
        throw new Error(`unexpected request ${url}`);
      }));
      expect(await fetchPosting(suffixed, "Acme")).toBeNull();
      expect(searches).toBe(2);
    });

    it.each([() => new Response("not json", { status: 200 }), () => Response.json({ jobPostings: [] })])(
      "stays retryable when the live job search is unreadable or omits its total", async (response) => {
        workday(denied, [response]);
        await expect(fetchPosting(ref, "Acme")).rejects.toThrow("HTTP 403");
      });
  });

  it("percent-encodes a slug containing a space", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", mockFetch);
    await fetchPosting({ ats: "lever", slug: "a b", postingId: "1", url: "" }, "A B");
    expect(mockFetch).toHaveBeenCalledWith("https://api.lever.co/v0/postings/a%20b/1", { signal: expect.any(AbortSignal) });
  });
});


describe("fixed Greenhouse discovery", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports each source failure even when no postings are returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.includes("/example-automation/")) return new Response("", {status:403});
      if (url.hostname === "api.lever.co") return Response.json([]);
      return Response.json({jobs:[],jobPostings:[],total:0,hits:0});
    }));
    const observed: Array<{company:string; status:string; count:number; error:string|null}> = [];
    const result = await fetchAllPostings(sources, async event => {
      observed.push({company:event.source.company,status:event.status,count:event.jobs.length,error:event.error});
    });
    expect(result.jobs).toHaveLength(0);
    expect(observed).toHaveLength(4);
    expect(observed.slice(0,4)).toMatchObject([
      {company:"Example Automation",status:"started",count:0,error:null},
      {company:"Example Automation",status:"failed",count:0,error:expect.stringContaining("HTTP 403")},
      {company:"Example Platform",status:"started",count:0,error:null},
      {company:"Example Platform",status:"complete",count:0,error:null},
    ]);
  });
  it("lists metadata without downloading descriptions before deduplication", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname === "boards-api.greenhouse.io") {
        requested.push(input);
        const includeContent = url.searchParams.get("content") === "true";
        return Response.json({ jobs: [{
          id: 123, title: "Operations", absolute_url: "https://example.com/careers/123",
          location: { name: "Remote US" }, updated_at: "2026-09-22T00:00:00Z",
          ...(includeContent ? { content: "<p>Large description repeated across thousands of jobs.</p>" } : {}),
        }] });
      }
      if (url.hostname === "api.lever.co") return Response.json([]);
      return Response.json({ jobs: [], jobPostings: [], total: 0, hits: 0 });
    }));
    const { jobs, errors } = await fetchAllPostings(sources);
    expect(errors).toEqual([]);
    expect(requested).toHaveLength(2);
    expect(requested.every(url => new URL(url).searchParams.get("content") !== "true")).toBe(true);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ id: "greenhouse:Example Automation:123", title: "Operations", description: null });
    expect(jobs.every(job => job.description === null)).toBe(true);
  });
});

describe("sameWorkdaySite", () => {
  const base = "https://synthetic.wd12.myworkdayjobs.com";
  it("matches a career site regardless of case", () => {
    expect(sameWorkdaySite(`${base}/external_career_site/job/x/role_jr1`, `${base}/External_Career_Site/job/X/Role_JR1`)).toBe(true);
  });
  it("still distinguishes different sites, tenants and non-Workday URLs", () => {
    expect(sameWorkdaySite(`${base}/External_Career_Site/job/x/role_jr1`, `${base}/Internal_Site/job/x/role_jr1`)).toBe(false);
    expect(sameWorkdaySite(`${base}/External_Career_Site/job/x/role_jr1`, "https://other.wd12.myworkdayjobs.com/External_Career_Site/job/x/role_jr1")).toBe(false);
    expect(sameWorkdaySite("https://example.com/careers/role", `${base}/External_Career_Site/job/x/role_jr1`)).toBe(false);
  });
});

describe("normalizeWorkdayRequisition", () => {
  it.each(["REQ -4726", "REQ- 4726", "REQ - 4726", "REQ -4726", " REQ-4726 ", "\tREQ -4726\n"])(
    "reduces %j to Workday's URL form", requisition => {
      expect(normalizeWorkdayRequisition(requisition)).toBe("REQ-4726");
    });
  it.each(["REQ-4726", "R_708", "REQ 4726", "REQ-4726-2"])("leaves %j untouched", requisition => {
    expect(normalizeWorkdayRequisition(requisition)).toBe(requisition);
  });
});

describe("matchesWorkdayRequisition", () => {
  // Fabricated Workday URL and requisitions exercise spacing and suffix rules.
  const posting = "https://synthetic.wd5.myworkdayjobs.com/External/job/Remote/Operations_REQ-4726";
  it("accepts a requisition returned with a space before the hyphen", () => {
    expect(matchesWorkdayRequisition(posting, "REQ -4726")).toBe(true);
  });
  it("still accepts the requisition as written in the URL, with or without a numeric publication suffix", () => {
    expect(matchesWorkdayRequisition(posting, "REQ-4726")).toBe(true);
    expect(matchesWorkdayRequisition(`${posting}-2`, "REQ -4726")).toBe(true);
  });
  it("accepts a requisition padded with whitespace", () => {
    expect(matchesWorkdayRequisition(posting, " REQ-4726")).toBe(true);
    expect(matchesWorkdayRequisition(posting, "REQ-4726 ")).toBe(true);
    expect(matchesWorkdayRequisition(posting, "\tREQ -4726\n")).toBe(true);
  });
  it("rejects a different requisition despite the same numeric tail", () => {
    expect(matchesWorkdayRequisition(posting, "OTHER -4726")).toBe(false);
    expect(matchesWorkdayRequisition(posting, "REQ -4727")).toBe(false);
  });
  it.each([
    ["a longer requisition that begins with the URL's", "REQ -47265", posting],
    ["a prefix of the URL's requisition", "REQ -472", posting],
    ["a tail of the URL's requisition", "EQ -4726", posting],
    ["a requisition that is a prefix of the URL's longer id", "REQ -4726", `${posting}5`],
  ])("rejects %s", (_case, requisition, url) => {
    expect(matchesWorkdayRequisition(url, requisition)).toBe(false);
  });
});
