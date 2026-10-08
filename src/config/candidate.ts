import candidateSchema from "../../schemas/candidate.schema.json";
import type { CandidateConfig, CandidatePolicy, RuntimeConfig } from "./types";

type Schema = {
  type?: string; const?: unknown; enum?: readonly unknown[]; anyOf?: readonly Schema[];
  properties?: Record<string, Schema | undefined>; required?: readonly string[]; additionalProperties?: boolean;
  items?: Schema; minItems?: number; uniqueItems?: boolean;
  minLength?: number; pattern?: string; format?: string; minimum?: number; maximum?: number;
};

const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function validFormat(value: string, format: string): boolean {
  switch (format) {
    case "date": return validDate(value);
    case "date-time": return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "iana-timezone":
      if (!/^[A-Za-z_][A-Za-z0-9_+\/-]*$/.test(value)) return false;
      try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
    case "https-url":
      try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; } catch { return false; }
    case "hostname": return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
    default: throw new Error(`Unsupported configuration schema format: ${format}`);
  }
}

/** Validates the published schemas' small, explicit JSON Schema subset. No coercion or defaults. */
export function validateConfigSchema(value: unknown, schema: Schema, path = "config"): void {
  const fail = (detail: string): never => { throw new Error(`${path}: ${detail}`); };
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      try { validateConfigSchema(value, branch, path); return; } catch { /* Try the next allowed shape. */ }
    }
    fail("does not match any allowed configuration shape");
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) fail("unsupported value or schema version");
  if (schema.enum && !schema.enum.includes(value)) fail("unsupported value");
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("expected a plain object");
      const object = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) fail(`missing required field ${key}`);
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) fail(`unexpected field ${key}`);
        validateConfigSchema(object[key], schema.properties![key]!, `${path}.${key}`);
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) fail("expected an array");
      const array = value as unknown[];
      if (array.length < (schema.minItems ?? 0)) fail("empty or incomplete rule set");
      // Holes and undefined values are invalid, even though JSON.stringify hides them.
      for (let index = 0; index < array.length; index++) validateConfigSchema(array[index], schema.items!, `${path}[${index}]`);
      if (schema.uniqueItems && new Set(array.map(canonical)).size !== array.length) fail("duplicate entries");
      break;
    }
    case "string":
      if (typeof value !== "string") fail("expected a string");
      if ((value as string).length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value as string)) ||
        (schema.format && !validFormat(value as string, schema.format))) fail("invalid string value");
      break;
    case "number": case "integer":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) fail("expected a finite number");
      if ((schema.minimum !== undefined && (value as number) < schema.minimum) || (schema.maximum !== undefined && (value as number) > schema.maximum)) fail("number outside supported range");
      break;
    case "boolean": if (typeof value !== "boolean") fail("expected an explicit boolean"); break;
    case "null": if (value !== null) fail("expected null"); break;
    case undefined: break;
    default: fail("unsupported configuration schema type");
  }
}

export function immutableConfig<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

function checkGeography(countryCode: string, subdivisionCode: string | null, path: string): void {
  if (subdivisionCode !== null && !subdivisionCode.startsWith(`${countryCode}-`)) throw new Error(`${path}: subdivision must belong to the explicit country`);
}

export function parseCandidateConfig(raw: unknown): CandidateConfig {
  const config = immutableConfig(raw as CandidateConfig);
  validateConfigSchema(config, candidateSchema);
  const { identity, policy, search } = config;
  checkGeography(identity.countryCode, identity.subdivisionCode, "identity");
  checkGeography(policy.location.countryCode, policy.location.subdivisionCode, "policy.location");
  if (identity.countryCode !== policy.location.countryCode || identity.subdivisionCode !== policy.location.subdivisionCode)
    throw new Error("identity and policy location geography conflict");
  if (!policy.location.allowRemote && !policy.location.allowOnsite && !policy.location.allowHybrid)
    throw new Error("policy.location: at least one work arrangement must be allowed");
  if ((policy.location.allowOnsite || policy.location.allowHybrid) && !policy.location.commuteLocations.length)
    throw new Error("policy.location: onsite and hybrid rules require explicit commute locations");
  if (new Set(policy.functionLanes.map(lane => lane.id)).size !== policy.functionLanes.length)
    throw new Error("policy.functionLanes: duplicate lane identifiers");
  if (!(search.baselinePhrases.length + search.functionPhrases.length + search.openWebPhrases.length + search.sources.length + search.registry.length))
    throw new Error("search: empty search rule set");
  if (new Set(search.registry.map(source => source.key)).size !== search.registry.length)
    throw new Error("search.registry: duplicate employer keys");
  return config;
}

/** Object keys sort lexically; array order remains decision-affecting. Only validated JSON enters hashes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function candidatePolicyHash(policy: CandidatePolicy): Promise<string> {
  const snapshot = immutableConfig(policy);
  validateConfigSchema(snapshot, candidateSchema.properties.policy);
  return sha256(snapshot);
}
export async function candidateCriteriaVersion(config: CandidateConfig): Promise<string> {
  const { schemaVersion, identity, policy, search } = parseCandidateConfig(config);
  return sha256({ schemaVersion, identity, policy, search });
}
export async function loadRuntimeConfig(raw: unknown): Promise<RuntimeConfig> {
  // Freeze a detached snapshot before yielding so callers cannot mutate the checked configuration.
  const candidate = parseCandidateConfig(raw);
  const policyHash = await candidatePolicyHash(candidate.policy);
  const criteriaVersion = await candidateCriteriaVersion(candidate);
  if (policyHash !== candidate.approval.policySha256 || criteriaVersion !== candidate.approval.configSha256)
    throw new Error("Candidate approval does not match current policy/search/identity; review and approve the changed configuration");
  // readableSha256 records the separately approved human-readable criteria artifact.
  // Its bytes are not part of this credential-free config, so it is structurally validated only.
  return immutableConfig({ candidate, criteriaVersion });
}
