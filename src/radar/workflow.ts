import { admitRunConfig } from "../config/run-context";
import { configureEnv, type ConfigBindings } from "../config/env";
// The AI radar's daily run. Each stage is a durable step, so a retried or
// resumed run repeats only what didn't finish.
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { FilterEnv } from "../filter";
import { postBlocks, postText, type SlackEnv, type SlackPostEnv } from "../slack";
import { Meter, monthStart, PAGE_SIZE, requestCost, runAllowance, splitAllowance } from "./budget";
import { collect, expand } from "./collect";
import * as store from "./db";
import { renderDigest, type ItemMeta } from "./digest-blocks";
import { contextFromExpansion, createEditorClient, digestItemCount, digestPostIds, runEditor, type Digest } from "./editor";
import { selectCandidates, type Candidate } from "./rank";
import { buildQueryPlan, sinceTime } from "./sources";
import { buildRadarProfile, configuredRadarQueries } from "./profile";
import type { RuntimeConfig, InstanceConfig } from "../config/types";
import { TOPICS } from "./topics";
import { callTriageModel, triageInputFromRow, triageWithRecovery } from "./triage";
import { createXClient, type Page, type XClient } from "./x-client";

export type RadarEnv = ConfigBindings & FilterEnv &
  SlackEnv & {
    DB: D1Database;
    // Only "on" starts the daily run (checked in scheduled()). Manual runs
    // work in any mode, which is how the first digest is reviewed.
    RADAR_MODE: string;
    RADAR_CHANNEL_ID: string;
    RADAR_MONTHLY_BUDGET_USD: string;
    TWITTERAPI_IO_KEY: string;
    ANTHROPIC_API_KEY: string;
  };

export const TRIAGE_BATCH_SIZE = 20;
const HOUR = 3_600_000;
const RETENTION_DAYS = 60;

export function assertRadarProfileAvailable(runtime: RuntimeConfig, instance: InstanceConfig): void {
  buildRadarProfile(runtime, instance);
}

