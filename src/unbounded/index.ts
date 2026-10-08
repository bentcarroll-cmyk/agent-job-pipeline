import { authorizedTrigger } from "../operations/auth";
import { admitRunConfig, isActiveCriteria, isCurrentCriteria } from "../config/run-context";
import { buildQueryBanks } from "../discovery/queries";
import { configureEnv, type ConfigBindings } from "../config/env";
import { configuredSources, configuredRegistry } from "../config/sources";
import type { RuntimeConfig, InstanceConfig } from "../config/types";
import { withDiscoveryLease, triggerDiscovery, type DiscoverySteps } from "../operations/discovery-run";
import { LeaseLostError, type DiscoveryLease } from "../operations/leases";
import { getCoolingDownIds, clearFailures } from "../operations/retries";
import { runFilterStep } from "../operations/filter-step";
import { discoveryCodeVersion, discoveryConfigVersions } from "../discovery/version";
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { AshbyBoardNotFoundError, fetchPosting, fetchCompanyBoard, type NormalizedJob } from "../sources";
import { fetchJobForRef } from "../fetch-job";
import { screeningHoldMessage, applicationIdentityHoldMessage } from "../screening-holds";
import { readDiscoveryApplicationState, reconcileDiscoveryHolds, actionableHoldErrors } from "../discovery/application-state";
import { loadApplicationAwareNotifications } from "../discovery/application-notifications";
import { splitSlackText } from "../slack-text";
import { LocationEligibilityError } from "../location";
import { filterJob, type FilterEnv } from "../filter";
import type { Verdict } from "../criteria";
import { jsonToStream, streamToJson } from "../step-stream";
import { evaluateJob, screeningRetryDecision } from "../screening/evaluate";
import type { ScreeningEvaluation } from "../screening/types";
import { saveDiscoveryScreening, recordDiscoveryFailure } from "../screening/workflow";
import { createEvaluation, saveManualScreeningResult, isScreeningNotificationPending, markScreeningNotified } from "../screening/store";
import {
  appliedApplicationForUrl,
  getExistingJobIds,
  touchLastSeen,
  lookupKnownAtsApplication,
  lookupKnownEmployerApplication,
  insertJobs,
  recordRun,
  setApplicationStatus,
  isLegacyNotificationPending,
  markNotified,
  getRotationCursor,
  advanceRotationCursor,
  type JobInsert,
  type KnownApplication,
} from "../db";
import {
  ACTION_STATUS,
  alreadyAppliedText,
  parseSlashCommand,
  respondEphemeral,
  type Mark,
  type SlashCommand,
  applyMark,
  parseInteraction,
  postMatch,
  postText,
  updateMessage,
  verifySlackRequest,
  type Interaction,
  type SlackEnv,
} from "../slack";
import {
  buildExclusionSet,
  pickRotationWindow,
  findPostingsForPhrases,
  parseJobUrl,
  jobRefId,
  titleCaseSlug,
  type JobRef,
} from "./discovery";
import { parseLifecycleAction } from "../lifecycle/slack-actions";
import { answerQuestion, undoChange } from "../lifecycle/record";
import { startScheduledWorkflow } from "../lifecycle/cron";
import { dueWorkflows } from "../config/schedule";
import { publicPage } from "../lifecycle/public-pages";
import type { GmailEnv } from "../lifecycle/gmail-client";
import { prepareLocationNotifications, isLocationNotificationReady, locationHoldMessage } from "../location-notifications";
import { startDiscoveryRun, recordStageOutcome, recordCreatedDeliveryIntent, recordDeliveryAttempt, finishDiscoveryRun, type Stage } from "../discovery/coverage";
import { observeSearchPage } from "../discovery/observe";
import { reconcileIncompleteRuns } from "../operations/run-health";
import { readDiscoveryReport } from "../operations/discovery-report";
import { runExpandedSearch } from "../discovery/expanded-run";
import { persistSearchPageHits } from "../discovery/queue-integration";
import { getClaimedCandidates, loadCandidateResolution, persistCandidate, readCandidateInventory, selectCandidateBatch,
  settleCandidate, settleOutstandingCandidates } from "../discovery/candidates";
import { resolvePostingUrl } from "../discovery/resolve";
import { recordProvenAlias } from "../discovery/aliases";
import { fetchResolvedPosting } from "../discovery/fetch";
import { createSafePageFetcher } from "../discovery/safe-fetch";

import { handleIntakeCommand } from "../intake/command";
import { dispatchIntake, reconcileIntakes, workflowControl } from "../intake/dispatch";
import { recordVerifiedManualReceipt } from "../intake/delivery-store";
import { repostDigest, RepostRefused, startRadarRun, assertRadarProfileAvailable } from "../radar/workflow";
import { handleRadarAction, parseRadarAction } from "../radar/slack-actions";

// Wrangler binds Workflow classes by name from the entry module.
export { LifecycleWorkflow } from "../lifecycle/workflow";
export { ManualIntakeWorkflow } from "../intake/workflow";
export { RadarWorkflow } from "../radar/workflow";

interface Env extends ConfigBindings, FilterEnv, SlackEnv, GmailEnv {
  AGENT_WORKFLOW: Workflow;
  LIFECYCLE_WORKFLOW: Workflow;
  LIFECYCLE_MODE: string;
  DB: D1Database;
  TRIGGER_SECRET: string;
  SERPER_API_KEY: string;
  SHADOW_MODE: string;
  MANUAL_SCREENING_MODE?: "legacy" | "evidence";
  DISCOVERY_ACCOUNTING_MODE?: "off" | "on";
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  DISCOVERY_QUERY_MODE?: "baseline" | "expanded";
  DISCOVERY_QUEUE_MODE?: "off" | "on";
  DISCOVERY_EMPLOYER_MODE?: "off" | "on";
  MANUAL_INTAKE_MODE?: "legacy" | "durable";
  MANUAL_INTAKE_WORKFLOW?: Workflow;
  RADAR_WORKFLOW: Workflow;
  RADAR_MODE: string;
  RADAR_CHANNEL_ID: string;
  RADAR_MONTHLY_BUDGET_USD: string;
  TWITTERAPI_IO_KEY: string;
  ANTHROPIC_API_KEY: string;
}

// The whole bank every run, 5 pages deep: coverage is the point, and the
// per-run cost of widening it is small. At PHRASES_PER_RUN === the bank
// length the rotation cursor is a no-op (the window is the whole bank and
// nextIndex lands back where it started) — it stays wired up so lowering
// this number starts rotating again without a code change.
const PHRASES_PER_RUN = 30;
// Empty pages cost nothing: the page loop breaks as soon as a page comes
// back with no results, so going deeper only bills for pages that exist.
const MAX_PAGES_PER_PHRASE = 5;
// Hard ceiling on how much new work one run takes on. Sized against the
// configured Workflow step budget. Fetch, filter, save and pacing each
// consume steps; source coverage and provider budgets also bound work.
const MAX_NEW_POSTINGS_PER_RUN = 500;
// Blast-radius guard, not a pacing knob. Set well above any plausible real
// run so it never defers a match you should be seeing: a cap that silently
// holds matches back is the same failure as notified_at lying about
// delivery, only politer. It exists so a criteria change that accidentally
// matches everything costs one noisy channel rather than hundreds of
// messages. Runs routinely approaching this mean the criteria are wrong —
// tighten the fit rather than raise the ceiling. The header says when a run
// hits it, and the remainder goes out on the next run.
const MAX_NOTIFICATIONS_PER_RUN = 50;

