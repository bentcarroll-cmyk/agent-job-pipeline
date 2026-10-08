import { hasFixedBaseline, completeFixedBaseline, baselineSources } from "./discovery/baseline";
import { authorizedTrigger } from "./operations/auth";
import { admitRunConfig, isCurrentCriteria } from "./config/run-context";
import { dueWorkflows } from "./config/schedule";
import { startScheduledWorkflow } from "./lifecycle/cron";
import { configureEnv, type ConfigBindings } from "./config/env";
import { configuredSources } from "./config/sources";
import type { RuntimeConfig, InstanceConfig } from "./config/types";
import { withDiscoveryLease, triggerDiscovery, type DiscoverySteps } from "./operations/discovery-run";
import { fencedBatch, LeaseLostError, type DiscoveryLease } from "./operations/leases";
import { getCoolingDownIds, clearFailures } from "./operations/retries";
import { runFilterStep } from "./operations/filter-step";
import { discoveryCodeVersion, discoveryConfigVersions } from "./discovery/version";
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { fetchAllPostings, canonicalizeAtsUrl, fixedSourceForJob, type NormalizedJob } from "./sources";
import {
  jobInsertStatement,
  getExistingAtsJobOwners,
  touchLastSeen,
  lookupKnownAtsApplication,
  insertJobs,
  recordRun,
  isLegacyNotificationPending,
  markNotified,
  type JobInsert,
} from "./db";
import { hydrateFixedJob, screenHydratedFixedJob } from "./screen-fixed-job";
import { postMatch, postText, type SlackPostEnv } from "./slack";
import { boardDigestMessage } from "./board-digest";
import { screeningHoldMessage, applicationIdentityHoldMessage } from "./screening-holds";
import { readDiscoveryApplicationState, reconcileDiscoveryHolds, actionableHoldErrors } from "./discovery/application-state";
import { loadApplicationAwareNotifications } from "./discovery/application-notifications";
import { splitSlackText } from "./slack-text";
import { LocationEligibilityError } from "./location";
import { jsonToStream, streamToJson } from "./step-stream";
import type { FilterEnv } from "./filter";
import { saveDiscoveryScreening, recordDiscoveryFailure } from "./screening/workflow";
import { isScreeningNotificationPending, markScreeningNotified } from "./screening/store";
import { prepareLocationNotifications, isLocationNotificationReady, locationHoldMessage } from "./location-notifications";
import { startDiscoveryRun, recordStageOutcome, recordStageOutcomes, recordCreatedDeliveryIntent, recordDeliveryAttempt, finishDiscoveryRun, type Stage } from "./discovery/coverage";
import { observeFixedSource, observeFixedAggregate } from "./discovery/observe";
import { reconcileIncompleteRuns } from "./operations/run-health";
import { readDiscoveryReport } from "./operations/discovery-report";
import { persistFixedCandidate, loadClaimedFixedCandidates, settleFixedAliasCandidate, holdFixedOwnerConflict } from "./discovery/fixed-candidates";
import { selectCandidateBatch, settleCandidate, settleOutstandingCandidates } from "./discovery/candidates";

interface Env extends ConfigBindings, SlackPostEnv, FilterEnv {
  AGENT_WORKFLOW: Workflow;
  DB: D1Database;
  AI_GATEWAY_ID: string;
  TRIGGER_SECRET: string;
  DISCOVERY_ACCOUNTING_MODE?: "off" | "on";
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  DISCOVERY_QUEUE_MODE?: "off" | "on";
}

type NewPostingsPlan = { toFilter: NormalizedJob[]; alreadyApplied: number; errors: string[]; cooldownDeferred: number };

// Bound notification volume when a policy change admits too many matches.
const MAX_NOTIFICATIONS_PER_RUN = 50;

export class AgentWorkflow extends WorkflowEntrypoint<Env, {}> {
  async run(event: WorkflowEvent<{}>, rawStep: WorkflowStep) {
    const env = await configureEnv(this.env);
    if (env.instance.shadowMode) return { skipped: "preview" };
    env.runtime = await admitRunConfig(env.DB, event.instanceId, env.runtime);
    return withDiscoveryLease(env.DB, "fixed_boards", event.instanceId, rawStep,
      (step, lease) => this.runOwned(step, lease, env));
  }