export class RadarWorkflow extends WorkflowEntrypoint<RadarEnv, {}> {
  async run(event: WorkflowEvent<{}>, step: WorkflowStep) {
    const env = await configureEnv(this.env);
    if (env.instance.shadowMode) return { skipped: "preview" };
    env.runtime = await admitRunConfig(env.DB, event.instanceId, env.runtime);
    if (!env.instance.radar.enabled) return { skipped: "off" };
    const profile = buildRadarProfile(env.runtime, env.instance);
    const selection = configuredRadarQueries(env.runtime, env.instance);
    const db = env.DB;
    const runId = event.instanceId;
    // Before any step: with no channel there's nowhere to post a notice, so
    // the reason goes to Workers Logs. The check is deterministic and has no
    // side effects, so it needs no step of its own.
    const configError = radarConfigError(env);
    if (configError) {
      console.error(JSON.stringify({ event: "radar_config_error", runId, error: configError }));
      return { skipped: configError };
    }
    const slack = radarSlack(env);

    const plan = await step.do("plan", async () => {
      const now = new Date();
      if (await store.otherRunInProgress(db, runId, new Date(now.getTime() - HOUR).toISOString())) return { skip: true as const };
      const since = sinceTime(await store.lastCollectStart(db), now);
      const allowance = runAllowance(Number(env.RADAR_MONTHLY_BUDGET_USD), await store.monthSpend(db, monthStart(now)), now);
      await store.startRun(db, runId, now.toISOString(), new Date(since * 1000).toISOString());
      return { skip: false as const, startedAt: now.toISOString(), since, allowance, queries: buildQueryPlan(since, undefined, selection) };
    });
    if (plan.skip) return { skipped: "another radar run started in the last hour" };

    const notice = async (text: string) => {
      await step.do("notice", async () => postText(slack, `:warning: AI radar: ${text}`));
      await step.do("finish-notice", async () =>
        store.finishRun(db, runId, { status: "notice", finishedAt: new Date().toISOString(), error: text }));
      return { notice: text };
    };

    try {
      // Inside the try along with everything below: a failed notice (Slack
      // down, for instance) must still reach record-failure/alert-failure
      // rather than rejecting run() with nothing recorded, since a promise
      // returned without awaiting it here would already be outside the try
      // by the time it rejects.
      //
      // collect starts a request only while a full page still fits, so an
      // allowance below one page would fetch nothing and end in a misleading
      // "no search succeeded". It's as good as spent.
      if (splitAllowance(plan.allowance).collect < requestCost(PAGE_SIZE)) {
        return await notice("the monthly data budget is spent, so there's no digest until next month.");
      }

      const collected = await step.do(
        "collect",
        { timeout: "10 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "constant" } },
        async () => {
          // What this run has already spent (across any earlier attempt of
          // this same step), so a retry tops up the meter rather than
          // starting it over at the step's full share.
          const recorded = (await store.getRun(db, runId))?.est_cost_usd ?? 0;
          const meter = new Meter(Math.max(0, splitAllowance(plan.allowance).collect - recorded));
          const client = recordingClient(createXClient(env.TWITTERAPI_IO_KEY), (rawCount) =>
            store.addSpend(db, runId, { posts: rawCount, requests: 1, spent: requestCost(rawCount) }));
          const result = await collect(plan.queries, client, meter, (entry, posts) => store.savePosts(db, runId, posts, entry.id));
          // A search with at least one page has partial budget coverage.
          // Record that coverage without treating it as a Slack warning.
          if (result.thinned > 0) console.log(JSON.stringify({ event: "radar_collect_thinned", runId, thinned: result.thinned }));
          // Every search coming back empty counts as a fault, not a quiet
          // window, so the next run's window
          // doesn't move past it. result.posts is the billed raw count,
          // before replies and reposts are dropped.
          const collectOk = result.okRequests > 0 && result.posts > 0;
          await store.recordCollect(db, runId, { cutShort: result.cutShort, collectOk, errors: result.errors });
          return result;
        },
      );
      if (collected.okRequests === 0) return await notice(`no digest today: ${collected.errors[0] ?? "no search succeeded"}`);
      if (collected.posts === 0) {
        return await notice(
          "no digest today: every search came back empty, which usually means the provider or a search operator broke. " +
          "The next run looks back over the same window.",
        );
      }

      const batches = await step.do("select-for-triage", async () => chunk(await store.newPostIds(db, runId), TRIAGE_BATCH_SIZE));
      let triageFailed = 0;
      for (let i = 0; i < batches.length; i++) {
        const outcome = await step.do(
          `triage:${i}`,
          { timeout: "15 minutes", retries: { limit: 1, delay: "30 seconds", backoff: "constant" } },
          async () => {
            const rows = await store.getPosts(db, batches[i]);
            const { results, failed } = await triageWithRecovery(rows.map(triageInputFromRow), (posts) => callTriageModel(env, posts, profile, env.instance.radar.topics));
            await store.saveTriage(db, results);
            await store.markTriageFailed(db, failed);
            return { failed: failed.length };
          },
        );
        triageFailed += outcome.failed;
        // Workers AI allows this model 20 requests a minute.
        if (i < batches.length - 1) await step.sleep(`pace:${i}`, "4 seconds");
      }
      await step.do("record-triage", async () => store.recordTriage(db, runId, batches.length, triageFailed));

      const candidates = await step.do("rank", async () => selectCandidates(await store.triagedRows(db, runId), new Date(plan.startedAt)));
      if (!candidates.length) {
        // A triage outage also leaves nothing to rank, but it isn't a quiet day.
        return await notice(triageFailed > 0
          ? `no digest today: ${plural(triageFailed, "post", "posts")} couldn't be triaged (Workers AI may be down) and nothing else scored above noise.`
          : "no digest today: nothing new scored above noise.");
      }

      const expanded = await step.do(
        "expand",
        { timeout: "5 minutes", retries: { limit: 2, delay: "30 seconds", backoff: "constant" } },
        async () => {
          const recorded = (await store.getRun(db, runId))?.est_cost_usd ?? 0;
          // Its own 20% share, but never more than what the whole run has
          // left once collect (and any earlier expand attempt) is counted.
          const meter = new Meter(Math.max(0, Math.min(splitAllowance(plan.allowance).expand, plan.allowance - recorded)));
          const client = recordingClient(createXClient(env.TWITTERAPI_IO_KEY), (rawCount) =>
            store.addSpend(db, runId, { posts: rawCount, requests: 1, spent: requestCost(rawCount) }));
          const targets = candidates.filter((c) => c.kind !== "hiring" && c.score >= 2).slice(0, 8);
          const { expansions, errors } = await expand(targets, client, meter);
          if (errors.length) {
            console.warn(JSON.stringify({ event: "radar_expand_errors", runId, errors }));
            await store.appendRunErrors(db, runId, errors);
          }
          return { contexts: expansions.map(contextFromExpansion) };
        },
      );

      // runEditor takes 8 minutes at worst and never throws, so its plain-list
      // fallback always runs inside this step's 10. The one retry is for a
      // failed D1 read or write, and calls Claude again.
      const edited = await step.do("edit", { timeout: "10 minutes", retries: { limit: 1, delay: "30 seconds", backoff: "constant" } }, async () => {
        const result = await runEditor(() => createEditorClient(env), {
          candidates,
          contexts: expanded.contexts,
          taste: await store.tasteExamples(db),
        }, profile);
        await store.recordEditor(db, runId, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          fallback: result.fallback,
          digestJson: JSON.stringify(result.digest),
        });
        // A diagnostic for how often the editor ignores the cap, not a run
        // fault: it isn't stored on radar_runs or shown in the digest.
        if (result.trimmed > 0) console.warn(JSON.stringify({ event: "radar_digest_trimmed", runId, trimmed: result.trimmed }));
        if (result.fallback) {
          console.warn(JSON.stringify({ event: "radar_editor_fallback", runId, problems: result.problems }));
          await store.appendRunErrors(db, runId, result.problems.map((p) => `editor fallback: ${p}`));
        }
        return result;
      });

      // Posting and recording are separate steps, so a failure after the
      // post can't make a replay post the digest twice. Two quick retries:
      // Slack's not_in_channel and invalid_blocks are deterministic, so more
      // would only delay the failure alert.
      const ts = await step.do("post", { retries: { limit: 2, delay: "10 seconds", backoff: "constant" } }, async () => {
        // The run's own recorded totals (collect plus any expansion spend);
        // collected.* is only a fallback for a run row that somehow isn't there.
        const recordedRun = await store.getRun(db, runId);
        const { text, blocks } = renderDigest(
          edited.digest,
          itemMeta(candidates),
          { dateLabel: dateLabel(plan.startedAt, env.instance.schedule.timezone), postsConsidered: collected.posts },
          {
            postsRead: recordedRun?.posts_read ?? collected.posts,
            estCostUsd: recordedRun?.est_cost_usd ?? collected.spent,
            warnings: footerWarnings(collected, triageFailed, edited.fallback),
          },
        );
        return postBlocks(slack, text, blocks);
      });

      await step.do("finish", async () => {
        await store.markDigest(db, digestPostIds(edited.digest), plan.startedAt.slice(0, 10));
        await store.finishRun(db, runId, { status: "posted", finishedAt: new Date().toISOString(), slackTs: ts });
      });
      // Housekeeping only: a failure is logged and never marks a posted run
      // as failed. The next run prunes the same rows.
      await step.do("prune", async () => {
        try {
          await store.prunePosts(db, new Date(Date.parse(plan.startedAt) - RETENTION_DAYS * 24 * HOUR).toISOString());
        } catch (e) {
          console.warn(JSON.stringify({ event: "radar_prune_failed", runId, error: (e as Error).message }));
        }
      });
      return { posted: ts, items: digestItemCount(edited.digest) };
    } catch (e) {
      // An error that outlasted its step's retries. The saved digest (if the
      // edit step finished) can be posted with ?workflow=radar&repost=<id>.
      const message = (e as Error).message;
      await step.do("record-failure", async () =>
        store.finishRun(db, runId, { status: "failed", finishedAt: new Date().toISOString(), error: message }));
      await step.do("alert-failure", async () => {
        try {
          await postText(slack, `:warning: AI radar run failed: ${message}`);
        } catch {
          // Slack may be what failed; Workers Logs and radar_runs have it.
        }
      });
      throw e;
    }
  }
}

