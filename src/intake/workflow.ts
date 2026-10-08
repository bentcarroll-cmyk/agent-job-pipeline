import { admitRunConfig, isActiveCriteria } from "../config/run-context";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { filterJob, type FilterEnv } from "../filter";
import type { Verdict } from "../criteria";
import type { NormalizedJob } from "../sources";
import { parseJobUrl } from "../unbounded/discovery";
import { resolvePostingUrl } from "../discovery/resolve";
import { fetchResolvedPosting } from "../discovery/fetch";
import { createSafePageFetcher } from "../discovery/safe-fetch";
import { configuredRegistry } from "../config/sources";
import { configureEnv, type ConfigBindings } from "../config/env";
import type { RuntimeConfig } from "../config/types";
import { recordProvenAlias } from "../discovery/aliases";
import { observedUrl } from "../discovery/observe";
import type { PostingFetchResult, ResolutionResult, ResolvedPosting, ResolverDependencies } from "../discovery/types";
import { jsonToStream, streamToJson } from "../step-stream";
import { claimAndSaveJob, holdProvisionalAliasConflict, readAdvisory, readIntake, saveAdvisory,
  saveResolutionResult, setIntakeStage } from "./store";
import type { WorkflowParams } from "./types";
import type { ManualCard, SendOutcome } from "./types";
import { sendManualCard } from "./delivery";
import { cancelManualDelivery, claimManualDelivery, finishManualDelivery,
  isManualDeliveryCurrent, readManualCardForDelivery } from "./delivery-store";
import type { SlackPostEnv } from "../slack";

export type IntakeWorkflowDeps = {
  resolve(url: string): Promise<ResolutionResult>;
  fetch(posting: ResolvedPosting): Promise<PostingFetchResult>;
  screen(job: NormalizedJob): Promise<Verdict>;
  now(): string;
  criteriaVersion?: string;
};

export type IntakeWorkflowEnv = FilterEnv & SlackPostEnv & ConfigBindings & { DB: D1Database };

function defaultDeps(env: IntakeWorkflowEnv & { runtime: RuntimeConfig }, inputUrl: string): IntakeWorkflowDeps {
  const registry = configuredRegistry(env.runtime);
  const hosts = new Set<string>(["boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com"]);
  for (const source of registry) {
    for (const host of [...source.careerHosts, ...source.atsHosts]) hosts.add(host);
  }
  const direct = parseJobUrl(inputUrl, "");
  if (direct) hosts.add(new URL(direct.url).hostname);
  const resolver: ResolverDependencies = { registry: registry,
    fetchPage: createSafePageFetcher({ allowedHosts: [...hosts] }),
    now: () => new Date().toISOString() };
  return { resolve: url => resolvePostingUrl({ url }, resolver),
    fetch: posting => fetchResolvedPosting(posting, resolver),
    screen: job => filterJob(env, job, undefined, { timing: "workflow" }),
    now: () => new Date().toISOString(), criteriaVersion: env.runtime.criteriaVersion };
}

async function current(db: D1Database, params: WorkflowParams): Promise<boolean> {
  const request = await readIntake(db, params.requestId);
  return !!request && request.workflowGeneration === params.generation &&
    !["delivered", "already_tracked", "held", "delivery_unknown"].includes(request.state);
}

function retryAt(generation: number, at: string): number {
  return Date.parse(at) + [60_000, 300_000, 900_000, 3_600_000][Math.min(generation, 3)];
}

async function hold(db: D1Database, params: WorkflowParams, stage: "resolve" | "fetch" | "save",
  code: string, detail: string, retryable: boolean, at: string): Promise<void> {
  await setIntakeStage(db, params.requestId, params.generation, {
    state: retryable ? "retry_wait" : "held", stage, at,
    failureCode: code, failureDetail: detail.slice(0, 1000),
    nextAttemptAt: retryable ? retryAt(params.generation, at) : 0,
  });
}