  private async runOwned(step: DiscoverySteps, lease: DiscoveryLease, env: Env & { runtime: RuntimeConfig; instance: InstanceConfig }) {
    const db = env.DB;
    const sources = configuredSources(env.runtime);
    const unresolved = [...env.runtime.candidate.search.unresolvedEmployers];
    const now = new Date().toISOString();
    const evidenceMode = env.SCREENING_MODE === "evidence";
    const accounting = env.DISCOVERY_ACCOUNTING_MODE === "on";
    const durableQueue = env.DISCOVERY_QUEUE_MODE === "on";
    if (durableQueue && !accounting) throw new Error("Fixed candidate queue requires discovery accounting");
    const observeSource = async (event: Parameters<typeof observeFixedSource>[2]) => {
      try { await observeFixedSource(db, lease, event); }
      catch (error) {
        if (error instanceof LeaseLostError) throw error;
        console.error("Fixed source accounting unavailable", { source: event.source.company,
          status: event.status, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        throw error;
      }
    };
    const account = async (stage: Stage, itemId: string, outcome: string,
      errorCode: string | null = null): Promise<void> => {
      if (!accounting) return;
      await recordStageOutcome(db, lease, { runId: lease.owner, itemId, stage, outcome,
        at: new Date().toISOString(), errorCode, detail: null });
    };
    if (accounting) await step.do("accounting-start", async () => {
      await startDiscoveryRun(db, lease, { runId: lease.owner, pipeline: lease.pipeline,
        codeVersion: discoveryCodeVersion(env.CF_VERSION_METADATA), ...discoveryConfigVersions(env.runtime), startedAt: now });
    });

    const isBootstrap = await step.do("check-bootstrap", async () => !await hasFixedBaseline(db, env.instance.instanceId, sources));

    // The full board snapshot never leaves a step: even with metadata-only
    // Greenhouse listings, it can exceed a step's 1 MiB return cap. Each
    // branch below fetches, diffs and writes inside one step and returns only
    // what later steps need.

    if (isBootstrap) {
      // First complete snapshot for this instance/source configuration: record every currently-open
      // posting as a baseline row (checking known_applications so historical
      // applications get their real status, not a generic placeholder), but
      // don't run GLM on the backlog and don't notify — "newly posted" means
      // since baseline, not since the beginning of time.
      const baseline = await step.do("write-baseline", async () => {
        const completed = new Set<string>();
        const { jobs, errors } = await fetchAllPostings(sources, async event => {
          if (accounting) await observeSource(event);
          if (event.status === "complete") completed.add(baselineSources([event.source]));
        });
        const existing = await getExistingAtsJobOwners(db, jobs, sources);
        const rows: JobInsert[] = [];
        for (const job of jobs) {
          if (existing.has(job.id)) continue;
          const lookup = await lookupKnownAtsApplication(db, { jobId: job.id,
            postingId: canonicalizeAtsUrl(job.url) ?? job.id.split(":").at(-1) ?? "",
            employerName: job.company, postingUrl: job.url });
          if (lookup.kind === "ambiguous") {
            await account("select", job.id, "identity_review");
            errors.push(`${job.id}: ambiguous known application identity requires review`);
            continue;
          }
          await account("select", job.id, "existing");
          const known = lookup.kind === "matched" ? lookup.application : null;
          rows.push({
            job,
            firstSeenAt: now,
            criteriaVersion: env.runtime.criteriaVersion,
            isKnownApplication: known !== null,
            knownApplicationSource: known?.source_job_id ?? null,
            verdict: null,
            applicationStatus: known?.status ?? "not_applied",
            applicationStatusSource: known ? "import" : "pipeline",
          });
        }
        // Restartable inserts preserve shared ownership, status and existing retry evidence.
        for (let i = 0; i < rows.length; i += 50) await fencedBatch(db, lease,
          rows.slice(i, i + 50).map(row => jobInsertStatement(db, row)));
        if (sources.length > 0 && errors.length === 0 && sources.every(source => completed.has(baselineSources([source]))))
          await completeFixedBaseline(db, lease, env.instance.instanceId, sources);
        return { jobCount: jobs.length, knownCount: rows.filter((r) => r.isKnownApplication).length, errors };
      });

      await step.do("record-run", async () =>
        recordRun(db, {
          sourcesOk: sources.length - baseline.errors.length,
          sourcesFailed: baseline.errors.length,
          newPostings: 0,
          alreadyAppliedSkipped: baseline.knownCount,
          matches: 0,
          errors: baseline.errors,
        }, lease),
      );
      if (accounting) await step.do("accounting-finish", async () =>
        finishDiscoveryRun(db, lease, lease.owner, baseline.errors.length ? "partial" : "complete",
          new Date().toISOString()));

      return { baseline: true, jobCount: baseline.jobCount, knownApplications: baseline.knownCount };
    }

    // Memoizing the partition in this one step also keeps it stable on
    // replay: a known_applications row written mid-run (by the materials
    // tool or the lifecycle tracker) can't move a posting between the two
    // sides and change the filter:* step names below.
    // New postings usually number a handful, but a company can post dozens
    // at once, so they come back as a stream: bounded by instance storage
    // rather than the 1 MiB cap, so no burst is ever dropped or deferred.
    const planStream = await step.do("fetch-new-postings", async () => {
      let observed = false;
      const { jobs, errors } = await fetchAllPostings(sources, accounting ? async event => {
        observed = true;
        await observeSource(event);
      } : undefined);
      if (accounting && !observed) await observeFixedAggregate(db, lease, jobs, errors);
      const identityConflicts = durableQueue ? new Set<string>() : undefined;
      const existing = await getExistingAtsJobOwners(db, jobs, sources, identityConflicts);
      await touchLastSeen(db, [...new Set(existing.values())], now, lease);
      for (const job of jobs) {
        const ownerId = existing.get(job.id);
        if (!ownerId || ownerId === job.id) continue;
        const owner = await db.prepare(`SELECT match,is_known_application,application_status,notified_at
          FROM jobs WHERE id=?`).bind(ownerId).first<{
            match: number | null; is_known_application: number;
            application_status: string; notified_at: string | null;
          }>();
        // Durable candidates reconcile the retry and its accounting atomically
        // before arbitration, including candidates absent from today's board.
        const retained = durableQueue && await db.prepare(`SELECT candidate_key FROM discovery_candidates
          WHERE pipeline='fixed_boards' AND candidate_key=?`).bind(job.id).first();
        if (!retained && owner && (owner.match !== null || owner.is_known_application === 1 ||
          owner.application_status !== "not_applied" || owner.notified_at !== null)) {
          await clearFailures(db, lease, [job.id]);
        }
      }

      if (accounting) await recordStageOutcomes(db, lease, jobs.filter(job => existing.has(job.id)).map(job => ({
        runId: lease.owner, itemId: job.id, stage: "select", outcome: "existing", at: now, errorCode: null, detail: null,
      })));
      const knownRows: JobInsert[] = [];
      const fresh: NormalizedJob[] = [];
      for (const job of jobs) {
        if (identityConflicts?.has(job.id)) {
          await persistFixedCandidate(db, lease, job, `${job.id.split(":")[0]}:${job.company}`, now, sources);
          const retained = await db.prepare(`SELECT current_url FROM discovery_candidates
            WHERE pipeline='fixed_boards' AND candidate_key=?`).bind(job.id).first<{current_url:string}>();
          if (!retained) throw new Error("Fixed conflict context was not retained");
          await holdFixedOwnerConflict(db, lease, job.id, retained.current_url, Date.now());
          errors.push(`${job.id}: ambiguous ATS owner requires review`);
          continue;
        }
        if (existing.has(job.id)) continue;
        const lookup = await lookupKnownAtsApplication(db, { jobId: job.id,
          postingId: canonicalizeAtsUrl(job.url) ?? job.id.split(":").at(-1) ?? "",
          employerName: job.company, postingUrl: job.url });
        if (lookup.kind === "ambiguous") {
          await account("select", job.id, "identity_review");
          errors.push(`${job.id}: ambiguous known application identity requires review`);
          continue;
        }
        const known = lookup.kind === "matched" ? lookup.application : null;
        if (known) {
          await account("select", job.id, "known_application");
          knownRows.push({
            job,
            firstSeenAt: now,
            criteriaVersion: env.runtime.criteriaVersion,
            isKnownApplication: true,
            knownApplicationSource: known.source_job_id,
            verdict: null,
            applicationStatus: known.status ?? "applied",
            applicationStatusSource: "import",
          });
        } else {
          fresh.push(job);
        }
      }
      // Known applications need no verdict, so they are written here rather
      // than carried out of the step. ON CONFLICT DO NOTHING makes a retry
      // of this step harmless.
      await insertJobs(db, knownRows, lease);

      if (durableQueue) {
        // Save board identity and a bounded listing context before selection.
        // Later runs can retry a detail fetch without relying on this board
        // returning the same item again.
        for (const job of fresh) {
          const sourceId = `${job.id.split(":")[0]}:${job.company}`;
          await persistFixedCandidate(db, lease, job, sourceId, now, sources);
        }
        return jsonToStream({ toFilter: [], alreadyApplied: knownRows.length,
          errors, cooldownDeferred: 0 } satisfies NewPostingsPlan);
      }

      const cooling = await getCoolingDownIds(db, lease.pipeline, fresh.map(j => j.id));
      for (const job of fresh) await account("select", job.id, cooling.has(job.id) ? "cooldown" : "selected");
      const result: NewPostingsPlan = { toFilter: fresh.filter(j => !cooling.has(j.id)), alreadyApplied: knownRows.length, errors, cooldownDeferred: cooling.size };
      return jsonToStream(result);
    });
    // Re-read on every replay: step.do hands back a fresh stream each time.
    const plan = await streamToJson<NewPostingsPlan>(planStream);
    const { errors } = plan;
    let toFilter = plan.toFilter;
    if (durableQueue) {
      await step.do("claim-fixed-candidates", async () => selectCandidateBatch(db, lease,
        { now: Date.now(), totalLimit: 500, dueRetryLimit: 50, sources }));
      const claimed = await loadClaimedFixedCandidates(db, lease);
      // A later user decision must not rewrite this run's immutable selection
      // on replay. Fresh filter/save/summary checks still protect that decision.
      const selected = new Set((await db.prepare(`SELECT item_id FROM discovery_run_items
        WHERE run_id=? AND stage='select' AND outcome='selected'`)
        .bind(lease.owner).all<{ item_id: string }>()).results.map(row => row.item_id));
      const identityConflicts = new Set<string>();
      const existing = await getExistingAtsJobOwners(db, claimed.map(item => item.job), sources, identityConflicts);
      toFilter = [];
      for (const item of claimed) {
        if (selected.has(item.job.id)) { toFilter.push(item.job); continue; }
        if (identityConflicts.has(item.job.id)) {
          await settleCandidate(db, lease, item.claim,
            { status: "held", failureCategory: "ambiguous_ats_owner" });
          await account("select", item.job.id, "identity_review");
          continue;
        }
        if (existing.has(item.job.id)) {
          const state = await db.prepare(`SELECT match,is_known_application,application_status
            FROM jobs WHERE id=?`).bind(existing.get(item.job.id)).first<{
              match:number|null;is_known_application:number;application_status:string}>();
          if (!state) throw new Error("Fixed candidate owner changed during selection");
          if (state.match === null && state.is_known_application === 0 &&
            state.application_status === "not_applied") {
            await settleCandidate(db, lease, item.claim,
              { status: "held", failureCategory: "existing_unassessed_requires_review" });
            await account("select", item.job.id, "identity_review");
          } else {
            await clearFailures(db, lease, [item.job.id]);
            const ownerId = existing.get(item.job.id)!;
            if (ownerId === item.job.id) await settleCandidate(db, lease, item.claim, { status: "complete" });
            else await settleFixedAliasCandidate(db, lease, item.claim, item.job, ownerId);
            await account("select", item.job.id, "existing");
          }
          continue;
        }
        const lookup = await lookupKnownAtsApplication(db, { jobId: item.job.id,
          postingId: canonicalizeAtsUrl(item.job.url) ?? item.job.id.split(":").at(-1) ?? "",
          employerName: item.job.company, postingUrl: item.job.url });
        if (lookup.kind === "ambiguous") {
          await settleCandidate(db, lease, item.claim,
            { status: "held", failureCategory: "ambiguous_application_identity" });
          await account("select", item.job.id, "identity_review");
          continue;
        }
        if (lookup.kind === "matched") {
          await insertJobs(db, [{ job: item.job, firstSeenAt: now,
            criteriaVersion: env.runtime.criteriaVersion,
            isKnownApplication: true, knownApplicationSource: lookup.application.source_job_id,
            verdict: null, applicationStatus: lookup.application.status ?? "applied",
            applicationStatusSource: "import" }], lease);
          await settleCandidate(db, lease, item.claim, { status: "complete" });
          await account("select", item.job.id, "known_application");
          continue;
        }
        if (!fixedSourceForJob(item.job, sources)) {
          await settleCandidate(db, lease, item.claim,
            { status: "held", failureCategory: "source_identity_review" });
          await account("select", item.job.id, "identity_review");
          continue;
        }
        // Ashby and Amazon have no independent single-posting detail in the
        // fixed path. A retained listing absent from this run cannot attest
        // that its source is still current; keep it due rather than screen it.
        if (!item.observedThisRun && ["ashby", "amazon"].includes(item.job.id.split(":")[0])) {
          await settleCandidate(db, lease, item.claim, { status: "retry_wait",
            failureCategory: "board_refresh_required", nextAttemptAt: Date.now() + 6 * 3600_000 });
          await account("select", item.job.id, "cooldown");
          continue;
        }
        toFilter.push(item.job);
        await account("select", item.job.id, "selected");
      }
    }

    let matches = 0;
    let needsReview = 0;
    let checked = 0;
    const currentJobs = new Map<string, NormalizedJob>();
    const filterErrors: string[] = [];
    const screeningHolds: NormalizedJob[] = [];
    const hasFetchReceipt = async (jobId: string, outcome: "fetched" | "not_found"): Promise<boolean> => {
      if (!accounting) return true;
      const row = await db.prepare(`SELECT outcome FROM discovery_run_items
        WHERE run_id=? AND item_id=? AND stage='fetch'`)
        .bind(lease.owner, jobId).first<{ outcome: string }>();
      return row?.outcome === outcome;
    };
    for (let i = 0; i < toFilter.length; i++) {
      const job = toFilter[i];
      const result = await runFilterStep(step, db, lease, job.id, async () => {
        let hydrated: NormalizedJob | null;
        try {
          hydrated = await hydrateFixedJob(job, durableQueue, sources);
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          const error = `${job.id}: ${(e as Error).message}`;
          await recordDiscoveryFailure(env, db, lease, job.id, evidenceMode ? "fetch" : "filter", error, env.instance.instanceId);
          await account("fetch", job.id, "fetch_failed", "provider_error");
          return { ok: false as const, error, failureStage: "fetch" as const };
        }
        if (!hydrated) {
          await account("fetch", job.id, "not_found");
          await clearFailures(db, lease, [job.id]);
          return { ok: true as const, screened: null };
        }
        // The receipt survives a lost Workflow checkpoint after model work.
        await account("fetch", job.id, "fetched");
        const applicationState = await readDiscoveryApplicationState(db, hydrated, sources);
        if (applicationState.kind !== "clear") return { ok: true as const, applicationState, heldJob: hydrated };
        try {
          const screened = await screenHydratedFixedJob(env, hydrated, sources, { timing: "workflow" });
          return { ok: true as const, screened };
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          const error = `${job.id}: ${(e as Error).message}`;
          await recordDiscoveryFailure(env, db, lease, job.id, "filter", error, env.instance.instanceId);
          return { ok: false as const, error, failureStage: "screen" as const,
            failureCode: e instanceof LocationEligibilityError ? "location_review" : "provider_error" };
        }
      }, evidenceMode ? error => recordDiscoveryFailure(env, db, lease, job.id, "filter", error, env.instance.instanceId) : undefined);
      // Reconstruct counts outside callbacks: completed steps replay cached
      // results, while each new save must commit before the next assessment.
      if (result.ok && result.applicationState && result.heldJob) {
        screeningHolds.push(result.heldJob);
        await account("screen", job.id, "pre_screen_held", result.applicationState.reason);
        if (result.applicationState.kind === "review") filterErrors.push(`${job.id}: application identity requires review`);
        continue;
      }
      if (result.ok) {
        // A detail 404 means it closed between discovery and screening.
        // No fabricated verdict or persistent rejection is written.
        if (!result.screened) {
          if (!await hasFetchReceipt(job.id, "not_found")) {
            filterErrors.push(`${job.id}: detail checkpoint lacks a fetch receipt`);
            screeningHolds.push(job);
            continue;
          }
          if (durableQueue) await settleCandidate(db, lease,
            { candidateKey: job.id, claimRunId: lease.owner, fence: lease.fence },
            { status: "held", failureCategory: "verified_not_found" });
          continue;
        }
        if (!await hasFetchReceipt(job.id, "fetched")) {
          filterErrors.push(`${job.id}: filter checkpoint lacks a fetch receipt`);
          screeningHolds.push(job);
          continue;
        }
        const { job: screenedJob, verdict, screening } = result.screened;
        currentJobs.set(screenedJob.id, screenedJob);
        const row: JobInsert = {
          job: screenedJob,
          firstSeenAt: now,
          criteriaVersion: env.runtime.criteriaVersion,
          isKnownApplication: false,
          knownApplicationSource: null,
          verdict: verdict ?? null,
          applicationStatus: "not_applied",
          applicationStatusSource: "pipeline",
          // Stamped by markNotified once Slack accepts the message, so a run
          // that dies mid-notify leaves its matches queued for the next one.
          deferNotifiedAt: true,
        };
        // Keep storage retries separate from inference and its error handler.
        const applicationState = await step.do(`save-assessment:${job.id}`, async () => {
          const current = await readDiscoveryApplicationState(db, row.job, sources);
          if (current.kind !== "clear") return current;
          const intentId = screening
            ? await saveDiscoveryScreening(db, row, screening, lease, env.instance.instanceId)
            : (await insertJobs(db, [row], lease), job.id);
          if (accounting && (screening ? ["match", "needs_review"].includes(screening.decision.state) : verdict!.match)) {
            await recordCreatedDeliveryIntent(db, lease, intentId, now);
          }
          return null;
        });
        if (applicationState) {
          screeningHolds.push(screenedJob);
          if (applicationState.kind === "review") filterErrors.push(`${job.id}: application identity requires review`);
        }
        // An evidence retry writes only a cooldown receipt. Leave its claim
        // for settleOutstandingCandidates to bind to that receipt's deadline.
        if (!applicationState && durableQueue && screening?.decision.state !== "retry") {
          await clearFailures(db, lease, [job.id]);
          await settleCandidate(db, lease,
            { candidateKey: job.id, claimRunId: lease.owner, fence: lease.fence },
            { status: "complete" });
        }
        if (screening?.decision.state === "retry") {
          filterErrors.push(`${job.id}: ${screening.decision.reason}`);
          screeningHolds.push(job);
        }
        else {
          checked++;
          if (screening ? screening.decision.state === "match" : verdict!.match) matches++;
          if (screening?.decision.state === "needs_review") needsReview++;
        }
        await account("screen", job.id, screening
          ? screening.decision.state === "needs_review" ? "review" :
            screening.decision.state === "retry" ? "retry" : screening.decision.state
          : verdict!.match ? "match" : "no_match");
      } else {
        // No rejection row: retry eligibility is held separately, so this
        // posting can be reconsidered after its cooldown.
        filterErrors.push(result.error);
        screeningHolds.push(job);
        const fetchFailure = "failureStage" in result && result.failureStage === "fetch";
        if (!fetchFailure && await hasFetchReceipt(job.id, "fetched"))
          await account("screen", job.id, "retry", "failureCode" in result ? result.failureCode : "provider_error");
      }

      // Stay well under Workers AI's 20 req/min cap on paid-only models.
      if (i < toFilter.length - 1) {
        await step.sleep(`pace:${job.id}`, "4 seconds");
      }
    }

    // Driven by what D1 says is undelivered rather than by this run's
    // matches, so an earlier run's undelivered backlog goes out too.
    const applicationPlan = await loadApplicationAwareNotifications(step, db, "fixed_board", MAX_NOTIFICATIONS_PER_RUN, evidenceMode, sources, env.instance.instanceId, env.runtime);
    const candidates = applicationPlan.candidates;
    const locationPlan = await prepareLocationNotifications(step, db, lease, applicationPlan.ready, sources, env.runtime.candidate.policy, currentJobs);
    const pending = locationPlan.ready;
    for (const item of [...applicationPlan.held, ...locationPlan.applicationHeld])
      await account("deliver", item.evaluationId ?? item.job.id, "suppressed");
    for (const hold of locationPlan.held) await account("deliver", hold.intentId, "location_held");
    const filteringFailures = filterErrors.length;
    for (const hold of locationPlan.held) filterErrors.push(`${hold.jobId}: ${hold.reason}`);

    // Freeze the complete message plan before settlement clears queue claims.
    // Read this checkpoint even if a replay has no current screening holds.
    const headerStream = await step.do("plan-notify-header", async () => {
      const holdPlan = await reconcileDiscoveryHolds(db, lease, screeningHolds, sources, candidates.map(item => item.job));
      const blockedIds = new Set([...holdPlan.suppressedJobIds, ...holdPlan.identityReview.map(hold => hold.job.id)]);
      const eligiblePending = pending.filter(item => !blockedIds.has(item.job.id));
      const locationHolds = locationPlan.held.filter(hold => !blockedIds.has(hold.jobId));
      if (!(eligiblePending.length > 0 || errors.length > 0 || locationHolds.length > 0 || holdPlan.screening.length > 0 || holdPlan.identityReview.length > 0)) return jsonToStream([]);
      const header = boardDigestMessage({
        delivering: eligiblePending.length,
        matchedThisRun: matches,
        ...(evidenceMode ? { deliveringReviews: eligiblePending.filter(item => item.decision?.state === "needs_review").length, needsReviewThisRun: needsReview } : {}),
        checked,
        alreadyApplied: plan.alreadyApplied,
        fetchErrors: errors,
        filterFailures: actionableHoldErrors(filterErrors.slice(0, filteringFailures), holdPlan).length,
        totalBoards: sources.length,
        cap: MAX_NOTIFICATIONS_PER_RUN,
      }) + (holdPlan.screening.length ? `\n${screeningHoldMessage(holdPlan.screening)}` : "") +
        (holdPlan.identityReview.length ? `\n${applicationIdentityHoldMessage(holdPlan.identityReview)}` : "") +
        (locationHolds.length ? `\n${locationHoldMessage(locationHolds)}` : "");
      return jsonToStream(splitSlackText(header));
    });
    const chunks = await streamToJson<string[]>(headerStream);
    if (durableQueue) await settleOutstandingCandidates(db, lease);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await step.sleep(`notify-header-pace:${i}`, "1 second");
      // Each continuation checkpoints separately so a resume skips sent chunks.
      await step.do(i === 0 ? "notify-header" : `notify-header-continued:${i}`,
        async () => postText(env, chunks[i]));
    }

    let delivered = 0;
    for (let i = 0; i < pending.length; i++) {
      const { job, verdict, decision, evaluationId } = pending[i];
      const notificationId = evaluationId ?? job.id;
      const sent = await step.do(`notify:${notificationId}`, async () => {
        const stillPending = isCurrentCriteria(pending[i].criteriaVersion, env.runtime) && (evidenceMode
          ? await isScreeningNotificationPending(db, job.id, evaluationId, lease.pipeline, env.instance.instanceId, env.runtime.criteriaVersion)
          : await isLegacyNotificationPending(db, job.id, lease.pipeline, env.instance.instanceId, env.runtime.criteriaVersion));
        if (!stillPending || !isLocationNotificationReady(pending[i], env.runtime.candidate.policy)) return false;
        if ((await readDiscoveryApplicationState(db, job, sources)).kind !== "clear") return false;
        if (accounting) await recordDeliveryAttempt(db, lease, notificationId, new Date().toISOString());
        await postMatch(env, job, verdict, undefined, decision);
        // Receipt storage remains in the delivery step so a failed write is
        // retried. This retains the existing at-least-once Slack boundary.
        if (evidenceMode) await markScreeningNotified(db, job.id, evaluationId, new Date().toISOString(), lease);
        else await markNotified(db, [job.id], new Date().toISOString(), lease);
        await clearFailures(db, lease, [job.id]);
        return true;
      });
      if (sent !== false) delivered++; // Older legacy checkpoints returned undefined.
      await account("deliver", notificationId, sent === false ? "suppressed" : "delivered");
      if (i < pending.length - 1) await step.sleep(`notify-pace:${notificationId}`, "1 second");
    }

    await step.do("record-run", async () =>
      recordRun(db, {
        sourcesOk: sources.length - errors.length,
        sourcesFailed: errors.length,
        // Count only successfully saved assessments, not failed attempts.
        newPostings: checked,
        alreadyAppliedSkipped: plan.alreadyApplied,
        matches,
        errors: [...errors, ...filterErrors],
      }, lease),
    );
    if (accounting) await step.do("accounting-finish", async () =>
      finishDiscoveryRun(db, lease, lease.owner,
        errors.length || filterErrors.length || locationPlan.held.length ? "partial" : "complete",
        new Date().toISOString()));

    return {
      baseline: false,
      cooldownDeferred: plan.cooldownDeferred,
      newJobsChecked: checked,
      alreadyApplied: plan.alreadyApplied,
      matches,
      delivered,
      locationHeld: locationPlan.held.length,
      ...(evidenceMode ? { needsReview } : {}),
      errors: [...errors, ...filterErrors],
    };
  }
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const configured = await configureEnv(env);
    env = configured;
    if (configured.instance.shadowMode) return new Response("Setup preview: operational entry disabled", { status: 503 });
    if (request.method === "GET" && new URL(request.url).pathname === "/discovery/report" &&
      env.DISCOVERY_ACCOUNTING_MODE === "on") {
      if (!authorizedTrigger(request, env.TRIGGER_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const url = new URL(request.url);
      const runId = url.searchParams.get("runId") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? "0");
      try { return Response.json(await readDiscoveryReport(env.DB, runId, offset),
        { headers: { "Cache-Control": "no-store" } }); }
      catch { return new Response("Invalid or unavailable discovery report", { status: 400 }); }
    }
    if (request.method !== "POST") {
      return new Response("POST here to trigger a run on demand.", { status: 405 });
    }
    if (!authorizedTrigger(request, env.TRIGGER_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    return Response.json(await triggerDiscovery(env.DB, env.AGENT_WORKFLOW, "fixed_boards"));
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const configured = await configureEnv(env);
    env = configured;
    if (configured.instance.shadowMode) return;
    const slot = dueWorkflows(new Date(event.scheduledTime), configured.instance.schedule).find(s => s.workflow === "fixed");
    if (!slot) return;
    if (env.DISCOVERY_ACCOUNTING_MODE === "on") {
      try { await reconcileIncompleteRuns(env.DB, "fixed_boards", env.AGENT_WORKFLOW); }
      catch (error) { console.error("Discovery health reconciliation failed", error); }
    }
    await startScheduledWorkflow(env.AGENT_WORKFLOW, `${configured.instance.instanceId}-${slot.slotKey}`);
  },
};