// Each completed request is on record before the next one starts, so a step
// that fails and is retried can't spend unrecorded money or overrun the
// run's allowance.
function recordingClient(client: XClient, record: (rawCount: number) => Promise<void>): XClient {
  const after = async (page: Page) => { await record(page.rawCount); return page; };
  return {
    searchPosts: (query, queryType, cursor) => client.searchPosts(query, queryType, cursor).then(after),
    getThreadContext: (postId) => client.getThreadContext(postId).then(after),
    getTopReplies: (postId) => client.getTopReplies(postId).then(after),
  };
}

// Cron runs use the date as the id, so a repeated delivery finds the day's
// run already there instead of starting a second one.
export async function startRadarRun(workflow: Workflow, id: string): Promise<string> {
  try {
    return (await workflow.create({ id })).id;
  } catch (e) {
    try {
      await workflow.get(id);
    } catch {
      throw e;
    }
    return id;
  }
}

// A repost the trigger route turns down, with the HTTP status it answers.
export class RepostRefused extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = "RepostRefused";
  }
}

// Only a failed run's digest: a posted run's is already in the channel, and
// a running one may still post its own.
export async function repostDigest(rawEnv: RadarEnv, runId: string): Promise<string> {
  const env = await configureEnv(rawEnv);
  if (!env.instance.radar.enabled || env.instance.shadowMode) throw new RepostRefused("Radar disabled", 409);
  assertRadarProfileAvailable(env.runtime, env.instance);
  const run = await store.getRun(env.DB, runId);
  if (!run?.digest_json) throw new RepostRefused(`no saved digest for run ${runId}`, 404);
  if (run.status !== "failed") throw new RepostRefused(`run ${runId} is ${run.status}; only a failed run's digest can be reposted`, 409);
  const digest = JSON.parse(run.digest_json) as Digest;
  const ids = digestPostIds(digest);
  const rows = await store.getPosts(env.DB, ids);
  const meta = new Map<string, ItemMeta>(rows.map((r): [string, ItemMeta] => {
    const m = JSON.parse(r.metrics_json) as store.Metrics;
    return [r.id, {
      url: r.url,
      authorHandle: r.author_handle,
      ageHours: (Date.parse(run.started_at) - Date.parse(r.created_at)) / HOUR,
      likes: m.likes,
      replies: m.replies,
    }];
  }));
  // The original post's warnings, rebuilt from what the run recorded. Failed
  // searches can't be counted from radar_runs.errors, which holds other
  // errors too, so they're left out.
  const warnings = [
    ...footerWarnings({ cutShort: JSON.parse(run.cut_short ?? "[]") as string[], errors: [] }, run.triage_failed, run.editor_fallback === 1),
    "reposted from a saved digest",
  ];
  const { text, blocks } = renderDigest(
    digest,
    meta,
    { dateLabel: dateLabel(run.started_at, env.instance.schedule.timezone), postsConsidered: run.posts_read },
    { postsRead: run.posts_read, estCostUsd: run.est_cost_usd, warnings },
  );
  const ts = await postBlocks(radarSlack(env), text, blocks);
  await store.markDigest(env.DB, ids, run.started_at.slice(0, 10));
  await store.finishRun(env.DB, runId, { status: "posted", finishedAt: new Date().toISOString(), slackTs: ts });
  return ts;
}