export class UnboundedAgentWorkflow extends WorkflowEntrypoint<Env, {}> {
  async run(event: WorkflowEvent<{}>, rawStep: WorkflowStep) {
    const env = await configureEnv(this.env);
    if (env.instance.shadowMode) return { skipped: "preview" };
    env.runtime = await admitRunConfig(env.DB, event.instanceId, env.runtime);
    return withDiscoveryLease(env.DB, "unbounded_discovery", event.instanceId, rawStep,
      (step, lease) => this.runOwned(step, lease, env));
  }

  private async runOwned(step: DiscoverySteps, lease: DiscoveryLease, env: Env & { runtime: RuntimeConfig; instance: InstanceConfig }) {
    const db = env.DB;
    const sources = configuredSources(env.runtime);
    const unresolved = [...env.runtime.candidate.search.unresolvedEmployers];
    const now = new Date().toISOString();
    const evidenceMode = env.SCREENING_MODE === "evidence";
    // Fails closed: only the literal string "false" enables Slack.
    const notifyEnabled = env.SHADOW_MODE === "false";
    const exclusion = buildExclusionSet(sources, unresolved);
    const banks = buildQueryBanks(env.runtime);
    const phrasesBank = banks.baseline.map(query => query.terms[0]);
    const errors: string[] = [];
    const accounting = env.DISCOVERY_ACCOUNTING_MODE === "on";
    const expandedQueries = env.DISCOVERY_QUERY_MODE === "expanded";
    const durableQueue = env.DISCOVERY_QUEUE_MODE === "on";
    const employerMode = env.DISCOVERY_EMPLOYER_MODE === "on";
    if (durableQueue && (!expandedQueries || !accounting)) {
      throw new Error("Durable queue requires expanded search and accounting");
    }
    if (expandedQueries && (!accounting || !durableQueue)) {
      throw new Error("Expanded search requires accounting and durable candidate queue");
    }
    if (employerMode && (!expandedQueries || !durableQueue || !accounting)) {
      throw new Error("Employer detail mode requires expanded search, accounting and durable queue");
    }
    const registry = employerMode ? configuredRegistry(env.runtime) : [];
    const fetchPage = employerMode
      ? createSafePageFetcher({ allowedHosts: registry.flatMap(source =>
        [...source.careerHosts, ...source.atsHosts]) })
      : async () => { throw new Error("Employer detail mode is disabled"); };
    const resolverDeps = { registry, fetchPage, now: () => new Date().toISOString() };
    const account = async (stage: Stage, itemId: string, outcome: string,
      errorCode: string | null = null, detail: string | null = null): Promise<void> => {
      if (!accounting) return;
      await recordStageOutcome(db, lease, { runId: lease.owner, stage, itemId, outcome,
        at: new Date().toISOString(), errorCode, detail });
    };
    if (accounting) await step.do("accounting-start", async () => {
      await startDiscoveryRun(db, lease, { runId: lease.owner, pipeline: lease.pipeline,
        codeVersion: discoveryCodeVersion(env.CF_VERSION_METADATA), ...discoveryConfigVersions(env.runtime), startedAt: now });
    });

    const searchResult = expandedQueries ? await (async () => {
      const expanded = await runExpandedSearch({ db, lease, runtime: env.runtime, apiKey: env.SERPER_API_KEY,
        exclusion, checkpoint: (name, callback) => step.do(name, callback),
        onPageHits: durableQueue ? async ({ queryId, page, hits }) => {
          await persistSearchPageHits(db, lease, { queryId, page, hits: hits.results,
            discoveredAt: now, exclusion });
        } : undefined });
      return { refs: expanded.refs, phraseErrors: expanded.report.pageFailures.map(item =>
        `${item.queryId}/${item.page}: ${item.errorCode}`), fatalError: null as string | null };
    })() : await step.do("search", async () => {
      try {
        const startIndex = await getRotationCursor(db, lease);
        const { phrases, nextIndex } = pickRotationWindow(phrasesBank, startIndex, Math.min(PHRASES_PER_RUN, phrasesBank.length));
        const { refs, errors: phraseErrors } = await findPostingsForPhrases(
          env.SERPER_API_KEY,
          phrases,
          exclusion,
          MAX_PAGES_PER_PHRASE,
          accounting ? async event => {
            try { await observeSearchPage(db, lease, event, exclusion, MAX_PAGES_PER_PHRASE, phrasesBank); }
            catch (error) {
              if (error instanceof LeaseLostError) throw error;
              console.error("Discovery page accounting unavailable", { query: event.phrase, page: event.page,
                status: event.status, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
              throw error;
            }
          } : undefined,
        );
        // Cursor advances regardless of per-phrase failures: a phrase that
        // errored this run has already spent its Serper credits, and not
        // advancing would just re-spend them re-querying the same window
        // next run instead of trying the next one.
        await advanceRotationCursor(db, nextIndex, lease);
        return { refs, phraseErrors, fatalError: null as string | null };
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        if (accounting) throw e;
        // A fatal failure (e.g. D1 unreachable) must not abort the run —
        // this run should still record a pipeline_runs row saying what
        // happened.
        return { refs: [] as JobRef[], phraseErrors: [] as string[], fatalError: (e as Error).message };
      }
    });
    if (searchResult.fatalError) errors.push(`search: ${searchResult.fatalError}`);
    for (const e of searchResult.phraseErrors) errors.push(`search: ${e}`);
    const searchRefs = searchResult.refs;
    let refs = searchRefs;
    const employerCandidateKeys: string[] = [];
    let heldCandidates = 0;
    if (durableQueue) {
      await step.do("claim-candidates", async () => selectCandidateBatch(db, lease,
        { now: Date.now(), totalLimit: MAX_NEW_POSTINGS_PER_RUN, dueRetryLimit: 50, sources }));
      const claimed = await getClaimedCandidates(db, lease);
      const queuedRefs: JobRef[] = [];
      for (const candidate of claimed) {
        let resolution = candidate.resolution;
        if (!resolution || (resolution.kind === "held" && resolution.retryable)) {
          resolution = await step.do(`resolve-candidate:${candidate.candidateKey}`, async () =>
            resolvePostingUrl({ url: candidate.originalUrl }, resolverDeps));
          if (resolution.kind === "resolved") {
            const resolved = resolution;
            await step.do(`promote-candidate:${candidate.candidateKey}`, async () => {
              await account("resolve", candidate.candidateKey, "resolved", null, resolved.posting.jobId);
              await persistCandidate(db, lease, { candidateKey: resolved.posting.jobId,
                originalUrl: candidate.originalUrl, canonicalJobId: resolved.posting.jobId,
                discoveredAt: candidate.discoveredAt, sourceId: candidate.sourceId,
                resolution: resolved });
            });
            continue; // The proven owner enters the next bounded claim batch.
          }
          const held = resolution;
          await step.do(`hold-candidate:${candidate.candidateKey}`, async () => {
            await account("resolve", candidate.candidateKey,
              held.reason === "unsupported" ? "unsupported" : held.reason === "invalid_identity" ? "invalid_identity" : "held",
              held.reason);
            await settleCandidate(db, lease, candidate, { status: held.retryable ? "retry_wait" : "held",
              failureCategory: held.reason, nextAttemptAt: held.retryable ? Date.now() + 6 * 3600_000 : undefined });
          });
          heldCandidates++;
          continue;
        }
        if (resolution.kind === "held") throw new Error("A nonretryable candidate was claimed unexpectedly");
        if (resolution.posting.kind === "employer") {
          if (!employerMode) throw new Error("Employer candidate reached a disabled source adapter");
          employerCandidateKeys.push(candidate.candidateKey);
          continue;
        }
        queuedRefs.push(resolution.posting.ref);
      }
      refs = queuedRefs;
    }

    const ids = [...refs.map(jobRefId), ...employerCandidateKeys];
    const existingIds = await step.do("check-existing", async () => [...(await getExistingJobIds(db, ids))]);
    const existingSet = new Set(existingIds);

    await step.do("touch-last-seen", async () =>
      touchLastSeen(db, ids.filter((id) => existingSet.has(id)), now, lease),
    );

    // Dedupe against the jobs ledger IS the baseline: anything already seen
    // and judged costs nothing beyond this lookup.
    const selection = await step.do("select-eligible-postings", async () => {
      const fresh = refs.filter(r => !existingSet.has(jobRefId(r)));
      const freshEmployer = employerCandidateKeys.filter(id => !existingSet.has(id));
      const cooling = await getCoolingDownIds(db, lease.pipeline,
        [...fresh.map(jobRefId), ...freshEmployer]);
      const eligible = fresh.filter(r => !cooling.has(jobRefId(r)));
      const eligibleEmployer = freshEmployer.filter(id => !cooling.has(id));
      for (const ref of refs) if (existingSet.has(jobRefId(ref))) await account("select", jobRefId(ref), "existing");
      for (const id of employerCandidateKeys) if (existingSet.has(id)) await account("select", id, "existing");
      for (const ref of fresh) if (cooling.has(jobRefId(ref))) await account("select", jobRefId(ref), "cooldown");
      for (const id of freshEmployer) if (cooling.has(id)) await account("select", id, "cooldown");
      for (const ref of eligible.slice(MAX_NEW_POSTINGS_PER_RUN)) await account("select", jobRefId(ref), "cap_deferred");
      return { refs: eligible.slice(0, MAX_NEW_POSTINGS_PER_RUN),
        employerKeys: eligibleEmployer.slice(0, MAX_NEW_POSTINGS_PER_RUN - Math.min(eligible.length, MAX_NEW_POSTINGS_PER_RUN)),
        cooldownDeferred: cooling.size,
        capDeferred: Math.max(0, eligible.length - MAX_NEW_POSTINGS_PER_RUN) };
    });
    const newRefs = selection.refs;

    // Known applications are resolved inside a single step.do so the
    // known/toFetch partition — which determines every fetch:* step name
    // below — comes from memoized output. Resolving it in a bare loop
    // outside step.do would let a `known_applications` row written mid-run
    // by the separate lifecycle tracker change the partition on replay,
    // computing different step names and orphaning a completed step.
    const knownResolutions = await step.do("resolve-known-applications", async () => {
      const resolutions: Array<{ ref: JobRef; known: KnownApplication | null; ambiguous: boolean }> = [];
      for (const ref of newRefs) {
        const lookup = await lookupKnownAtsApplication(db, { jobId: jobRefId(ref),
          postingId: ref.postingId, employerName: titleCaseSlug(ref.slug), postingUrl: ref.url });
        const ambiguous = lookup.kind === "ambiguous";
        const known = lookup.kind === "matched" ? lookup.application : null;
        await account("select", jobRefId(ref), ambiguous ? "identity_review" :
          known ? "known_application" : "selected");
        if (ambiguous && durableQueue) await settleCandidate(db, lease,
          { candidateKey: jobRefId(ref), claimRunId: lease.owner, fence: lease.fence },
          { status: "held", failureCategory: "ambiguous_application_identity" });
        resolutions.push({ ref, known, ambiguous });
      }
      return resolutions;
    });

    // Known applications never cost a fetch or a GLM call — a posting
    // already applied to just gets its row.
    const knownRows: JobInsert[] = [];
    const toFetch: JobRef[] = [];
    for (const { ref, known, ambiguous } of knownResolutions) {
      if (ambiguous) {
        errors.push(`${jobRefId(ref)}: ambiguous known application identity requires review`);
        heldCandidates++;
        continue;
      }
      if (known) {
        knownRows.push({
          job: {
            id: jobRefId(ref),
            company: titleCaseSlug(ref.slug),
            title: ref.title,
            url: ref.url,
            location: "unspecified",
            department: "unspecified",
            isRemote: null,
            employmentType: null,
            postedAt: null,
            compensation: null,
            // Built from the search result alone: a known application is
            // never fetched, so there is no body to pass on.
            description: null,
          },
          firstSeenAt: now,
          criteriaVersion: env.runtime.criteriaVersion,
          isKnownApplication: true,
          knownApplicationSource: known.source_job_id,
          verdict: null,
          applicationStatus: known.status ?? "applied",
          applicationStatusSource: "import",
          discoverySource: "unbounded_search",
          deferNotifiedAt: true,
        });
      } else {
        toFetch.push(ref);
      }
    }

    const employerKnown = await step.do("resolve-known-employer-applications", async () => {
      const rows: Array<{candidateKey:string;known:KnownApplication|null;ambiguous:boolean}> = [];
      for (const candidateKey of selection.employerKeys) {
        const resolution = await loadCandidateResolution(db, lease.pipeline, candidateKey);
        if (resolution?.kind !== "resolved" || resolution.posting.kind !== "employer" ||
          resolution.posting.jobId !== candidateKey) throw new Error("Employer candidate identity changed");
        const posting = resolution.posting;
        const source = registry.find(item => item.key === posting.employerKey);
        if (!source) throw new Error("Employer source registry changed");
        const lookup = await lookupKnownEmployerApplication(db, {
          ownerJobId: candidateKey, employerKey: source.key, employerName: source.name,
          requisitionId: posting.requisitionId, aliases: resolution.aliases,
        });
        const ambiguous = lookup.kind === "ambiguous";
        const known = lookup.kind === "matched" ? lookup.application : null;
        await account("select", candidateKey, ambiguous ? "identity_review" :
          known ? "known_application" : "selected");
        if (ambiguous) await settleCandidate(db, lease,
          { candidateKey, claimRunId: lease.owner, fence: lease.fence },
          { status: "held", failureCategory: "ambiguous_application_identity" });
        rows.push({ candidateKey, known, ambiguous });
      }
      return rows;
    });
    const toFetchEmployer: string[] = [];
    for (const { candidateKey, known, ambiguous } of employerKnown) {
      if (ambiguous) { heldCandidates++; continue; }
      const resolution = await loadCandidateResolution(db, lease.pipeline, candidateKey);
      if (resolution?.kind !== "resolved" || resolution.posting.kind !== "employer" ||
        resolution.posting.jobId !== candidateKey) throw new Error("Employer candidate context is missing");
      if (known) knownRows.push({ job: resolution.posting.job, firstSeenAt: now,
        criteriaVersion: env.runtime.criteriaVersion,
        isKnownApplication: true, knownApplicationSource: known.source_job_id,
        verdict: null, applicationStatus: known.status ?? "applied",
        applicationStatusSource: "import", discoverySource: "unbounded_search", deferNotifiedAt: true });
      else toFetchEmployer.push(candidateKey);
    }

    const fetched: NormalizedJob[] = [];
    for (const candidateKey of toFetchEmployer) {
      const resolution = await loadCandidateResolution(db, lease.pipeline, candidateKey);
      if (resolution?.kind !== "resolved" || resolution.posting.kind !== "employer" ||
        resolution.posting.jobId !== candidateKey) throw new Error("Employer fetch context is missing");
      const posting = resolution.posting;
      const result = await step.do(`fetch-employer:${candidateKey}`, async () =>
        fetchResolvedPosting(posting, resolverDeps));
      if (result.kind === "fetched") {
        fetched.push(result.job);
        await account("fetch", candidateKey, "fetched");
      } else if (result.kind === "not_found") {
        await step.do(`hold-employer:${candidateKey}`, async () =>
          settleCandidate(db, lease, { candidateKey, claimRunId: lease.owner, fence: lease.fence },
            { status: "held", failureCategory: result.reason }));
        await account("fetch", candidateKey, "not_found");
        heldCandidates++;
      } else {
        if (result.retryable) await step.do(`retry-employer:${candidateKey}`, async () =>
          recordDiscoveryFailure(env, db, lease, candidateKey, "fetch", result.detail, env.instance.instanceId));
        else await step.do(`hold-employer:${candidateKey}`, async () =>
          settleCandidate(db, lease, { candidateKey, claimRunId: lease.owner, fence: lease.fence },
            { status: "held", failureCategory: result.reason }));
        await account("fetch", candidateKey, "fetch_failed", result.reason);
        heldCandidates++;
      }
    }
    // A 404 (Greenhouse/Lever) or a posting absent from its fetched board
    // (Ashby) is definitive — the posting doesn't exist there, not "the ATS
    // hiccuped". Tombstoning it (a jobs row with verdict: null, same as a
    // baseline row) dedupes that id permanently instead of letting a
    // Google-indexed-but-dead posting re-consume a MAX_NEW_POSTINGS_PER_RUN
    // slot on every run that resurfaces it. Transient errors receive a
    // separate retry cooldown and never become a permanent rejection.
    const tombstoneRows: JobInsert[] = [];

    for (const ref of toFetch) {
      if (ref.ats === "ashby") continue; // handled per-board below
      // Narrowed to "greenhouse" | "lever" | "workday" by the guard above.
      const fetchable = { ats: ref.ats, slug: ref.slug, postingId: ref.postingId, url: ref.url };
      const result = await step.do(`fetch:${jobRefId(ref)}`, async () => {
        try {
          const job = await fetchPosting(fetchable, titleCaseSlug(ref.slug));
          return job ? { status: "found" as const, job } : { status: "not-found" as const };
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          const error = `${ref.slug}/${ref.postingId}: ${(e as Error).message}`;
          await recordDiscoveryFailure(env, db, lease, jobRefId(ref), "fetch", error, env.instance.instanceId);
          return { status: "error" as const, error };
        }
      });
      // Accumulate outside the callback — step.do results are memoized and
      // the callback body does not re-run on replay.
      if (result.status === "found") fetched.push({ ...result.job, id: jobRefId(ref) });
      else if (result.status === "not-found") tombstoneRows.push(buildTombstoneRow(ref, now, env.runtime.criteriaVersion));
      else errors.push(result.error);
      await account("fetch", jobRefId(ref), result.status === "found" ? "fetched" :
        result.status === "not-found" ? "not_found" : "fetch_failed",
        result.status === "error" ? fetchErrorCode(result.error) : null);
    }

    // Ashby has no public per-posting endpoint, so its board is fetched once
    // per company per run and the postings are matched out of it.
    const ashbyGroups = new Map<string, JobRef[]>();
    for (const ref of toFetch) {
      if (ref.ats !== "ashby") continue;
      const group = ashbyGroups.get(ref.slug) ?? [];
      group.push(ref);
      ashbyGroups.set(ref.slug, group);
    }
    for (const [slug, groupRefs] of ashbyGroups) {
      const checkpoint = await step.do(`fetch-board:ashby:${slug}`, async () => {
        try {
          return jsonToStream({ ok: true, jobs: await fetchCompanyBoard("ashby", titleCaseSlug(slug), slug) });
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          const error = `${slug}: ${(e as Error).message}`;
          // One 404 could be transient. When any retry already records this
          // exact board 404 from an earlier run, the board is gone, even if
          // search surfaced different postings, and each member is as absent
          // as one that dropped off a fetched board.
          if (e instanceof AshbyBoardNotFoundError) {
            // Only a recent record counts, so an old 404 cannot close a revived board.
            const prior = await db.prepare(`SELECT COUNT(*) AS n FROM discovery_retries
              WHERE pipeline='unbounded_discovery' AND stage='fetch' AND last_error=? AND last_run_id<>?
              AND failed_at>=?`)
              .bind(error, lease.owner, Date.now() - 7 * 86_400_000).first<{ n: number }>();
            if ((prior?.n ?? 0) > 0) {
              console.log(JSON.stringify({ event: "ashby_board_missing", runId: lease.owner, slug, members: groupRefs.length }));
              return jsonToStream({ ok: true, jobs: [] });
            }
          }
          for (const ref of groupRefs) await recordDiscoveryFailure(env, db, lease, jobRefId(ref), "fetch", error, env.instance.instanceId);
          return { ok: false as const, error };
        }
      });
      // Boards can exceed the ordinary 1 MiB checkpoint limit. Decode the
      // streamed success while accepting older object checkpoints on replay.
      const result: { ok: true; jobs: NormalizedJob[] } | { ok: false; error: string } = checkpoint instanceof ReadableStream
        ? await streamToJson<{ ok: true; jobs: NormalizedJob[] }>(checkpoint) : checkpoint;
      if (!result.ok) {
        errors.push(result.error);
        for (const ref of groupRefs) await account("fetch", jobRefId(ref), "fetch_failed", fetchErrorCode(result.error));
        continue;
      }
      for (const ref of groupRefs) {
        // normalizeAshby builds ids as `ashby:{label}:{postingId}`, so the
        // posting we want is the one whose id ends with this posting id.
        const match = result.jobs.find((j) => j.id.toLowerCase().endsWith(`:${ref.postingId}`));
        if (match) fetched.push({ ...match, id: jobRefId(ref) });
        // Absent from the board fetched this run is just as definitive as a
        // Greenhouse/Lever 404 — tombstone it rather than retrying forever.
        else tombstoneRows.push(buildTombstoneRow(ref, now, env.runtime.criteriaVersion));
        await account("fetch", jobRefId(ref), match ? "fetched" : "not_found");
      }
    }

    let matches = 0;
    let needsReview = 0;
    let checked = 0;
    const screeningHolds: NormalizedJob[] = [];
    for (let i = 0; i < fetched.length; i++) {
      const job = fetched[i];
      const result = await runFilterStep(step, db, lease, job.id, async () => {
        const applicationState = await readDiscoveryApplicationState(db, job, sources);
        if (applicationState.kind !== "clear") return { ok: true as const, applicationState };
        try {
          return evidenceMode
            ? { ok: true as const, screening: await evaluateJob(env, job, undefined, { timing: "workflow" }) }
            : { ok: true as const, verdict: await filterJob(env, job, undefined, { timing: "workflow" }) };
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          const error = `${job.id}: ${(e as Error).message}`;
          await recordDiscoveryFailure(env, db, lease, job.id, "filter", error, env.instance.instanceId);
          return { ok: false as const, error,
            failureCode: e instanceof LocationEligibilityError ? "location_review" : fetchErrorCode(error) };
        }
      }, evidenceMode ? error => recordDiscoveryFailure(env, db, lease, job.id, "filter", error, env.instance.instanceId) : undefined);
      // Reconstruct counts outside callbacks: completed steps replay cached
      // results, while each new save must commit before the next assessment.
      if (result.ok && result.applicationState) {
        screeningHolds.push(job); // The header rechecks this state at its cutoff.
        await account("screen", job.id, "pre_screen_held", result.applicationState.reason);
        if (result.applicationState.kind === "review") errors.push(`${job.id}: application identity requires review`);
        continue;
      }
      if (result.ok) {
        const row: JobInsert = {
          job,
          firstSeenAt: now,
          criteriaVersion: env.runtime.criteriaVersion,
          isKnownApplication: false,
          knownApplicationSource: null,
          verdict: result.verdict ?? null,
          applicationStatus: "not_applied",
          applicationStatusSource: "pipeline",
          discoverySource: "unbounded_search",
          deferNotifiedAt: true,
        };
        // Keep storage retries separate from inference and its error handler.
        const applicationState = await step.do(`save-assessment:${job.id}`, async () => {
          const current = await readDiscoveryApplicationState(db, row.job, sources);
          if (current.kind !== "clear") return current;
          const intentId = result.screening
            ? await saveDiscoveryScreening(db, row, result.screening, lease, env.instance.instanceId)
            : (await insertJobs(db, [row], lease), job.id);
          if (accounting && (result.screening
            ? ["match", "needs_review"].includes(result.screening.decision.state) : result.verdict!.match)) {
            await recordCreatedDeliveryIntent(db, lease, intentId, now);
          }
          return null;
        });
        if (applicationState) {
          screeningHolds.push(job);
          if (applicationState.kind === "review") errors.push(`${job.id}: application identity requires review`);
        }
        if (!applicationState && durableQueue && employerMode && result.screening?.decision.state !== "retry")
          await step.do(`record-employer-aliases:${job.id}`, async () => {
          const proof = await loadCandidateResolution(db, lease.pipeline, job.id);
          if (proof?.kind !== "resolved" || proof.posting.kind !== "employer") return;
          if (proof.posting.jobId !== job.id || proof.posting.canonicalUrl !== job.url) {
            throw new Error("Saved employer job conflicts with resolver identity");
          }
          for (const alias of proof.aliases) {
            const result = await recordProvenAlias(db, { kind: "discovery", lease }, {
              alias, ownerJobId: job.id, employerKey: proof.posting.employerKey,
              requisitionId: proof.posting.requisitionId, sourceUrl: job.url,
              verifiedAt: now, resolution: proof,
            });
            if (result === "conflict") throw new Error("Conflicting employer alias ownership");
          }
          });
        if (result.screening?.decision.state === "retry") {
          errors.push(`${job.id}: ${result.screening.decision.reason}`);
          screeningHolds.push(job);
        }
        else {
          checked++;
          if (result.screening ? result.screening.decision.state === "match" : result.verdict!.match) matches++;
          if (result.screening?.decision.state === "needs_review") needsReview++;
        }
        await account("screen", job.id, result.screening
          ? result.screening.decision.state === "needs_review" ? "review" :
            result.screening.decision.state === "retry" ? "retry" : result.screening.decision.state
          : result.verdict!.match ? "match" : "no_match");
      } else {
        // Retry state lives separately from decisions; this posting remains
        // eligible for rediscovery after its cooldown.
        errors.push(result.error);
        screeningHolds.push(job);
        await account("screen", job.id, "retry", "failureCode" in result ? result.failureCode : fetchErrorCode(result.error));
      }

      // Stay under Workers AI's 20 req/min cap on paid-only models.
      if (i < fetched.length - 1) {
        await step.sleep(`pace:${job.id}`, "4 seconds");
      }
    }

    await step.do("write-new-jobs", async () => {
      // Assessed jobs are already durable; only unassessed rows remain.
      const rows = [...knownRows, ...tombstoneRows];
      await insertJobs(db, rows, lease);
    });
    if (durableQueue) await step.do("settle-candidates", async () =>
      settleOutstandingCandidates(db, lease));
    const candidateQueue = durableQueue ? await readCandidateInventory(db, lease.pipeline) : null;
    if (heldCandidates) errors.push(`${heldCandidates} employer URL(s) held for source review`);

    // Notifications are driven by what D1 says is undelivered, not by what
    // this run happened to match. That folds this run's new matches and any
    // earlier run's undelivered backlog into one queue, and means a crash
    // mid-notify costs nothing: notified_at is stamped only once Slack has
    // accepted the message, so the next run picks up exactly where this one
    // stopped.
    let delivered = 0;
    let locationHeld = 0;
    if (notifyEnabled) {
      const applicationPlan = await loadApplicationAwareNotifications(step, db, "unbounded_search", MAX_NOTIFICATIONS_PER_RUN, evidenceMode, sources, env.instance.instanceId, env.runtime);
      const candidates = applicationPlan.candidates;
      const locationPlan = await prepareLocationNotifications(step, db, lease, applicationPlan.ready, sources, env.runtime.candidate.policy, new Map(fetched.map(job => [job.id, job])));
      const pending = locationPlan.ready;
      locationHeld = locationPlan.held.length;
      for (const item of [...applicationPlan.held, ...locationPlan.applicationHeld])
        await account("deliver", item.evaluationId ?? item.job.id, "suppressed");
      for (const hold of locationPlan.held) await account("deliver", hold.intentId, "location_held");
      const discoveryErrors = [...errors];
      for (const hold of locationPlan.held) errors.push(`${hold.jobId}: ${hold.reason}`);

      // Reuse the complete plan rather than rebuilding an unsent continuation.
      const headerStream = await step.do("plan-notify-header", async () => {
        const holdPlan = await reconcileDiscoveryHolds(db, lease, screeningHolds, sources, candidates.map(item => item.job));
        const blockedIds = new Set([...holdPlan.suppressedJobIds, ...holdPlan.identityReview.map(hold => hold.job.id)]);
        const eligiblePending = pending.filter(item => !blockedIds.has(item.job.id));
        const locationHolds = locationPlan.held.filter(hold => !blockedIds.has(hold.jobId));
        if (!(eligiblePending.length > 0 || locationHolds.length > 0 || holdPlan.screening.length > 0 || holdPlan.identityReview.length > 0)) return jsonToStream([]);
        const header = headerMessage(eligiblePending.length, matches, checked, knownRows.length, actionableHoldErrors(discoveryErrors, holdPlan), evidenceMode ? eligiblePending.filter(item => item.decision?.state === "needs_review").length : undefined, needsReview) +
          (holdPlan.screening.length ? `\n${screeningHoldMessage(holdPlan.screening)}` : "") +
          (holdPlan.identityReview.length ? `\n${applicationIdentityHoldMessage(holdPlan.identityReview)}` : "") +
          (locationHolds.length ? `\n${locationHoldMessage(locationHolds)}` : "");
        return jsonToStream(splitSlackText(header));
      });
      const chunks = await streamToJson<string[]>(headerStream);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await step.sleep(`notify-header-pace:${i}`, "1 second");
        // Each continuation checkpoints separately so a resume skips sent chunks.
        await step.do(i === 0 ? "notify-header" : `notify-header-continued:${i}`,
          async () => postText(env, chunks[i]));
      }

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
          if (evidenceMode) await markScreeningNotified(db, job.id, evaluationId, new Date().toISOString(), lease);
          else await markNotified(db, [job.id], new Date().toISOString(), lease);
          await clearFailures(db, lease, [job.id]);
          return true;
        });
        if (sent !== false) delivered++; // Older legacy checkpoints returned undefined.
        await account("deliver", notificationId, sent === false ? "suppressed" : "delivered");
        if (i < pending.length - 1) await step.sleep(`notify-pace:${notificationId}`, "1 second");
      }
    }

    await step.do("record-run", async () =>
      recordRun(db, {
        // pipeline_runs' source_* columns predate this Worker; here they
        // count search results seen and errors hit rather than ATS sources.
        sourcesOk: searchRefs.length,
        sourcesFailed: errors.length,
        // Count only successfully saved assessments, not failed attempts.
        newPostings: checked,
        alreadyAppliedSkipped: knownRows.length,
        matches,
        errors,
        worker: "unbounded_discovery",
      }, lease),
    );
    if (accounting) await step.do("accounting-finish", async () =>
      finishDiscoveryRun(db, lease, lease.owner,
        errors.length || selection.capDeferred || locationHeld || candidateQueue?.pending ? "partial" : "complete",
        new Date().toISOString()));

    return {
      searchResults: searchRefs.length,
      cooldownDeferred: selection.cooldownDeferred,
      capDeferred: selection.capDeferred,
      ...(candidateQueue ? { candidateQueue } : {}),
      newPostingsChecked: checked,
      alreadyApplied: knownRows.length,
      matches,
      delivered,
      locationHeld,
      ...(evidenceMode ? { needsReview } : {}),
      errors,
    };
  }
}

