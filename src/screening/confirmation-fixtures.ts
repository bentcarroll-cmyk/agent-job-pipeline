import type { TextProvenance } from "../description";
import type { NormalizedJob } from "../sources";
import type { PolicyExpectation, PolicyFixture } from "./policy-fixtures";

// Independently authored confirmation cases. Labels and coverage stay outside
// the posting sent to the model; freeze this file before sampling any case.
const employment = "This is a permanent, full-time salaried position.";
const remote = "Employees in this position may work from home in any of the fifty US states. Maryland residents are eligible.";
const pay = "The annual base salary range is USD 185,000 to USD 235,000.";

function provenance(text: string | null, field: string): TextProvenance {
  return {
    provided: text !== null,
    originalChars: text?.length ?? null,
    retainedChars: text?.length ?? 0,
    truncated: text === null ? null : false,
    sourceFields: text === null ? [] : [`synthetic.${field}`],
    normalizerVersion: "confirmation-authored-text-v1",
  };
}

function posting(id: string, title: string, description: string | null, values: Partial<NormalizedJob> = {}): NormalizedJob {
  const job: NormalizedJob = {
    id: `synthetic:${id}`,
    company: "Synthetic Service Systems Company",
    title,
    url: `https://confirmation-fixtures.example/jobs/${id}`,
    location: "United States (remote)",
    department: "Business Operations",
    isRemote: true,
    employmentType: "Full-time",
    postedAt: null,
    compensation: pay,
    description,
    ...values,
  };
  job.contentProvenance = {
    description: provenance(job.description, "description"),
    compensation: provenance(job.compensation, "compensation"),
    coverageGaps: [],
  };
  return job;
}

function fixture(id: string, job: NormalizedJob, expected: PolicyExpectation, coverage: string[]): PolicyFixture {
  return { id, split: "heldout", source: "synthetic", job, expected, coverage };
}

export const CONFIRMATION_FIXTURES: PolicyFixture[] = [
  fixture("confirmation-degree-insurance-ops", posting(
    "confirmation-degree-insurance-ops", "Director, Claims Operations Modernization",
    [
      "Own the operating plan for insurance claims modernization. Prioritize AI-assisted workflow initiatives, coordinate rollout with claims leaders, and measure processing time, quality, and adoption across the business.",
      "Build the change-management program, establish operating reviews, and guide service teams through new procedures.",
      employment, remote, pay,
      "Minimum qualifications: a bachelor's degree in business, economics, or a related discipline, plus six years of experience leading regulated insurance claims operations.",
    ].join("\n"),
  ), {
    state: "match", hardExclude: null, evidenceFields: ["function", "location", "qualification"],
    qualificationPatterns: ["bachelor", "six years.*insurance claims|insurance claims.*six years|regulated insurance claims"],
    rationale: "Operational AI adoption and US remote eligibility support a possible match. The required degree and regulated insurance experience are both unconfirmed warnings, without an inferred candidate deficiency.",
  }, ["required bachelor's degree", "regulated-domain experience", "two qualification warnings", "possible match"]),

  fixture("confirmation-cpa-process-lead", posting(
    "confirmation-cpa-process-lead", "Head of Finance Process Transformation",
    [
      "Set the transformation agenda for finance service teams. Redesign reconciliation and reporting workflows, sponsor practical AI-assisted automation, and direct adoption planning with controllers and shared-services managers.",
      "Own the delivery roadmap, operating metrics, stakeholder communications, and training plan for these process changes.",
      employment, remote, pay,
      "Applicants must hold an active Certified Public Accountant (CPA) license issued by a US state.",
    ].join("\n"),
  ), {
    state: "match", hardExclude: null, evidenceFields: ["function", "location", "qualification"],
    qualificationPatterns: ["Certified Public Accountant|\\bCPA\\b"],
    rationale: "The work fits business transformation and can be performed from Maryland. The required CPA license must be surfaced as unconfirmed without rejecting or downgrading the role.",
  }, ["required professional license", "warning-only qualification uncertainty"]),

  fixture("confirmation-catalog-only-enablement", posting(
    "confirmation-catalog-only-enablement", "Director, AI Enablement Operations", null,
  ), {
    state: "needs_review", hardExclude: null, evidenceFields: [],
    gapPatterns: ["description|body|function|missing|unavailable"],
    rationale: "The catalog supplies a title and basic employment, pay, and location fields, but no responsibilities or qualification text. Review is necessary; the missing body cannot establish that all requirements or exclusions have been checked.",
  }, ["missing posting body", "title-only function inference prohibited", "no blanket eligibility-clearance claim"]),

  {
    ...fixture("confirmation-storage-engine-ic", posting(
      "confirmation-storage-engine-ic", "Senior Storage Engine Developer",
      [
        "Implement and maintain the C++ storage engine used by our model-training data platform. Write B-tree index code, tune the memory allocator, and improve transaction-log recovery.",
        "Profile CPU and disk bottlenecks, debug concurrency defects, and create correctness stress tests. Review implementation patches and produce low-level database design documents.",
        "This is an individual-contributor software engineering position reporting to the database engineering manager.",
        employment, remote, pay,
      ].join("\n"),
      { company: "Synthetic Model Data Infrastructure", department: "Database Engineering" },
    ), {
      state: "no_match", hardExclude: null, evidenceFields: ["function"],
      rationale: "The complete responsibilities describe core database implementation work, not either permitted business-function lane. An AI-infrastructure employer alone does not establish function fit.",
    }, ["complete core technical responsibilities", "AI employer does not establish function fit"]),
    companyCategory: "AI infrastructure",
  },

  fixture("confirmation-utility-enablement-unknown-pay", posting(
    "confirmation-utility-enablement-unknown-pay", "Senior Service Operations Enablement Manager",
    [
      "Lead the business rollout of AI-assisted customer-service workflows for a public utility. Define adoption milestones, redesign service procedures, and coordinate training with contact-center managers.",
      "Manage the implementation program, track service outcomes, and resolve operational handoffs across customer support, billing, and field service.",
      employment, remote,
      "A current Project Management Professional (PMP) certification is required.",
    ].join("\n"),
    { compensation: null },
  ), {
    state: "match", hardExclude: null, evidenceFields: ["function", "location", "qualification"],
    gapPatterns: ["compensation|salary|pay"],
    qualificationPatterns: ["Project Management Professional|\\bPMP\\b"],
    rationale: "The retained responsibilities and Maryland-eligible remote policy support a possible match. Unavailable pay and an unconfirmed required certification are nonblocking gaps, not grounds for review or rejection.",
  }, ["unknown compensation", "required certification", "combined nonblocking uncertainties"]),

  fixture("confirmation-remote-header-office-terms", posting(
    "confirmation-remote-header-office-terms", "Enterprise Workflow Transformation Manager",
    [
      "Run cross-functional workflow transformation programs, choose operational AI use cases with business leaders, and manage employee adoption and process-performance reviews.",
      employment, pay,
      "The appointment is based at our Phoenix, Arizona office. Attendance on site is required each weekday, and this opening does not permit work from home.",
    ].join("\n"),
    { location: "Remote within the United States", isRemote: true },
  ), {
    state: "needs_review", hardExclude: null, evidenceFields: ["location"],
    gapPatterns: ["conflict|contradict|inconsisten|location"],
    rationale: "The structured US-remote location conflicts with the description's mandatory Phoenix office attendance. Review must preserve that uncertainty rather than treating either eligibility or exclusion as decisive.",
  }, ["conflicting location fields", "no decisive exclusion claim in review"]),
];
