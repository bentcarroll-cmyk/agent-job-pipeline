import { admitRunConfig } from "../config/run-context";
import { configureEnv, type ConfigBindings } from "../config/env";
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { recordRun } from "../db";
import type { FilterEnv } from "../filter";
import { postText, type SlackEnv } from "../slack";
import { classifyEmail } from "./classify";
import { getCheckpoint, handledIds, retryReceipts, setCheckpoint } from "./db";
import type { EmailMeta } from "./evidence";
import { buildSearchQuery, getAccessToken, getMessage, GmailAuthError, listMessageIds, type GmailEnv } from "./gmail-client";
import { parseMessage } from "./gmail-message";
import { announce, decideAndRecord, type Classified } from "./record";

export type LifecycleEnv = ConfigBindings & FilterEnv &
  SlackEnv &
  GmailEnv & {
    DB: D1Database;
    // "live" writes to the ledger, "off" does nothing, anything else is test mode.
    LIFECYCLE_MODE: string;
  };

const SIGN_IN_ERROR = "Google sign-in needs recovery";
const SIGN_IN_ALERT =
  ":warning: Application tracker: Google sign-in needs recovery; processing stopped. Completed receipts remain saved and unprocessed mail stays retryable.\n" +
  "Fix: rerun `node --import tsx tools/gmail-auth/auth.mjs --instance <selected-instance.json> --client <private-oauth-client.json>` for the selected instance. Credentials are saved directly to that instance's secret store. The next run catches up.";

async function redactedOperation<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new Error(`${label} failed`); }
}

