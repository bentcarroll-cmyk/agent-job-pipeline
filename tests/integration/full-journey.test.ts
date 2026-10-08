// External providers are fabricated; all workflow, screening, D1 and material code is real.
import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createDatabase, loadSchema } from "./harness";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
        env: unknown;
        constructor(_ctx: unknown, env: unknown) { this.env = env; }
    } }));
import { AgentWorkflow } from "../../src/index";
import worker from "../../src/unbounded/index";
import { ManualIntakeWorkflow } from "../../src/intake/workflow";
import { LifecycleWorkflow } from "../../src/lifecycle/workflow";
import { activateCandidateConfig } from "../../src/config/run-context";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { CHICAGO_OPERATIONS, BOSTON_ENGINEERING } from "../fixtures/candidates";
const step = { do: async (_name: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(), sleep: async () => { } };
it.each([[false, CHICAGO_OPERATIONS], [true, BOSTON_ENGINEERING]] as const)("complete synthetic journey engineering=%s", async (engineering, candidate) => {
    const logs: Record<string, unknown>[] = [];
    const original = console.log;
    const logger = vi.spyOn(console, "log").mockImplementation((...args) => { try {
        const value = JSON.parse(String(args[0]));
        if (args.length === 1 && ["model_attempt", "screening_phase"].includes(value.event)) {
            logs.push(value);
            return;
        }
    }
    catch { } original(...args); });
    const h = await createDatabase();
    await loadSchema(h.db, "root");
    const root = await realpath(await mkdtemp(join(tmpdir(), "synthetic-journey-")));
    const instance = JSON.parse(await readFile(new URL("../../examples/instance.json", import.meta.url), "utf8"));
    instance.lifecycle.enabled = true;
    instance.lifecycle.since = "2026-01-01";
    instance.schedule.lifecycleLocalTime = "10:00";
    instance.schedule.timezone = engineering ? "America/New_York" : "America/Chicago";
    instance.screeningMode = "evidence";
    instance.manualScreeningMode = "legacy";
    const runtime = await loadRuntimeConfig(candidate);
    await activateCandidateConfig(h.db, instance.instanceId, runtime, null);
    const location = engineering ? "Boston, MA" : "Chicago, IL", title = engineering ? "Software Engineering Lead" : "Operations Lead", company = candidate.search.sources[0].company;
    let ids = [100], mail: string[] = [], classificationAttempts = 0, failClassify = true;
    const slack: unknown[] = [];
    const waits: Promise<unknown>[] = [];
    const launched: Array<{
        id: string;
        params: any;
    }> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    const rawJob = (id: number) => ({ id, title: id === 101 ? title : `Synthetic Other Role ${id}`, absolute_url: `https://job-boards.greenhouse.io/example-automation/jobs/${id}`, location: { name: location }, departments: [{ name: "Synthetic" }], content: `<p>Lead ${engineering ? "software engineering" : "operations"} and improve workflows.</p><p>This role is full-time.</p><p>Annual base salary USD 170,000 - USD 190,000.</p>` });
    const eventFor = (id: string) => id === "confirmation" ? "application_confirmation" : id === "invite" ? "interview_invitation" : id === "logistics" ? "interview_logistics" : "rejection";
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        requests.push(url.hostname);
        if (url.hostname === "boards-api.greenhouse.io") {
            const id = url.pathname.split("/").at(-1)!;
            return Response.json(/^\d+$/.test(id) ? rawJob(Number(id)) : { jobs: ids.map(rawJob) });
        }
        if (url.hostname === "slack.com") {
            slack.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: true, ts: "100.1", channel: instance.slack.channelId });
        }
        if (url.hostname === "oauth2.googleapis.com")
            return Response.json({ access_token: "SYNTHETIC-ACCESS" });
        if (url.hostname === "gmail.googleapis.com") {
            if (url.pathname.endsWith("/messages"))
                return Response.json({ messages: mail.map(id => ({ id, threadId: "synthetic-thread" })) });
            const id = url.pathname.split("/").at(-1)!;
            const day = { confirmation: 2, invite: 3, logistics: 4, rejection: 5 }[id] ?? 2;
            return Response.json({ id, threadId: "synthetic-thread", internalDate: String(Date.now() + (day - 2) * 86400000), payload: { mimeType: "text/plain", headers: [{ name: "From", value: "careers@example.test" }, { name: "Subject", value: id }], ...(url.searchParams.get("format") === "full" ? { body: { data: Buffer.from("SYNTHETIC-PRIVATE-BODY " + id).toString("base64url") } } : {}) } });
        }
        throw new Error("Unexpected external request");
    });
    const env: any = { DB: h.db, CANDIDATE_CONFIG: JSON.stringify(candidate), INSTANCE_CONFIG: JSON.stringify(instance), AI_GATEWAY_ID: "synthetic", SLACK_BOT_TOKEN: "SYNTHETIC-BOT", SLACK_SIGNING_SECRET: "SYNTHETIC-SIGNING", LIFECYCLE_MODE: "live", GMAIL_CLIENT_ID: "SYNTHETIC-ID", GMAIL_CLIENT_SECRET: "SYNTHETIC-CLIENT", GMAIL_REFRESH_TOKEN: "SYNTHETIC-REFRESH", MANUAL_INTAKE_MODE: "durable", MANUAL_INTAKE_WORKFLOW: { create: async (input: any) => { launched.push(input); return { id: input.id }; }, get: async () => ({ status: async () => ({ status: "running" }) }) }, AI: { run: async (_model: string, input: any) => {
                const name = input.tools[0].function.name;
                let args: any;
                if (name === "record_email") {
                    classificationAttempts++;
                    const body = input.messages[1].content, id = mail.find(id => body.includes("Subject: " + id))!;
                    if (id === "confirmation" && failClassify) {
                        failClassify = false;
                        throw new Error("Synthetic transient classification");
                    }
                    args = { event: eventFor(id), employer: company, title, requisition_id: "101", round_stage: id === "invite" ? "recruiter_screen" : null, scheduled_for: id === "logistics" ? "2026-10-09T16:00:00Z" : null };
                }
                else if (name === "record_screening_decision")
                    args = { state: "match", lane: "A", hardExclude: "none", reason: "Synthetic configured fit", gaps: [], evidence: [{ field: "function", sourceField: "description", value: "fit", excerpt: `Lead ${engineering ? "software engineering" : "operations"} and improve workflows.` }, { field: "location", sourceField: "location", value: location, excerpt: location }] };
                else
                    args = { match: true, lane: "A", hard_exclude: null, reason: "Synthetic advisory" };
                return { choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] };
            } } };
    const signed = (path: string, body: string) => { const timestamp = String(Math.floor(Date.now() / 1000)); return new Request("https://worker.example.test" + path, { method: "POST", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=" + createHmac("sha256", env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex") } }); };
    try {
        expect(await new AgentWorkflow({} as any, env).run({ instanceId: "baseline", payload: {} } as any, step as any)).toMatchObject({ baseline: true });
        ids = [100, 101];
        await new AgentWorkflow({} as any, env).run({ instanceId: "discovery", payload: {} } as any, step as any);
        const id = `greenhouse:${company}:101`;
        expect(await h.db.prepare("SELECT match,application_status,criteria_version,notified_at FROM jobs WHERE id=?").bind(id).first()).toMatchObject({ match: 1, application_status: "not_applied", criteria_version: runtime.criteriaVersion, notified_at: expect.any(String) });
        const before = await h.db.prepare("SELECT COUNT(*) AS n FROM jobs").first();
        await new AgentWorkflow({} as any, env).run({ instanceId: "discovery-retry", payload: {} } as any, step as any);
        expect(await h.db.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual(before);
        const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: instance.slack.allowedUserId }, channel: { id: instance.slack.channelId }, message: { ts: "100.1", blocks: [], text: "Synthetic" }, actions: [{ action_id: "mark_materials", value: id }] }) }).toString();
        expect((await worker.fetch(signed("/slack/actions", body), env, ctx)).status).toBe(200);
        await Promise.all(waits.splice(0));
        expect(await h.db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(id).first()).toEqual({ application_status: "needs_materials" });
        // No PDF exists until an explicit materials request invokes the real Python tools.
        const python = process.env.MATERIALS_PYTHON ?? resolve("tools/materials/.venv/bin/python");
        const output = spawnSync(python, ["tests/materials/journey.py", root, String(engineering), id], { encoding: "utf8", env: { ...process.env, PYTHONPATH: resolve(".") } });
        expect(output.status, output.stderr).toBe(0);
        const receipt = JSON.parse(output.stdout);
        expect(receipt).toMatchObject({ jobId: id, pages: [2, 1], state: "preparation_only", repeatSame: true });
        for (const sql of receipt.queueSql) {
            await h.db.prepare(sql).run();
        }
        expect(await h.db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(id).first()).toEqual({ application_status: "materials_ready" });
        const manualBody = new URLSearchParams({ command: "/job", text: "https://job-boards.greenhouse.io/example-automation/jobs/102", team_id: "TSYNTHETIC", trigger_id: "synthetic-manual", user_id: instance.slack.allowedUserId, channel_id: instance.slack.channelId, response_url: "https://hooks.slack.com/commands/synthetic" }).toString();
        for (let n = 0; n < 2; n++) {
            expect((await worker.fetch(signed("/slack/commands", manualBody), env, ctx)).status).toBe(200);
            await Promise.all(waits.splice(0));
        }
        expect(await h.db.prepare("SELECT COUNT(*) AS n FROM manual_intake_requests").first()).toEqual({ n: 1 });
        const intake = launched[0];
        expect(intake).toBeTruthy();
        await new ManualIntakeWorkflow({} as any, env).run({ instanceId: intake.id, payload: intake.params } as any, step as any);
        await new ManualIntakeWorkflow({} as any, env).run({ instanceId: intake.id, payload: intake.params } as any, step as any);
        expect(await h.db.prepare("SELECT application_status,discovery_source FROM jobs WHERE id LIKE '%:102'").first()).toEqual({ application_status: "needs_materials", discovery_source: "manual_add" });
        expect(await h.db.prepare("SELECT state FROM manual_intake_requests").first()).toEqual({ state: "delivered" });
        mail = ["confirmation"];
        await new LifecycleWorkflow({} as any, env).run({ instanceId: "mail-retry", payload: {} } as any, step as any);
        expect(await h.db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(id).first()).toEqual({ application_status: "materials_ready" });
        await new LifecycleWorkflow({} as any, env).run({ instanceId: "mail-confirmation", payload: {} } as any, step as any);
        expect(await h.db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(id).first()).toEqual({ application_status: "applied" });
        mail = ["invite", "logistics"];
        await new LifecycleWorkflow({} as any, env).run({ instanceId: "mail-interview", payload: {} } as any, step as any);
        expect(await h.db.prepare("SELECT COUNT(*) AS n FROM interview_rounds").first()).toEqual({ n: 1 });
        expect(await h.db.prepare("SELECT scheduled_for FROM interview_rounds").first()).toEqual({ scheduled_for: "2026-10-09T16:00:00Z" });
        expect(JSON.stringify(slack)).toContain(engineering ? "12:00 PM EDT" : "11:00 AM CDT");
        mail = ["rejection"];
        await new LifecycleWorkflow({} as any, env).run({ instanceId: "mail-rejection", payload: {} } as any, step as any);
        expect(await h.db.prepare("SELECT application_status FROM jobs WHERE id=?").bind(id).first()).toEqual({ application_status: "closed" });
        const attempts = classificationAttempts;
        await new LifecycleWorkflow({} as any, env).run({ instanceId: "mail-duplicate", payload: {} } as any, step as any);
        expect(classificationAttempts).toBe(attempts);
        expect(await h.db.prepare("SELECT COUNT(*) AS n FROM lifecycle_receipts").first()).toEqual({ n: 4 });
        expect(JSON.stringify(await h.db.prepare("SELECT * FROM lifecycle_receipts").all())).not.toContain("SYNTHETIC-PRIVATE-BODY");
        expect(slack.length).toBeGreaterThan(2);
        expect(logs.some(value => value.event === "model_attempt" && value.outcome === "valid")).toBe(true);
    }
    finally {
        logger.mockRestore();
        vi.unstubAllGlobals();
        await h.dispose();
        if (!process.env.KEEP_JOURNEY_ARTIFACTS)
            await rm(root, { recursive: true, force: true });
        else
            console.log(JSON.stringify({ syntheticJourneyArtifacts: root }));
    }
}, 60000);
