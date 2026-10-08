// Fabricated examples; approval hashes computed independently with Python hashlib.
import type { CandidateConfig } from "../../src/config/types";
import type { NormalizedJob } from "../../src/sources";
import type { ScreeningDecision } from "../../src/screening/types";
export const CHICAGO_OPERATIONS: CandidateConfig = {
  "schemaVersion": 1,
  "identity": {
    "displayName": "Alex Example",
    "countryCode": "US",
    "subdivisionCode": "US-IL"
  },
  "policy": {
    "employmentTypes": [
      "full-time"
    ],
    "clearance": "review",
    "compensation": {
      "minimumBase": 100000,
      "currency": "USD",
      "period": "year"
    },
    "location": {
      "countryCode": "US",
      "subdivisionCode": "US-IL",
      "commuteLocations": [
        "Chicago, IL"
      ],
      "allowRemote": true,
      "allowOnsite": true,
      "allowHybrid": true
    },
    "functionLanes": [
      {
        "id": "A",
        "description": "Operations",
        "companyCategories": [
          "applied AI"
        ]
      }
    ]
  },
  "search": {
    "baselinePhrases": [
      "Operations"
    ],
    "functionPhrases": [
      "Operations manager"
    ],
    "openWebPhrases": [
      "Operations careers"
    ],
    "sources": [
      {
        "company": "Example Automation",
        "companyCategory": "applied AI",
        "ats": "greenhouse",
        "slug": "example-automation"
      }
    ],
    "unresolvedEmployers": [],
    "registry": []
  },
  "approval": {
    "readableSha256": "4e36c82b7c92f948c4707a26c5cc993957b50a9be67b50fdf1583d77529779ec",
    "policySha256": "f16d0dbd6c6d2e2f0119756fde9a5716b327f39a1e20f598a1ccb76df5452d76",
    "configSha256": "d5c13c7f8c8abbc3dc82f607241ac34aa14b2b0b5f4fb212944fa8e72406f7e6",
    "approvedAt": "2026-01-02T12:00:00Z"
  }
};
export const BOSTON_ENGINEERING: CandidateConfig = {
  "schemaVersion": 1,
  "identity": {
    "displayName": "Morgan Example",
    "countryCode": "US",
    "subdivisionCode": "US-MA"
  },
  "policy": {
    "employmentTypes": [
      "full-time"
    ],
    "clearance": "review",
    "compensation": {
      "minimumBase": 160000,
      "currency": "USD",
      "period": "year"
    },
    "location": {
      "countryCode": "US",
      "subdivisionCode": "US-MA",
      "commuteLocations": [
        "Boston, MA"
      ],
      "allowRemote": true,
      "allowOnsite": true,
      "allowHybrid": true
    },
    "functionLanes": [
      {
        "id": "A",
        "description": "Software engineering",
        "companyCategories": [
          "applied AI"
        ]
      }
    ]
  },
  "search": {
    "baselinePhrases": [
      "Software engineering"
    ],
    "functionPhrases": [
      "Software engineering manager"
    ],
    "openWebPhrases": [
      "Software engineering careers"
    ],
    "sources": [
      {
        "company": "Example Automation",
        "companyCategory": "applied AI",
        "ats": "greenhouse",
        "slug": "example-automation"
      }
    ],
    "unresolvedEmployers": [],
    "registry": []
  },
  "approval": {
    "readableSha256": "fee0ce6ce15316e9ff7a4dad690488f57c03b8efd1767f9f5f686315c40a85a2",
    "policySha256": "8ea12e6d92b48d0291950cf8e0144054165b3a1333cb484e08ac88081be72341",
    "configSha256": "b62f625205395fbb19dec5eef924b87560852185f86a41608478f8e19b6ef8da",
    "approvedAt": "2026-01-02T12:00:00Z"
  }
};
export const UK_REVIEW: CandidateConfig = {
  "schemaVersion": 1,
  "identity": {
    "displayName": "Jamie Example",
    "countryCode": "GB",
    "subdivisionCode": "GB-ENG"
  },
  "policy": {
    "employmentTypes": [
      "full-time"
    ],
    "clearance": "review",
    "compensation": {
      "minimumBase": null,
      "currency": "GBP",
      "period": "year"
    },
    "location": {
      "countryCode": "GB",
      "subdivisionCode": "GB-ENG",
      "commuteLocations": [
        "Manchester"
      ],
      "allowRemote": true,
      "allowOnsite": true,
      "allowHybrid": true
    },
    "functionLanes": [
      {
        "id": "A",
        "description": "Service design",
        "companyCategories": [
          "applied AI"
        ]
      }
    ]
  },
  "search": {
    "baselinePhrases": [
      "Service design"
    ],
    "functionPhrases": [
      "Service design manager"
    ],
    "openWebPhrases": [
      "Service design careers"
    ],
    "sources": [
      {
        "company": "Example Automation",
        "companyCategory": "applied AI",
        "ats": "greenhouse",
        "slug": "example-automation"
      }
    ],
    "unresolvedEmployers": [],
    "registry": []
  },
  "approval": {
    "readableSha256": "48a865b1fd02f848f302a0ba2553ec3682ea60b04376900ccc5c7da1601769d7",
    "policySha256": "25f542e0086b03de9b771b5fe24a3d8ed996a847a4b5e5dc0fed14b4c958af67",
    "configSha256": "09457fb219560e8d4cd6c3eb6c0e3e224e9a602ea24ba96f8d85be6cbaa774db",
    "approvedAt": "2026-01-02T12:00:00Z"
  }
};

export function posting(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return { id: "greenhouse:Example Automation:123", company: "Example Automation", title: "Operations manager", url: "https://example.com/jobs/123", location: "Chicago, IL", department: "Operations", isRemote: null, employmentType: "full-time", postedAt: null, compensation: null, description: "Synthetic job for testing.", ...overrides };
}
export function decision(overrides: Partial<ScreeningDecision> = {}): ScreeningDecision {
  return { state: "needs_review", lane: null, reason: "Synthetic decision awaiting evidence", evidence: [], gaps: ["Compensation unknown"], qualificationWarnings: [], hardExclude: null, criteriaVersion: "synthetic", promptVersion: "synthetic", model: "synthetic", ...overrides };
}