async function selectedOwner(db: D1Database, resolution: Extract<ResolutionResult, {kind:"resolved"}>): Promise<string | null | "conflict"> {
  const owners = new Set<string>();
  const identity = resolution.posting.kind === "employer"
    ? { employerKey: resolution.posting.employerKey, requisitionId: resolution.posting.requisitionId }
    : resolution.evidence.find(item => item.employerKey && item.requisitionId);
  for (const alias of [...resolution.aliases, resolution.posting.canonicalUrl]) {
    const row = await db.prepare(`SELECT owner_job_id,employer_key,requisition_id
      FROM discovery_job_aliases WHERE alias=?`).bind(alias).first<{
        owner_job_id:string;employer_key:string;requisition_id:string}>();
    if (row && identity?.employerKey && identity.requisitionId &&
      (row.employer_key !== identity.employerKey ||
        row.requisition_id.toLowerCase() !== identity.requisitionId.toLowerCase())) return "conflict";
    if (row) owners.add(row.owner_job_id);
  }
  if (identity?.employerKey && identity.requisitionId) {
    const owner = await db.prepare(`SELECT owner_job_id FROM discovery_job_owners
      WHERE employer_key=? AND requisition_key=?`)
      .bind(identity.employerKey, identity.requisitionId.toLowerCase())
      .first<{owner_job_id:string}>();
    if (owner) owners.add(owner.owner_job_id);
  }
  if (owners.size > 1) return "conflict";
  const owner = [...owners][0] ?? null;
  if (owner && !await db.prepare("SELECT id FROM jobs WHERE id=?").bind(owner).first())
    return "conflict";
  return owner;
}

async function writeAliases(db: D1Database, params: WorkflowParams,
  resolution: Extract<ResolutionResult, {kind:"resolved"}>, ownerJobId: string,
  at: string): Promise<boolean> {
  const evidence = resolution.evidence.find(item => item.employerKey && item.requisitionId &&
    resolution.aliases.includes(observedUrl(item.url) ?? ""));
  if (!evidence?.employerKey || !evidence.requisitionId) return true;
  const sourceUrl = observedUrl(evidence.url);
  if (!sourceUrl) return false;
  for (const alias of resolution.aliases) {
    const result = await recordProvenAlias(db,
      { kind: "manual_intake", requestId: params.requestId, generation: params.generation },
      { alias, ownerJobId, employerKey: evidence.employerKey,
        requisitionId: evidence.requisitionId, sourceUrl, verifiedAt: at,
        resolution });
    if (result === "conflict") return false;
  }
  return true;
}

async function runAdvisory(db: D1Database, params: WorkflowParams,
  step: WorkflowStep, deps: IntakeWorkflowDeps): Promise<void> {
  const request = await readIntake(db, params.requestId);
  if (!request || request.workflowGeneration !== params.generation) return;
  if (request.state === "screening") {
    if (!await readAdvisory(db, params.requestId))
      await saveAdvisory(db, params.requestId, params.generation, null,
        "advisory_uncertain", deps.now(), deps.criteriaVersion);
    return;
  }
  if (request.state !== "saved" || !request.jobId) return;
  await step.do("advisory", { timeout: "8 minutes",
    retries: { limit: 0, delay: "1 second" } }, async () => {
    const latest = await readIntake(db, params.requestId);
    if (!latest || latest.workflowGeneration !== params.generation || latest.state !== "saved") return;
    const stored = await db.prepare(`SELECT posting_json FROM manual_intake_requests WHERE id=?`)
      .bind(params.requestId).first<{posting_json:string|null}>();
    const job = stored?.posting_json ? JSON.parse(stored.posting_json) as NormalizedJob : null;
    if (!job || job.id !== latest.jobId) {
      await saveAdvisory(db, params.requestId, params.generation, null,
        "posting_unavailable", deps.now(), deps.criteriaVersion);
      return;
    }
    const active = await db.prepare(`SELECT j.application_status,j.application_status_source
      FROM jobs j JOIN manual_intake_jobs m ON m.job_id=j.id
      WHERE m.owner_request_id=? AND j.id=?`).bind(params.requestId, job.id)
      .first<{application_status:string;application_status_source:string|null}>();
    if (!active || active.application_status !== "needs_materials" ||
      active.application_status_source !== "manual") {
      await saveAdvisory(db, params.requestId, params.generation, null,
        "status_changed", deps.now(), deps.criteriaVersion);
      return;
    }
    await setIntakeStage(db, params.requestId, params.generation,
      { state: "screening", stage: "screen", at: deps.now() });
    try {
      const verdict = await deps.screen(job);
      await saveAdvisory(db, params.requestId, params.generation, verdict, null, deps.now(), deps.criteriaVersion);
    } catch {
      await saveAdvisory(db, params.requestId, params.generation, null, "provider_error", deps.now(), deps.criteriaVersion);
    }
  });
}