export class LifecycleWorkflow extends WorkflowEntrypoint<LifecycleEnv, {}> {
  async run(event: WorkflowEvent<{}>, step: WorkflowStep) {
    const env = await configureEnv(this.env);
    if (env.instance.shadowMode) return { skipped: "preview" };
    env.runtime = await admitRunConfig(env.DB, event.instanceId, env.runtime);
    const db = env.DB;
    if (!env.instance.lifecycle.enabled || env.LIFECYCLE_MODE === "off") return { skipped: "off" };
    // Fails closed: only the literal "live" writes to the ledger.
    const live = env.LIFECYCLE_MODE === "live";

    const start = await step.do("start", async () => ({ at: new Date().toISOString(), checkpoint: await getCheckpoint(db) }));

    const auth = await step.do("check-google-sign-in", async () => {
      try {
        await getAccessToken(env);
        return { ok: true as const, error: "" };
      } catch (e) {
        if (e instanceof GmailAuthError) return { ok: false as const, error: SIGN_IN_ERROR };
        throw new Error("Google sign-in check failed");
      }
    });
    if (!auth.ok) {
      await step.do("alert-sign-in", async () => redactedOperation("Sign-in alert", () => postText(env, SIGN_IN_ALERT)));
      await step.do("record-run", async () =>
        recordRun(db, { sourcesOk: 0, sourcesFailed: 0, newPostings: 0, alreadyAppliedSkipped: 0, matches: 0, errors: [auth.error], worker: "lifecycle" }),
      );
      return { error: auth.error };
    }

    const classified: Classified[] = [];
    const tally: Record<string, number> = {};
    const saveCompleted = async () => {
      // Oldest first preserves the confirmation -> rejection sequence.
      for (const item of [...classified].sort((a, b) => a.email.date.localeCompare(b.email.date))) {
        const decision = await step.do(`decide:${item.id}`, async () => redactedOperation("Lifecycle receipt save", () => decideAndRecord(db, item, live, new Date().toISOString())));
        tally[decision] = (tally[decision] ?? 0) + 1;
      }
    };
    try {
      // Everything since the last successful run, with 48 hours of overlap,
      // never before the ledger import. Handled messages are skipped by id.
      const search = await step.do("search", async () => {
        try {
          const floor = Date.parse(env.instance.lifecycle.since);
          const from = Math.max(floor, (start.checkpoint ? Date.parse(start.checkpoint) : floor) - 48 * 3_600_000);
          const listed = await listMessageIds(await getAccessToken(env), buildSearchQuery(Math.floor(from / 1000)));
          const done = await handledIds(db, listed.map((m) => m.id), live);
          const pending = new Map<string, { id: string; threadId: string }>();
          for (const m of [...listed.filter((m) => !done.has(m.id)), ...(await retryReceipts(db, live, env.instance.lifecycle.since))]) pending.set(m.id, m);
          return { ok: true as const, found: [...pending.values()] };
        } catch (e) {
          if (e instanceof GmailAuthError) return { ok: false as const };
          throw new Error("Gmail search failed");
        }
      });
      if (!search.ok) throw new GmailAuthError();
      const found = search.found;

      for (let i = 0; i < found.length; i++) {
        const m = found[i];
        // Headers only, so a receipt can be written even if classification fails.
        const metadata = await step.do(`meta:${m.id}`, async () => {
          try {
            const msg = parseMessage(await getMessage(await getAccessToken(env), m.id, "metadata"));
            const email: EmailMeta = { id: msg.id, threadId: msg.threadId, from: msg.from, subject: msg.subject, date: msg.date };
            return { ok: true as const, email };
          } catch (e) {
            if (e instanceof GmailAuthError) return { ok: false as const };
            throw new Error("Gmail metadata read failed");
          }
        });
        if (!metadata.ok) throw new GmailAuthError();
        const email = metadata.email;
        try {
          // The body is fetched and read inside this step only; its output is
          // the classification.
          const classification = await step.do(
            `classify:${m.id}`,
            { timeout: "2 minutes", retries: { limit: 1, delay: "10 seconds", backoff: "constant" } },
            async () => {
              try { return { ok: true as const, c: await classifyEmail(env, parseMessage(await getMessage(await getAccessToken(env), m.id, "full"))) }; }
              catch (e) {
                if (e instanceof GmailAuthError) return { ok: false as const };
                throw new Error("Email classification failed");
              }
            },
          );
          // Auth status crosses the durable boundary as redacted data, not
          // an Error subtype that Workflow replay may reconstruct differently.
          if (!classification.ok) throw new GmailAuthError();
          classified.push({ id: m.id, email, ok: true, c: classification.c });
        } catch (e) {
          if (e instanceof GmailAuthError) throw e;
          classified.push({ id: m.id, email, ok: false, error: "Email classification failed" });
        }
        // Workers AI's 20 requests/minute cap on this model.
        if (i < found.length - 1) await step.sleep(`pace:${m.id}`, "4 seconds");
      }

      await saveCompleted();

      await step.do("announce", async () => redactedOperation("Lifecycle announcement", () => announce(env, live, new Date().toISOString())));

      await step.do("finish", async () => {
        if (live) await setCheckpoint(db, start.at);
        // pipeline_runs' columns predate this Worker. Here: sources_ok = emails
        // handled, sources_failed = unreadable, new_postings = changes,
        // already_applied_skipped = unchanged, matches = questions.
        await recordRun(db, {
          sourcesOk: found.length,
          sourcesFailed: (tally.failed ?? 0) + (tally.retry ?? 0),
          newPostings: tally.applied ?? 0,
          alreadyAppliedSkipped: tally.unchanged ?? 0,
          matches: tally.question ?? 0,
          errors: [],
          worker: "lifecycle",
        });
      });
      return { found: found.length, tally };
    } catch (e) {
      // A Gmail or D1 error that outlasted its step's retries. Receipts
      // already written stand, and the checkpoint didn't move, so the next
      // run picks up exactly the emails this one didn't finish.
      await saveCompleted();
      const message = e instanceof GmailAuthError ? SIGN_IN_ERROR : "Application tracker run failed";
      await step.do("alert-failure", async () =>
        redactedOperation("Failure alert", () => postText(env, e instanceof GmailAuthError ? SIGN_IN_ALERT : `:warning: ${message}.\nCompleted receipts remain saved. The next run retries from the same point.`)),
      );
      await step.do("record-failure", async () =>
        recordRun(db, { sourcesOk: 0, sourcesFailed: 0, newPostings: 0, alreadyAppliedSkipped: 0, matches: 0, errors: [message], worker: "lifecycle" }),
      );
      throw new Error(message);
    }
  }
}
