import type { Source } from "../sources";
import type { EmployerSource } from "../discovery/types";
import type { RuntimeConfig } from "./types";

export function configuredSources(config: RuntimeConfig): readonly Source[] {
  return config.candidate.search.sources;
}
export function configuredRegistry(config: RuntimeConfig): readonly EmployerSource[] {
  return config.candidate.search.registry;
}