async function revalidateSavedSelection(db: D1Database, params: WorkflowParams,
  request: Awaited<ReturnType<typeof readIntake>>, step: WorkflowStep,
  deps: IntakeWorkflowDeps): Promise<boolean> {
  if (!request?.jobId) return false;
  const resolved = await streamToJson<ResolutionResult>(await step.do(
    "resolve", { timeout: "40 seconds", retries: { limit: 0, delay: "1 second" } },
    async () => jsonToStream(await deps.resolve(request.inputUrl))));
  if (resolved.kind !== "resolved") {
    await hold(db, params, "resolve", `resolve_${resolved.reason}`,
      resolved.detail, resolved.retryable, deps.now());
    return false;
  }
  const owner = await selectedOwner(db, resolved);
  if (owner === "conflict" || (owner && owner !== request.jobId) ||
    (!owner && resolved.posting.jobId !== request.jobId)) {
    await hold(db, params, "save", "invalid_identity",
      "Fresh posting identity differs from the saved selection", false, deps.now());
    return false;
  }
  const fetched = await streamToJson<PostingFetchResult>(await step.do(
    "fetch", { timeout: "25 seconds", retries: { limit: 0, delay: "1 second" } },
    async () => jsonToStream(await deps.fetch(resolved.posting))));
  if (fetched.kind === "held") {
    await hold(db, params, "fetch", `fetch_${fetched.reason}`,
      JSON.stringify({ sourceUrl: fetched.sourceUrl, httpStatus: fetched.httpStatus,
        detail: fetched.detail }), fetched.retryable, deps.now());
    return false;
  }
  if (fetched.kind === "not_found") {
    await hold(db, params, "fetch", "fetch_not_found", JSON.stringify(fetched), false, deps.now());
    return false;
  }
  if (fetched.job.id !== resolved.posting.jobId) {
    await hold(db, params, "save", "invalid_identity",
      "Fresh posting disagrees with its resolved identity", false, deps.now());
    return false;
  }
  const stored = await db.prepare(`SELECT posting_json FROM manual_intake_requests
    WHERE id=? AND workflow_generation=? AND job_id=?`)
    .bind(params.requestId, params.generation, request.jobId)
    .first<{posting_json:string|null}>();
  if (!stored?.posting_json || stored.posting_json !== JSON.stringify(fetched.job)) {
    await hold(db, params, "fetch", "posting_changed",
      "Fresh source content differs from the saved manual selection", false, deps.now());
    return false;
  }
  return await current(db, params);
}

export async function executeManualIntake(db: D1Database, params: WorkflowParams,
  step: WorkflowStep, deps: IntakeWorkflowDeps): Promise<void> {
  if (!await current(db, params)) return;
  const request = await readIntake(db, params.requestId);
  if (!request) return;
  if (params.generation > 0 && request.jobId &&
    (["saved", "screening", "ready"].includes(request.state) ||
      (request.state === "retry_wait" && request.stage === "deliver"))) {
    if (!await revalidateSavedSelection(db, params, request, step, deps)) return;
  }
  if (request.state === "ready" || request.state === "delivering" ||
    (request.state === "retry_wait" && request.stage === "deliver")) return;
  if (request.state === "saved" || request.state === "screening") {
    await runAdvisory(db, params, step, deps);
    return;
  }
  const resolution = await streamToJson<ResolutionResult | {kind:"stale"}>(await step.do(
    "resolve", { timeout: "40 seconds", retries: { limit: 0, delay: "1 second" } }, async () => {
      if (!await current(db, params) || !await setIntakeStage(db, params.requestId,
        params.generation, { state: "resolving", stage: "resolve", at: deps.now() }))
        return jsonToStream({ kind: "stale" });
      const result = await deps.resolve(request.inputUrl);
      await saveResolutionResult(db, params.requestId, params.generation, result, deps.now());
      if (result.kind === "held") await hold(db, params, "resolve", `resolve_${result.reason}`,
        result.detail, result.retryable, deps.now());
      return jsonToStream(result);
    }));
  if (resolution.kind !== "resolved" || !await current(db, params)) return;
  const fetched = await streamToJson<PostingFetchResult | {kind:"stale"}>(await step.do(
    "fetch", { timeout: "25 seconds", retries: { limit: 0, delay: "1 second" } }, async () => {
      if (!await current(db, params) || !await setIntakeStage(db, params.requestId,
        params.generation, { state: "fetching", stage: "fetch", at: deps.now() }))
        return jsonToStream({ kind: "stale" });
      const result = await deps.fetch(resolution.posting);
      if (result.kind === "held") await hold(db, params, "fetch", `fetch_${result.reason}`,
        JSON.stringify({ sourceUrl: result.sourceUrl, httpStatus: result.httpStatus,
          detail: result.detail }), result.retryable, deps.now());
      else if (result.kind === "not_found") await hold(db, params, "fetch", "fetch_not_found",
        JSON.stringify(result), false, deps.now());
      return jsonToStream(result);
    }));
  if (fetched.kind !== "fetched" || !await current(db, params)) return;
  if (fetched.job.id !== resolution.posting.jobId) {
    await hold(db, params, "save", "invalid_identity", "Fetched posting identity differs from resolution", false, deps.now());
    return;
  }
  const claim = await step.do("save-selection", { timeout: "30 seconds",
    retries: { limit: 0, delay: "1 second" } }, async () => {
    if (!await current(db, params)) return { kind: "stale" } as const;
    const owner = await selectedOwner(db, resolution);
    if (owner === "conflict") {
      await hold(db, params, "save", "alias_conflict", "Verified aliases have different owners", false, deps.now());
      return { kind: "held" } as const;
    }
    const mapped = owner ? { ...fetched.job, id: owner } : fetched.job;
    const result = await claimAndSaveJob(db, params.requestId, params.generation,
      mapped, deps.now(), owner ? undefined : resolution, deps.criteriaVersion);
    if ((owner && result.kind === "owned") || result.kind === "existing") {
      if (!await writeAliases(db, params, resolution, result.jobId, deps.now())) {
        if (!await holdProvisionalAliasConflict(db, params.requestId,
          params.generation, result.jobId, deps.now()))
          await hold(db, params, "save", "alias_conflict", "A proven alias has another owner", false, deps.now());
        return { kind: "held" } as const;
      }
    }
    return result;
  });
  if (claim.kind !== "owned" || !await current(db, params)) return;
  await runAdvisory(db, params, step, deps);
}