function fetchErrorCode(message: string): string {
  const status = /HTTP\s+(\d{3})/i.exec(message);
  if (status) return `http_${status[1]}`;
  return /time.?out|abort/i.test(message) ? "timeout" : "provider_error";
}

// A definitively-dead posting (404 on Greenhouse/Lever, absent from the
// fetched Ashby board) gets a `jobs` row so its id is dedup'd permanently —
// otherwise a Google-indexed-but-removed posting stays "new" and keeps
// costing a MAX_NEW_POSTINGS_PER_RUN slot on every run it resurfaces in.
// verdict: null makes it read exactly like a baseline row: never notified,
// never matched. Built from the JobRef alone (no detail fetch succeeded),
// the same way known-application rows are.
function buildTombstoneRow(ref: JobRef, firstSeenAt: string, criteriaVersion: string): JobInsert {
  return {
    job: {
      id: jobRefId(ref),
      company: titleCaseSlug(ref.slug),
      title: ref.title,
      url: ref.url,
      location: "unspecified",
      department: "unspecified",
      isRemote: null,
      employmentType: null,
      postedAt: null,
      compensation: null,
      // Synthesized from the search result alone — no detail fetch happened.
      description: null,
    },
    firstSeenAt,
    criteriaVersion,
    isKnownApplication: false,
    knownApplicationSource: null,
    verdict: null,
    applicationStatus: "not_applied",
    applicationStatusSource: "pipeline",
    discoverySource: "unbounded_search",
    deferNotifiedAt: true,
  };
}

