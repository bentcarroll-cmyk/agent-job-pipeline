import instanceSchema from "../../schemas/instance.schema.json";
import { immutableConfig, validateConfigSchema } from "./candidate";
import type { InstanceConfig, InstanceDraft } from "./types";

export function parseInstanceDraft(raw: unknown): InstanceDraft {
  const config = immutableConfig(raw as InstanceDraft);
  validateConfigSchema(config, instanceSchema, "instance");
  if (config.cloudflare.fixedWorkerName === config.cloudflare.unboundedWorkerName)
    throw new Error("cloudflare: fixed and unbounded workers require distinct names");
  if (config.lifecycle.enabled && config.schedule.lifecycleLocalTime === null)
    throw new Error("schedule.lifecycleLocalTime: required when lifecycle is enabled");
  if (config.radar.enabled && (config.radar.channelId === null || config.schedule.radarLocalTime === null ||
    !config.radar.topics.length || config.radar.monthlyBudgetUsd <= 0))
    throw new Error("radar: enabled radar requires an explicit channel, schedule, topics and positive budget");
  return config;
}

export function parseInstanceConfig(raw: unknown): InstanceConfig {
  const draft = parseInstanceDraft(raw);
  if (draft.cloudflare.databaseId === null)
    throw new Error("cloudflare.databaseId: draft instance cannot activate or write to a remote ledger before provisioning");
  return draft as InstanceConfig;
}
