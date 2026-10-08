import type { RuntimeConfig } from "../config/types";
import type { DiscoveryConfigVersions } from "./types";

// Runtime provenance must identify the executing Worker, including replay
// after a release. The release packet maps this ID to its reviewed source.
export function discoveryCodeVersion(metadata: WorkerVersionMetadata | undefined): string {
  if (!metadata || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(metadata.id)) {
    throw new Error("Discovery accounting requires Worker version metadata");
  }
  return `worker:${metadata.id}`;
}

export function discoveryConfigVersions(runtime: RuntimeConfig): DiscoveryConfigVersions {
  return { queryVersion: `q-${runtime.criteriaVersion}`, registryVersion: runtime.criteriaVersion };
}