function headerMessage(
  delivering: number,
  matchedThisRun: number,
  newPostingsChecked: number,
  alreadyApplied: number,
  errors: string[],
  deliveringReviews?: number,
  needsReviewThisRun = 0,
): string {
  // `delivering` counts what is being sent now, which is this run's matches
  // plus any earlier run left undelivered — so it must not be described as
  // "new", or a drained backlog would read as a sudden surge of fresh finds.
  const carried = delivering - matchedThisRun - needsReviewThisRun;
  const lines = [
    (deliveringReviews === undefined ? `:telescope: Unbounded search: ${delivering} match(es) to review`
      : `:telescope: Unbounded search: ${delivering - deliveringReviews} possible match(es); ${deliveringReviews} need(s) evidence review`) +
      (carried > 0 ? ` (${matchedThisRun + needsReviewThisRun} new, ${carried} carried over from an earlier run).` : "."),
    `${newPostingsChecked} new posting(s) checked this run.` + (deliveringReviews === undefined ? "" : ` ${matchedThisRun} possible match(es), ${needsReviewThisRun} need(s) evidence review.`),
  ];
  if (alreadyApplied > 0) {
    lines.push(`(${alreadyApplied} skipped — already tracked as an existing application.)`);
  }
  if (delivering >= MAX_NOTIFICATIONS_PER_RUN) {
    lines.push(`Capped at ${MAX_NOTIFICATIONS_PER_RUN} per run — any remainder follows next run.`);
  }
  if (errors.length) {
    const examples = errors.slice(0, 3).map(error => error.slice(0, 180));
    lines.push(`${errors.length} errors this run: ${examples.join("; ")}` +
      (errors.length > examples.length ? `; ${errors.length - examples.length} more in the run record.` : ""));
  }
  return lines.join("\n");
}