export function footerWarnings(collected: { cutShort: string[]; errors: string[] }, triageFailed: number, fallback: boolean): string[] {
  const warnings: string[] = [];
  // cutShort lists searches stopped before their first page; a search with
  // partial page coverage is not named here.
  if (collected.cutShort.length) warnings.push(`budget skipped: ${sourceNames(collected.cutShort).join(", ")}`);
  if (collected.errors.length) warnings.push(`${plural(collected.errors.length, "search", "searches")} failed`);
  if (triageFailed) warnings.push(`${plural(triageFailed, "post", "posts")} couldn't be triaged`);
  if (fallback) warnings.push("the editor failed, so this is a plain ranked list");
  return warnings;
}

function sourceNames(entryIds: string[]): string[] {
  return [...new Set(entryIds.map((id) => {
    const source = id.slice(0, id.lastIndexOf(":"));
    return source === "hiring" ? "Hiring" : TOPICS.find((t) => t.id === source)?.name ?? source;
  }))];
}

// Why a run can't start, or null. Names only the vars at fault; the budget
// is a var, not a secret, so its value can go in the log.
function radarConfigError(env: Pick<RadarEnv, "RADAR_CHANNEL_ID" | "RADAR_MONTHLY_BUDGET_USD">): string | null {
  if (!env.RADAR_CHANNEL_ID?.trim()) return "RADAR_CHANNEL_ID is empty";
  const budget = Number(env.RADAR_MONTHLY_BUDGET_USD);
  if (!Number.isFinite(budget) || budget < 0) {
    return `RADAR_MONTHLY_BUDGET_USD is ${JSON.stringify(env.RADAR_MONTHLY_BUDGET_USD)}, not a dollar amount of 0 or more`;
  }
  return null;
}

function radarSlack(env: Pick<RadarEnv, "SLACK_BOT_TOKEN" | "RADAR_CHANNEL_ID">): SlackPostEnv {
  return { SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN, SLACK_CHANNEL_ID: env.RADAR_CHANNEL_ID };
}

function itemMeta(candidates: Candidate[]): Map<string, ItemMeta> {
  return new Map(candidates.map((c): [string, ItemMeta] => [
    c.id, { url: c.url, authorHandle: c.authorHandle, ageHours: c.ageHours, likes: c.likes, replies: c.replies },
  ]));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Calendar label in the operator-approved timezone.
export function dateLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: timezone });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