export async function executeManualDelivery(db: D1Database, params: WorkflowParams,
  step: WorkflowStep, send: (card: ManualCard, deliveryId: string) => Promise<SendOutcome>,
  now: () => string, commit = finishManualDelivery, instanceId?: string, runtime?: RuntimeConfig): Promise<void> {
  if (!runtime || !instanceId || !await isActiveCriteria(db, instanceId, runtime.criteriaVersion)) return;
  const request = await readIntake(db, params.requestId);
  if (!request || request.workflowGeneration !== params.generation ||
    !["ready", "retry_wait", "delivering"].includes(request.state) ||
    (request.state === "retry_wait" && request.stage !== "deliver")) return;
  const prepared = await step.do("prepare-delivery", { timeout: "30 seconds",
    retries: { limit: 0, delay: "1 second" } }, async () => {
    const claim = await claimManualDelivery(db, params.requestId, params.generation, now(), instanceId);
    return claim?.deliveryId ?? null;
  });
  if (!prepared) return;
  await step.do("deliver", { timeout: "50 seconds",
    retries: { limit: 0, delay: "1 second" } }, async () => {
    if (!await isManualDeliveryCurrent(db, prepared, params.generation, instanceId, runtime.criteriaVersion)) {
      await cancelManualDelivery(db, prepared, params.generation, now());
      return;
    }
    const card = await readManualCardForDelivery(db, prepared, params.generation);
    if (!card) {
      await finishManualDelivery(db, prepared, params.generation,
        { kind: "unknown", code: "card_unavailable" }, now());
      return;
    }
    let outcome: SendOutcome;
    try { outcome = await send(card, prepared); }
    catch { outcome = { kind: "unknown", code: "transport_uncertain" }; }
    try { await commit(db, prepared, params.generation, outcome, now()); }
    catch {
      try { await finishManualDelivery(db, prepared, params.generation,
        { kind: "unknown", code: "receipt_commit_uncertain" }, now()); }
      catch { /* A durable sending row prevents automatic resend. */ }
    }
  });
}

export class ManualIntakeWorkflow extends WorkflowEntrypoint<IntakeWorkflowEnv, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void | { skipped: string }> {
    const env = await configureEnv(this.env);
    if (env.instance.shadowMode) return { skipped: "preview" };
    env.runtime = await admitRunConfig(env.DB, event.instanceId, env.runtime);
    const request = await readIntake(env.DB, event.payload.requestId);
    if (!request) return;
    await executeManualIntake(env.DB, event.payload, step,
      defaultDeps(env, request.inputUrl));
    await executeManualDelivery(env.DB, event.payload, step,
      (card, deliveryId) => sendManualCard(env, card, deliveryId),
      () => new Date().toISOString(), undefined, env.instance.instanceId, env.runtime);
  }
}