// A tapped button reaches the Worker here. Slack gives us three seconds to
// answer before it shows the user a failure, so this verifies, acknowledges,
// and does the D1 write plus the message rewrite afterwards.
async function handleSlackAction(request: Request, env: Env & { runtime: RuntimeConfig; instance: InstanceConfig }, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await request.text();
  const verified = await verifySlackRequest(
    env.SLACK_SIGNING_SECRET,
    request.headers.get("x-slack-signature"),
    request.headers.get("x-slack-request-timestamp"),
    rawBody,
  );
  if (!verified) return new Response("Bad signature", { status: 401 });

  // The application tracker's answer and Undo buttons. Same allowlist, same
  // acknowledge-then-work pattern as the job buttons below.
  const lifecycle = parseLifecycleAction(rawBody);
  if (lifecycle) {
    if (env.LIFECYCLE_MODE !== "live") return new Response("", { status: 200 });
    if (!env.SLACK_ALLOWED_USER_ID || lifecycle.userId !== env.SLACK_ALLOWED_USER_ID) return new Response("", { status: 200 });
    const where = { channelId: lifecycle.channelId, messageTs: lifecycle.messageTs, blocks: lifecycle.blocks, text: lifecycle.text };
    ctx.waitUntil(
      lifecycle.kind === "answer" ? answerQuestion(env, lifecycle.messageId, lifecycle.option, where) : undoChange(env, lifecycle.messageId, where),
    );
    return new Response("", { status: 200 });
  }

  // The AI radar's feedback buttons. Same allowlist, same acknowledge-then-
  // work pattern as the lifecycle buttons above.
  const radarAction = parseRadarAction(rawBody);
  if (radarAction) {
    if (env.RADAR_MODE !== "on") return new Response("", { status: 200 });
    assertRadarProfileAvailable(env.runtime, env.instance);
    if (!env.SLACK_ALLOWED_USER_ID || radarAction.userId !== env.SLACK_ALLOWED_USER_ID) return new Response("", { status: 200 });
    ctx.waitUntil(handleRadarAction(env, radarAction));
    return new Response("", { status: 200 });
  }

  const interaction = parseInteraction(rawBody);
  // Interactivity delivers payload types this endpoint doesn't handle, and
  // Slack retries anything that isn't a 2xx — so unknown payloads are
  // acknowledged rather than rejected.
  if (!interaction) return new Response("", { status: 200 });

  // The validated instance always requires an explicit authorized user.
  if (!env.SLACK_ALLOWED_USER_ID || interaction.userId !== env.SLACK_ALLOWED_USER_ID) {
    return new Response("", { status: 200 });
  }

  ctx.waitUntil(recordAndReflect(env, interaction));
  return new Response("", { status: 200 });
}

