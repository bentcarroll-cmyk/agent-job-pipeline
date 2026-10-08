import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDatabase, loadSchema } from "./harness";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } } }));
import { LifecycleWorkflow } from "../../src/lifecycle/workflow";
import { getCheckpoint, getReceipt, saveReceipt, setCheckpoint, savePromotedReceipt } from "../../src/lifecycle/db";
import { answerQuestion, decideAndRecord, undoChange } from "../../src/lifecycle/record";
import { parseClassification } from "../../src/lifecycle/classify";
import { CHICAGO_OPERATIONS } from "../fixtures/candidates";
let db: D1Database; let dispose: () => Promise<void>;
const PRIVATE = "SYNTHETIC-PRIVATE-EMAIL-BODY";
const SECRET = "SYNTHETIC-SECRET-REFRESH";
let logs: unknown[];
let outputs: unknown[]; let failures: string[]; let slack: unknown[]; let queries: string[]; let reads: string[];
const step = { do: async (_name: string, ...args: unknown[]) => {
  try { const result = await (args.at(-1) as () => Promise<unknown>)(); outputs.push(result); return result; }
  catch (e) { failures.push((e as Error).message); throw new Error((e as Error).message); }
}, sleep: async () => {} };
const instance = () => { const i = JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8")); i.lifecycle.enabled = true; i.lifecycle.since = "2026-02-01"; i.schedule.lifecycleLocalTime = "10:00"; return i; };
const bindings = (mode = "live", selected = instance()) => ({ DB: db, CANDIDATE_CONFIG: JSON.stringify(CHICAGO_OPERATIONS), INSTANCE_CONFIG: JSON.stringify(selected),
  LIFECYCLE_MODE: mode, LIFECYCLE_SINCE: "1990-01-01", SLACK_BOT_TOKEN: SECRET, SLACK_CHANNEL_ID: "CEXAMPLE123", AI_GATEWAY_ID: "synthetic",
  GMAIL_CLIENT_ID: "SYNTHETIC-CLIENT", GMAIL_CLIENT_SECRET: SECRET, GMAIL_REFRESH_TOKEN: SECRET,
  AI: { run: vi.fn().mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"event":"application_confirmation","employer":"Synthetic Works","title":"Operations"}' } }] } }] }) } });
function provider(fail: "auth" | "classify-auth" | "token-auth" | "network" | null = null) {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      if (fail === "token-auth" && reads.includes("first:full")) return Response.json({ error: "invalid_grant", error_description: PRIVATE + SECRET }, { status: 400 });
      return Response.json({ access_token: "SYNTHETIC-ACCESS" });
    }
    if (url.hostname === "slack.com") { slack.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: "123.4" }); }
    if (url.pathname.endsWith("/messages")) { queries.push(url.searchParams.get("q")!); return Response.json({ messages: [{ id: "first", threadId: "thread-first" }, { id: "second", threadId: "thread-second" }] }); }
    const id = url.pathname.split("/").at(-1)!; reads.push(`${id}:${url.searchParams.get("format")}`);
    if (id === "second" && fail && fail !== "token-auth" && (fail !== "classify-auth" || url.searchParams.get("format") === "full")) {
      if (fail === "auth" || fail === "classify-auth") return new Response(PRIVATE + SECRET, { status: 401 });
      throw new Error(PRIVATE + SECRET);
    }
    return Response.json({ id, threadId: `thread-${id}`, internalDate: String(Date.parse(id === "first" ? "2026-02-02T12:00:00Z" : "2026-02-03T12:00:00Z")), payload: {
      mimeType: "text/plain", headers: [{ name: "From", value: "careers@syntheticworks.test" }, { name: "Subject", value: "Application received" }],
      ...(url.searchParams.get("format") === "full" ? { body: { data: Buffer.from(PRIVATE).toString("base64url") } } : {}),
    } });
  }));
}
async function run(env = bindings(), id = "synthetic-run") { return new LifecycleWorkflow({} as any, env as any).run({ instanceId: id, payload: {} } as any, step as any); }
beforeEach(async () => { ({ db, dispose } = await createDatabase()); await loadSchema(db, "root"); outputs = []; failures = []; slack = []; queries = []; reads = []; logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args); });
  vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args); }); });
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await dispose(); });
describe("lifecycle interrupted batch recovery", () => {
  it("rolls back an owner insert and captured receipt when a later batch write fails", async () => {
    const email = { id: "batch-rollback", threadId: "batch-rollback", from: "hiring@synthetic.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "application_confirmation", employer: "Synthetic Works", title: "Operations" });
    await decideAndRecord(db, { id: email.id, email, ok: true, c }, false, email.date);
    const preview = (await getReceipt(db, email.id))!;
    await expect(savePromotedReceipt(db, { ...preview, test: 0, owner_table: "known_applications" }, { ownerInsertIndex: 0, statements: [
      db.prepare("INSERT INTO known_applications (id,employer,title,status,source) VALUES (43,'Synthetic Works','Operations','applied','synthetic')"),
      db.prepare("INSERT INTO known_applications (id,employer,title,status,source) VALUES (43,'Conflicting','Other','applied','synthetic')"),
    ] })).rejects.toThrow(/UNIQUE constraint/);
    expect(await getReceipt(db, email.id)).toEqual(preview);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications WHERE id=43").first()).toEqual({ n: 0 });
  });
  it("retains ordinary live Slack answer and undo behavior", async () => {
    provider(); await db.prepare("INSERT INTO known_applications (id, employer, title, status, source) VALUES (1,'Synthetic Works','Operations','packet_ready','synthetic'), (2,'Synthetic Works','Operations','packet_ready','synthetic')").run();
    const email = { id: "ambiguous", threadId: "ambiguous", from: "careers@syntheticworks.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "application_confirmation", employer: "Synthetic Works", title: "Operations" });
    expect(await decideAndRecord(db, { id: email.id, email, ok: true, c }, true, email.date)).toBe("question");
    await answerQuestion(bindings() as any, email.id, "1", { channelId: "CEXAMPLE123", messageTs: "123.4" });
    expect(await getReceipt(db, email.id)).toMatchObject({ decision: "answered", test: 0, owner_id: "1" });
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "applied" });
    await undoChange(bindings() as any, email.id, { channelId: "CEXAMPLE123", messageTs: "123.4", blocks: [], text: "Synthetic decision" });
    expect(await getReceipt(db, email.id)).toMatchObject({ decision: "ignored", test: 0 });
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "packet_ready" });
  });

  it("keeps a competing live retry budget when promotion loses preview eligibility", async () => {
    const email = { id: "retry-race", threadId: "retry-race", from: "hiring@synthetic.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "not_job_related" });
    await decideAndRecord(db, { id: email.id, email, ok: true, c }, false, email.date);
    const preview = (await getReceipt(db, email.id))!;
    const winner = { ...preview, test: 0, decision: "retry", attempts: 2 };
    const racedDb = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      await saveReceipt(db, winner); return db.batch(statements);
    } } as D1Database;
    expect(await decideAndRecord(racedDb, { id: email.id, email, ok: true, c }, true, email.date)).toBe("retry");
    expect(await getReceipt(db, email.id)).toEqual(winner);
  });
  it("fails closed and rolls back ledger changes if the preview receipt disappears", async () => {
    await db.prepare("INSERT INTO known_applications (id, employer, title, status, source) VALUES (1,'Synthetic Works','Operations','applied','synthetic')").run();
    const email = { id: "deleted-preview", threadId: "deleted-preview", from: "careers@syntheticworks.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    await decideAndRecord(db, { id: email.id, email, ok: true, c: parseClassification({ event: "not_job_related" }) }, false, email.date);
    const racedDb = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      await db.prepare("DELETE FROM lifecycle_receipts WHERE gmail_message_id=?").bind(email.id).run(); return db.batch(statements);
    } } as D1Database;
    await expect(decideAndRecord(racedDb, { id: email.id, email, ok: true, c: parseClassification({ event: "rejection", employer: "Synthetic Works", title: "Operations" }) }, true, email.date)).rejects.toThrow("lost eligibility");
    expect(await getReceipt(db, email.id)).toBeNull();
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "applied" });
  });
  it("captures the application owner before a later insert changes the connection's row ID", async () => {
    const email = { id: "owner-capture", threadId: "owner-capture", from: "careers@syntheticworks.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "application_confirmation", employer: "Synthetic Works", title: "Operations" });
    await decideAndRecord(db, { id: email.id, email, ok: true, c }, false, email.date);
    const preview = (await getReceipt(db, email.id))!;
    const saved = await savePromotedReceipt(db, { ...preview, test: 0, owner_table: "known_applications" }, {
      ownerInsertIndex: 0, statements: [
        db.prepare("INSERT INTO known_applications (id,employer,title,status,source) VALUES (42,'Synthetic Works','Operations','applied','synthetic')"),
        db.prepare("INSERT INTO interview_rounds (id,owner_table,owner_id,round,invited_at,gmail_thread_id,gmail_message_id,created_at) VALUES (900,'known_applications','42',1,'2026-02-02','other-thread','other-mail','2026-02-02')"),
      ],
    });
    expect(saved).toBe(true);
    const receipt = (await getReceipt(db, email.id))!;
    expect(receipt.owner_id).toBe("42"); expect(JSON.parse(receipt.change_json!).status.ownerId).toBe("42");
    expect(await db.prepare("SELECT id FROM interview_rounds").first()).toEqual({ id: 900 });
  });

  it("rolls back conflicting promotion ledger and interview writes when another live verdict wins", async () => {
    await db.prepare("INSERT INTO known_applications (id, employer, title, status, source, source_job_id) VALUES (1,'Synthetic Works','Operations','applied','codex_pipeline','SYNTHETIC-1')").run();
    const email = { id: "ledger-race", threadId: "ledger-race", from: "careers@syntheticworks.test", subject: "Next step", date: "2026-02-03T12:00:00Z" };
    await decideAndRecord(db, { id: email.id, email, ok: true, c: parseClassification({ event: "not_job_related" }) }, false, email.date);
    let injected = false;
    const racedDb = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      if (!injected) {
        injected = true;
        await decideAndRecord(db, { id: email.id, email, ok: true, c: parseClassification({ event: "interview_invitation", employer: "Synthetic Works", title: "Operations", round_stage: "recruiter_screen" }) }, true, "2026-02-04T12:00:00Z");
      }
      return db.batch(statements);
    } } as D1Database;
    const loser = parseClassification({ event: "rejection", employer: "Synthetic Works", title: "Operations" });
    expect(await decideAndRecord(racedDb, { id: email.id, email, ok: true, c: loser }, true, "2026-02-05T12:00:00Z")).toBe("applied");
    expect(injected).toBe(true);
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "interviewing" });
    expect(await getReceipt(db, email.id)).toMatchObject({ event: "interview_invitation", decision: "applied", test: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM interview_rounds").first()).toEqual({ n: 1 });
  });
  it("atomically resolves the actual application owner when a preview confirmation is reclassified live", async () => {
    provider(); await run(bindings("test"), "preview-confirmation");
    await run(bindings(), "live-confirmation");
    const owner = await db.prepare("SELECT id,status FROM known_applications").first<{id:number;status:string}>();
    expect(owner).toMatchObject({ status: "applied" });
    const receipt = (await getReceipt(db, "first"))!;
    expect(receipt).toMatchObject({ test: 0, owner_table: "known_applications", owner_id: String(owner!.id) });
    expect(JSON.parse(receipt.change_json!).status.ownerId).toBe(String(owner!.id));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 1 });
  });

  it("reclassifies old preview receipts in live mode even beyond a legacy advanced checkpoint", async () => {
    provider(); await run(bindings("test"), "preview-run");
    const preview = await getReceipt(db, "first"); expect(preview).toMatchObject({ decision: "applied", test: 1 });
    await setCheckpoint(db, "2026-10-01T00:00:00Z");
    const fakeProvider = fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/messages")) return Response.json({ messages: [] });
      return fakeProvider(input, init);
    });
    const env = bindings(); env.AI.run.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"event":"not_job_related"}' } }] } }] });
    reads = []; await run(env, "live-after-preview");
    expect(reads).toContain("first:full"); expect(env.AI.run).toHaveBeenCalledTimes(2);
    expect(await getReceipt(db, "first")).toMatchObject({ decision: "not_job", test: 0, created_at: preview!.created_at });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 0 });
    const liveReceipt = await getReceipt(db, "first");
    await run(bindings("test"), "preview-after-live"); await run(bindings(), "live-dedupe");
    expect(await getReceipt(db, "first")).toEqual(liveReceipt);
  });
  it("rechecks current user status when live reclassifies a preview", async () => {
    await db.prepare("INSERT INTO known_applications (id, employer, title, status, source, source_job_id) VALUES (1,'Synthetic Works','Operations','packet_ready','codex_pipeline','SYNTHETIC-1')").run();
    provider(); await run(bindings("test"), "preview-before-user-action");
    await db.prepare("UPDATE known_applications SET status='passed' WHERE id=1").run();
    await run(bindings(), "live-after-user-action");
    expect(await getReceipt(db, "first")).toMatchObject({ decision: "unchanged", test: 0 });
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "passed" });
  });
  it("gives live attempts a fresh retry budget after exhausted preview attempts", async () => {
    const email = { id: "preview-failed", threadId: "preview-failed", from: "hiring@synthetic.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const item = { id: email.id, email, ok: false as const, error: "safe failure" };
    for (let attempt = 0; attempt < 3; attempt++) await decideAndRecord(db, item, false, email.date);
    expect(await getReceipt(db, email.id)).toMatchObject({ decision: "failed", attempts: 3, test: 1 });
    expect(await decideAndRecord(db, item, true, "2026-02-04T12:00:00Z")).toBe("retry");
    expect(await getReceipt(db, email.id)).toMatchObject({ decision: "retry", attempts: 1, test: 0, created_at: email.date });
  });
  it("protects a settled live receipt that wins between the preview read and promotion write", async () => {
    const email = { id: "promotion-race", threadId: "promotion-race", from: "hiring@synthetic.test", subject: "Receipt", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "not_job_related" });
    await decideAndRecord(db, { id: email.id, email, ok: true, c }, false, email.date);
    const preview = (await getReceipt(db, email.id))!;
    const winner = { ...preview, test: 0, decision: "applied", event: "application_confirmation", updated_at: "2026-02-03T12:00:00Z" };
    let injected = false;
    const racedDb = { prepare: db.prepare.bind(db), async batch(statements: D1PreparedStatement[]) {
      if (!injected) { injected = true; await saveReceipt(db, winner); }
      return db.batch(statements);
    } } as D1Database;
    expect(await decideAndRecord(racedDb, { id: email.id, email, ok: true, c }, true, "2026-02-04T12:00:00Z")).toBe("applied");
    expect(await getReceipt(db, email.id)).toEqual(winner);
    await saveReceipt(db, { ...preview, updated_at: "2026-02-05T12:00:00Z" });
    expect(await getReceipt(db, email.id)).toEqual(winner);
  });

  it("does not persist Slack failure response content in durable step errors", async () => {
    provider(); const fakeProvider = fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("slack.com")) return new Response(PRIVATE + SECRET, { status: 500 });
      return fakeProvider(input, init);
    });
    await expect(run()).rejects.toThrow("Failure alert failed");
    expect(JSON.stringify([outputs, failures])).not.toMatch(new RegExp(`${PRIVATE}|${SECRET}`));
    expect(await getReceipt(db, "first")).not.toBeNull();
  });

  it("keeps classification retries recoverable after a completed checkpoint and redacts model errors", async () => {
    provider(); const env = bindings(); env.AI.run.mockRejectedValueOnce(new Error(PRIVATE + SECRET));
    await run(env);
    expect(await getReceipt(db, "first")).toMatchObject({ decision: "retry", attempts: 1 });
    expect(await getCheckpoint(db)).not.toBeNull();
    expect(JSON.stringify([outputs, failures, slack])).not.toMatch(new RegExp(`${PRIVATE}|${SECRET}`));
    provider(); await run(bindings(), "classification-retry");
    expect(await getReceipt(db, "first")).toMatchObject({ decision: "unchanged", attempts: 1 });
  });
  it("matches a receipt to a prepared application and treats interview logistics as scheduling, not a new round", async () => {
    await db.prepare("INSERT INTO known_applications (id, employer, title, status, source, source_job_id) VALUES (1,'Synthetic Works','Operations','packet_ready','codex_pipeline','SYNTHETIC-1')").run();
    const email = { id: "confirm", threadId: "confirmed", from: "careers@syntheticworks.test", subject: "Application received", date: "2026-02-02T12:00:00Z" };
    const c = parseClassification({ event: "application_confirmation", employer: "Synthetic Works", title: "Operations" });
    expect(await decideAndRecord(db, { id: email.id, email, ok: true, c }, true, email.date)).toBe("applied");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "applied" });
    const invite = { ...email, id: "invite", threadId: "interview-thread", subject: "Next step", date: "2026-02-03T12:00:00Z" };
    await decideAndRecord(db, { id: invite.id, email: invite, ok: true, c: { ...c, event: "interview_invitation", roundStage: "recruiter_screen" } }, true, invite.date);
    const logistics = { ...invite, id: "logistics", subject: "Confirmed", date: "2026-02-04T12:00:00Z" };
    expect(await decideAndRecord(db, { id: logistics.id, email: logistics, ok: true, c: { ...c, event: "interview_logistics", scheduledFor: "2026-02-10T10:00:00-06:00" } }, true, logistics.date)).toBe("scheduled");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM interview_rounds").first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT status FROM known_applications WHERE id=1").first()).toEqual({ status: "interviewing" });
    const forged = { ...logistics, id: "forged", threadId: "unrelated", from: "calendar-notification@evil.test", subject: "Invitation: Synthetic Works" };
    expect(await decideAndRecord(db, { id: forged.id, email: forged, ok: true, c: { ...c, event: "interview_logistics", scheduledFor: "2026-02-11T10:00:00-06:00" } }, true, forged.date)).toBe("ignored");
    expect(await db.prepare("SELECT scheduled_for FROM interview_rounds").first()).toEqual({ scheduled_for: "2026-02-10T10:00:00-06:00" });
  });

  it.each(["auth", "classify-auth", "token-auth"] as const)("retains completed receipts and checkpoints only completed catch-up on %s", async fail => {
    await setCheckpoint(db, "2026-02-02T00:00:00Z"); provider(fail);
    await expect(run()).rejects.toThrow(/sign-in|authorization/i);
    expect(await getReceipt(db, "first")).toMatchObject({ decision: "applied", test: 0 });
    expect(await getReceipt(db, "second")).toBeNull();
    expect(await getCheckpoint(db)).toBe("2026-02-02T00:00:00Z");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 1 });
    const persisted = JSON.stringify([logs, outputs, failures, slack, (await db.prepare("SELECT * FROM lifecycle_receipts").all()).results, (await db.prepare("SELECT * FROM pipeline_runs").all()).results]);
    expect(persisted).not.toContain(PRIVATE); expect(persisted).not.toContain(SECRET); expect(persisted).not.toContain("SYNTHETIC-ACCESS");
    expect(JSON.stringify(slack)).toMatch(/selected instance|--instance/);
    expect(JSON.stringify(slack)).not.toContain("before reading anything");
    expect(queries[0]).toContain(`after:${Date.parse("2026-02-01T00:00:00Z") / 1000}`);
    reads = []; provider(); await run(bindings(), "recovery-run");
    expect(reads).not.toContain("first:full"); expect(reads).toContain("second:full");
    expect(await getReceipt(db, "second")).toMatchObject({ decision: "unchanged" });
    expect(await getCheckpoint(db)).not.toBe("2026-02-02T00:00:00Z");
  });
  it("redacts arbitrary provider/network failure text and retains completed work", async () => {
    provider("network"); await expect(run()).rejects.toThrow("Application tracker run failed");
    expect(await getReceipt(db, "first")).not.toBeNull(); expect(await getCheckpoint(db)).toBeNull();
    expect(JSON.stringify([outputs, failures, slack])).not.toMatch(new RegExp(`${PRIVATE}|${SECRET}`));
  });
  it("auth failure before search returns only redacted status and never advances checkpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("oauth2")) return Response.json({ error: "invalid_grant", error_description: PRIVATE + SECRET }, { status: 400 });
      slack.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
    }));
    const result = await run(); expect(result).toMatchObject({ error: expect.stringMatching(/sign-in/) });
    expect(JSON.stringify([result, outputs, failures, slack])).not.toMatch(new RegExp(`${PRIVATE}|${SECRET}`));
    expect(await getCheckpoint(db)).toBeNull();
  });
  it.each(["test", "unexpected"])("%s records test receipts without changing the application ledger", async mode => {
    provider(); await run(bindings(mode));
    expect(await getReceipt(db, "first")).toMatchObject({ test: 1 });
    expect(await getCheckpoint(db)).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM known_applications").first()).toEqual({ n: 0 });
    expect(JSON.stringify(outputs)).not.toContain(PRIVATE);
  });
  it.each(["off", "disabled"])("%s avoids Gmail and receipt work after immutable config admission", async mode => {
    const i = instance(); if (mode === "disabled") i.lifecycle.enabled = false;
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await run(bindings(mode === "disabled" ? "live" : mode, i))).toEqual({ skipped: "off" });
    expect(fetcher).not.toHaveBeenCalled(); expect(outputs).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM candidate_run_configs").first()).toEqual({ n: 1 });
  });
});

