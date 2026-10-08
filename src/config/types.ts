import type { CompanyCategory, Source } from "../sources";
import type { EmployerSource } from "../discovery/types";

export type CandidatePolicy = {
  employmentTypes: readonly string[];
  clearance: "exclude_active" | "allow" | "review";
  compensation: { minimumBase: number | null; currency: string; period: "year" };
  location: { countryCode: string; subdivisionCode: string | null; commuteLocations: readonly string[]; allowRemote: boolean; allowOnsite: boolean; allowHybrid: boolean };
  functionLanes: readonly { id: "A" | "B"; description: string; companyCategories: readonly CompanyCategory[] }[];
};
export type SearchSettings = {
  baselinePhrases: readonly string[];
  functionPhrases: readonly string[];
  openWebPhrases: readonly string[];
  sources: readonly Source[];
  unresolvedEmployers: readonly string[];
  registry: readonly EmployerSource[];
};
export type CandidateConfig = {
  schemaVersion: 1;
  identity: { displayName: string; countryCode: string; subdivisionCode: string | null };
  policy: CandidatePolicy;
  search: SearchSettings;
  approval: { readableSha256: string; policySha256: string; configSha256: string; approvedAt: string };
};
export type RuntimeConfig = { candidate: CandidateConfig; criteriaVersion: string };
export type ScheduleConfig = {
  timezone: string;
  discoveryLocalTimes: readonly string[];
  discoveryWeekdays: readonly number[];
  lifecycleLocalTime: string | null;
  radarLocalTime: string | null;
};
export type InstanceConfig = {
  schemaVersion: 1;
  instanceId: string;
  operator: { displayName: string; contactEmail: string };
  cloudflare: { accountId: string; databaseName: string; databaseId: string; fixedWorkerName: string; unboundedWorkerName: string; gatewayId: string };
  slack: { channelId: string; allowedUserId: string };
  lifecycle: { enabled: boolean; since: string; oauthMode: "testing" | "personal" | "verified" };
  schedule: ScheduleConfig;
  screeningMode: "legacy" | "evidence";
  manualScreeningMode: "legacy" | "evidence";
  shadowMode: boolean;
  radar: { enabled: boolean; channelId: string | null; monthlyBudgetUsd: number; topics: readonly string[] };
};
export type InstanceDraft = Omit<InstanceConfig, "cloudflare"> & {
  cloudflare: Omit<InstanceConfig["cloudflare"], "databaseId"> & { databaseId: string | null };
};