async function recordAndReflect(env: Env, interaction: Interaction): Promise<void> {
  const status = ACTION_STATUS[interaction.actionId];
  const at = new Date();
  const recorded = await setApplicationStatus(env.DB, interaction.jobId, status, "manual", at.toISOString());

  // Undo clears the receipt and puts the buttons back. A write that matched
  // no row is reflected literally rather than shown as a success — the
  // message is the only feedback you get, so it must not lie about D1.
  const mark = !recorded
    ? { status: `:warning: Not recorded — no job row for \`${interaction.jobId}\``, userId: interaction.userId, at }
    : interaction.actionId === "mark_undo"
      ? null
      : { status, userId: interaction.userId, at };

  await updateMessage(
    env,
    interaction.channelId,
    interaction.messageTs,
    applyMark(interaction.blocks as any[], interaction.jobId, mark),
    interaction.text,
  );
}


// ---------------------------------------------------------- /job command
//
// Adding a posting by hand is itself an expression of interest, so a manual
// add lands as needs_materials straight away and the message is posted
// already classified rather than with unpressed buttons. GLM still evaluates
// it — the verdict is worth having for calibration, since disagreements
// between your picks and its picks are the clearest signal the criteria are
// off — but it never gates: you chose this posting, so it is recorded and
// surfaced regardless of what the model thinks.
const JOB_COMMAND_USAGE =
  "Usage: `/job <posting url>`\nSupported: Greenhouse, Lever, Ashby and Workday links. " +
  "LinkedIn and company careers pages can't be fetched — use the posting's ATS link instead.";