it.each(["rejection","application_confirmation"] as const)("keeps conflicting requisition %s reviewable at the record boundary",async event=>{
 await db.prepare("INSERT INTO known_applications (id,employer,title,status,source,requisition_id) VALUES (1,'Synthetic Works','Director of Strategy Operations','applied','synthetic','SYN-100')").run();
 const email={id:"conflict",threadId:"conflict",from:"careers@synthetic.test",subject:"Synthetic outcome",date:"2026-02-02T12:00:00Z"};
 const c=parseClassification({event,employer:"Synthetic Works",title:"Strategy Operations Director",requisition_id:"SYN-200"});
 await decideAndRecord(db,{id:email.id,email,ok:true,c},true,email.date);
 expect(await db.prepare("SELECT status,applied_at,status_updated_at FROM known_applications WHERE id=1").first()).toEqual({status:"applied",applied_at:null,status_updated_at:null});
 expect(await getReceipt(db,email.id)).toMatchObject({decision:"question",owner_id:null});
});

it('preserves persisted lifecycle status and unknown timing across conflicting Workday sites',async()=>{
 const {readLedger,executeStatements}=await import('../../src/lifecycle/db');
 const {buildPlan}=await import('../../src/ledger/import/plan');
 const {planStatements}=await import('../../src/ledger/import/sql');
 await db.prepare("INSERT INTO known_applications (id,employer,title,status,source,source_job_id,posting_url) VALUES (1,'Synthetic Works','Operations Director','applied','codex_pipeline','fixture-old',?)").bind('https://synthetic.wd1.myworkdayjobs.com/External/job/Test/Operations_R-100').run();
 const plan=buildPlan({existing:await readLedger(db),candidates:[{source:'codex_pipeline',sourceJobId:'fixture-new',employer:'Synthetic Works',title:'Operations Director',status:'closed',statusAt:'2026-01-10',appliedAt:'2026-01-01',postingUrl:'https://synthetic.wd1.myworkdayjobs.com/Internal/job/Test/Operations_R-100',requisitionId:null,mergeInto:null,evidence:'Synthetic conflicting site'}],evidence:[],questions:[],answers:{},generatedAt:'2026-01-11'});
 await executeStatements(db,planStatements(plan));
 expect(await db.prepare('SELECT status,applied_at,status_updated_at FROM known_applications WHERE id=1').first()).toEqual({status:'applied',applied_at:null,status_updated_at:null});
 expect(plan.questions).toHaveLength(1);
});