async function handleSlashCommand(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await request.text();
  const verified = await verifySlackRequest(
    env.SLACK_SIGNING_SECRET,
    request.headers.get("x-slack-signature"),
    request.headers.get("x-slack-request-timestamp"),
    rawBody,
  );
  if (!verified) return new Response("Bad signature", { status: 401 });

  const command = parseSlashCommand(rawBody);
  if (!command) return new Response("", { status: 200 });

  if (!env.SLACK_ALLOWED_USER_ID || command.userId !== env.SLACK_ALLOWED_USER_ID) {
    return Response.json({ response_type: "ephemeral", text: "This command isn't available to you." });
  }
  if (!command.text) {
    return Response.json({ response_type: "ephemeral", text: JOB_COMMAND_USAGE });
  }

  // Slack shows the caller an error unless it hears back within 3 seconds,
  // and fetching a posting plus a GLM verdict takes far longer than that.
  ctx.waitUntil(addJobByUrl(env, command));
  return Response.json({ response_type: "ephemeral", text: `Looking up ${command.text} …` });
}

async function addJobByUrl(rawEnv: Env, command: SlashCommand): Promise<void> {
  const env = await configureEnv(rawEnv);
  const runId = `manual:${crypto.randomUUID()}`;
  env.runtime = await admitRunConfig(env.DB, runId, env.runtime);
  const db = env.DB;
  try {
    const ref = parseJobUrl(command.text, "");
    const id = ref ? jobRefId(ref) : null;
    if (id && (await getExistingJobIds(db, [id])).has(id)) {
      await respondEphemeral(
        command.responseUrl,
        `Already tracked — the pipeline has seen this posting. Search the channel for it, or check D1 for id \`${id}\`.`,
      );
      return;
    }

    // A posting the candidate already applied to gets that answer, not a second row.
    // A careers page embedding a Greenhouse posting can name one too, though
    // only an ATS link can be added.
    const applied = await appliedApplicationForUrl(db, command.text).catch(() => null);
    if (applied) {
      await respondEphemeral(command.responseUrl, alreadyAppliedText(applied));
      return;
    }
    if (!ref) {
      await respondEphemeral(command.responseUrl, `Couldn't read that link.\n${JOB_COMMAND_USAGE}`);
      return;
    }

    const job = await fetchJobForRef(ref);
    if (!job) {
      await respondEphemeral(
        command.responseUrl,
        "That posting couldn't be fetched — it may already be closed, or the link may point at a board rather than a single posting.",
      );
      return;
    }

    // Recorded for calibration, never used as a gate.
    // Manual intake can retain its established evaluator during a discovery
    // rollout. An absent override preserves the existing inherited mode.
    const evidenceMode = (env.MANUAL_SCREENING_MODE ?? env.SCREENING_MODE) === "evidence";
    let verdict: Verdict | null = null;
    let screening: Pick<ScreeningEvaluation, "snapshot" | "decision"> | undefined;
    try {
      if (evidenceMode) screening = await evaluateJob(env, job);
      else verdict = await filterJob(env, job);
    } catch {
      verdict = null;
      if (evidenceMode) screening = { snapshot: null, decision: screeningRetryDecision("Screening could not be prepared; no assessment is available.", env.runtime) };
    }

    const at = new Date();
    const row: JobInsert = {
        job,
        firstSeenAt: at.toISOString(),
        criteriaVersion: env.runtime.criteriaVersion,
        isKnownApplication: false,
        knownApplicationSource: null,
        verdict,
        applicationStatus: "needs_materials",
        applicationStatusSource: "manual",
        discoverySource: "manual_add",
        deferNotifiedAt: true,
    };
    const evaluation = screening ? await createEvaluation({ jobId: job.id, runId, ...screening, evaluatedAt: at.toISOString() }) : undefined;
    if (evaluation) await saveManualScreeningResult(db, row, evaluation, env.instance.instanceId);
    else await insertJobs(db, [row]);

    const mark: Mark = { status: "needs_materials", userId: command.userId, at };
    const advisory = screening ? { match: screening.decision.state === "match", lane: screening.decision.lane, hard_exclude: screening.decision.hardExclude, reason: screening.decision.reason } : verdict;
    if (!await isActiveCriteria(db, env.instance.instanceId, env.runtime.criteriaVersion)) {
      await respondEphemeral(command.responseUrl, "Saved the selection. Candidate criteria changed; advisory delivery requires review.");
      return;
    }
    await postMatch(env, job, screening ? { ...advisory!, reason: `Added by hand. Advisory screening: ${screening.decision.reason}` } : displayVerdict(verdict), mark, screening?.decision);
    if (evaluation) await markScreeningNotified(db, job.id, evaluation.id, at.toISOString());
    await markNotified(db, [job.id], at.toISOString());

    await respondEphemeral(command.responseUrl, `Added *${job.title}* — ${job.company}, queued for materials.`);
  } catch (e) {
    await respondEphemeral(command.responseUrl, `Couldn't add that posting: ${(e as Error).message}`);
  }
}

// A manual add is surfaced whatever GLM concluded, but the message should say
// so plainly rather than presenting a rejection as if it were a match.
function displayVerdict(verdict: Verdict | null): Verdict {
  if (!verdict) {
    return { match: true, hard_exclude: null, lane: null, reason: "Added by hand; not evaluated." };
  }
  if (verdict.match) return verdict;
  return { ...verdict, reason: `Added by hand. GLM disagreed: ${verdict.reason}` };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const configured = await configureEnv(env);
    env = configured;
    if (configured.instance.shadowMode) return new Response("Setup preview: operational entry disabled", { status: 503 });
    const page = publicPage(request, configured.instance);
    if (page) return page;
    const path = new URL(request.url).pathname;
    if (path === "/slack/actions") return handleSlackAction(request, configured, ctx);
    if (path === "/slack/commands") {
      if (env.MANUAL_INTAKE_MODE !== "durable") return handleSlashCommand(request, env, ctx);
      if (!env.MANUAL_INTAKE_WORKFLOW) return new Response("Manual intake unavailable", { status: 503 });
      return handleIntakeCommand(request, env, id => {
        ctx.waitUntil(dispatchIntake(env.DB, workflowControl(env.MANUAL_INTAKE_WORKFLOW!),
          id, Date.now()).then(() => {}, () => {
          console.error("Manual intake dispatch kick failed", { requestId: id });
        }));
      });
    }
    if (path === "/intake/reconcile") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!authorizedTrigger(request, env.TRIGGER_SECRET))
        return new Response("Unauthorized", { status: 401 });
      if (!env.MANUAL_INTAKE_WORKFLOW) return new Response("Manual intake unavailable", { status: 503 });
      const rawLimit = new URL(request.url).searchParams.get("limit");
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return new Response("Invalid limit", { status: 400 });
      return Response.json(await reconcileIntakes(env.DB,
        workflowControl(env.MANUAL_INTAKE_WORKFLOW), Date.now(), limit));
    }
    if (path === "/intake/receipt") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!authorizedTrigger(request, env.TRIGGER_SECRET))
        return new Response("Unauthorized", { status: 401 });
      if (Number(request.headers.get("content-length")) > 4096)
        return new Response("Invalid receipt evidence", { status: 413 });
      let input: unknown;
      try {
        const body = await request.text();
        if (body.length > 4096) return new Response("Invalid receipt evidence", { status: 413 });
        input = JSON.parse(body);
      } catch { return new Response("Invalid receipt evidence", { status: 400 }); }
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        (input as {channelId?:unknown}).channelId !== env.SLACK_CHANNEL_ID)
        return new Response("Invalid receipt channel", { status: 400 });
      try {
        const recorded = await recordVerifiedManualReceipt(env.DB, input as Parameters<typeof recordVerifiedManualReceipt>[1]);
        return Response.json({ recorded }, { status: recorded ? 200 : 409,
          headers: { "Cache-Control": "no-store" } });
      } catch { return new Response("Invalid or unavailable receipt evidence", { status: 400 }); }
    }
    if (request.method === "GET" && path === "/discovery/report" && env.DISCOVERY_ACCOUNTING_MODE === "on") {
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
    // POST /?workflow=lifecycle runs the email tracker on demand.
    if (new URL(request.url).searchParams.get("workflow") === "lifecycle") {
      if (!configured.instance.lifecycle.enabled) return new Response("Lifecycle disabled", { status: 403 });
      return Response.json({ id: (await env.LIFECYCLE_WORKFLOW.create({})).id });
    }
    // POST /?workflow=radar runs the AI radar now, in any RADAR_MODE;
    // &repost=<run id> posts a saved digest again instead.
    if (new URL(request.url).searchParams.get("workflow") === "radar") {
      if (!configured.instance.radar.enabled) return new Response("Radar disabled", { status: 403 });
      assertRadarProfileAvailable(configured.runtime, configured.instance);
      const repost = new URL(request.url).searchParams.get("repost");
      if (repost) {
        try {
          return Response.json({ ts: await repostDigest(env, repost) });
        } catch (e) {
          // An unknown run, no saved digest, or a run that isn't failed is an
          // answer for the caller, not a Worker error.
          if (e instanceof RepostRefused) return Response.json({ error: e.message }, { status: e.status });
          throw e;
        }
      }
      return Response.json({ id: await startRadarRun(env.RADAR_WORKFLOW, `radar-manual-${Date.now()}`) });
    }
    return Response.json(await triggerDiscovery(env.DB, env.AGENT_WORKFLOW, "unbounded_discovery"));
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const configured = await configureEnv(env);
    env = configured;
    if (configured.instance.shadowMode) return;
    // Start independent work on the same tick even if another dispatch fails.
    // Recovery keeps its existing request/generation IDs and lease behavior.
    const outcomes = await Promise.allSettled(dueWorkflows(new Date(event.scheduledTime), configured.instance.schedule).map(async slot => {
      const id = `${configured.instance.instanceId}-${slot.slotKey}`;
      if (slot.workflow === "lifecycle") {
        if (configured.instance.lifecycle.enabled && configured.LIFECYCLE_MODE !== "off")
          await startScheduledWorkflow(env.LIFECYCLE_WORKFLOW, id);
      } else if (slot.workflow === "radar") {
        if (configured.instance.radar.enabled) await startScheduledWorkflow(env.RADAR_WORKFLOW, id);
      } else if (slot.workflow === "intake") {
        if (!env.MANUAL_INTAKE_WORKFLOW) throw new Error("Missing manual intake Workflow binding");
        await reconcileIntakes(env.DB, workflowControl(env.MANUAL_INTAKE_WORKFLOW), event.scheduledTime);
      } else if (slot.workflow === "discovery") {
        if (env.DISCOVERY_ACCOUNTING_MODE === "on") {
          try { await reconcileIncompleteRuns(env.DB, "unbounded_discovery", env.AGENT_WORKFLOW); }
          catch (error) { console.error("Discovery health reconciliation failed", error); }
        }
        await startScheduledWorkflow(env.AGENT_WORKFLOW, id);
      }
    }));
    const failure = outcomes.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
};
