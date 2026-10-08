import {mkdtemp, mkdir, rm, realpath, writeFile, symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import * as os from "node:os";
vi.mock("node:os", async (original) => {const actual=await original<typeof import("node:os")>();return {...actual,homedir:vi.fn(actual.homedir)};});
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, statSync } from "node:fs";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
vi.mock("node:child_process", async (original) => ({...await original<typeof import("node:child_process")>(), spawn: vi.fn()}));
import { buildLifecyclePrompt, classifyEmail, parseClassification } from "../../src/lifecycle/classify";
import { publicPage } from "../../src/lifecycle/public-pages";
import { getAccessToken, getMessage, listMessageIds, GmailAuthError } from "../../src/lifecycle/gmail-client";
import { parseInstanceConfig } from "../../src/config/instance";
import { loadRuntimeConfig } from "../../src/config/candidate";
import { CHICAGO_OPERATIONS } from "../fixtures/candidates";
import { toEvidence } from "../../src/lifecycle/evidence";
import { roundForInvite } from "../../src/lifecycle/decide";
const raw = () => JSON.parse(readFileSync(new URL("../../examples/instance.json", import.meta.url), "utf8"));
const email = { id: "synthetic-mail", threadId: "thread", from: "hiring@example.com", subject: "Application", date: "2026-01-03T12:00:00Z", text: "SYNTHETIC-PRIVATE-SYNTHETIC-BODY" };
const creds = { GMAIL_CLIENT_ID: "SECRET-ID", GMAIL_CLIENT_SECRET: "SECRET-CLIENT", GMAIL_REFRESH_TOKEN: "SECRET-REFRESH" };
afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();});
describe("lifecycle instance identity and privacy", () => {
  it("builds a candidate prompt with quoted inert identity and receipt/logistics safeguards", () => {
    const prompt = buildLifecyclePrompt('Alex "Example"\n<test>');
    expect(prompt).toContain(JSON.stringify('Alex "Example"\n<test>'));
    expect(prompt).toContain("interview_logistics");
    expect(prompt).toContain("NOT an account registration");
    expect(prompt).not.toContain("his job");
    expect(() => buildLifecyclePrompt("")).toThrow(/displayName/);
  });
  it("classifies using approved candidate identity and disables gateway logging and caching", async () => {
    const run = vi.fn().mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"event":"not_job_related"}' } }] } }] });
    await classifyEmail({ AI: { run }, AI_GATEWAY_ID: "selected-gateway", runtime: await loadRuntimeConfig(CHICAGO_OPERATIONS) } as any, email);
    const [_model, input, options] = run.mock.calls[0];
    expect(input.messages[0].content).toContain('"Alex Example"');
    expect(input.tools[0].function.description).toBe("Record what this email means for the candidate's job applications");
    expect(input.messages[1].content).toContain(email.text);
    expect(options.gateway).toMatchObject({ id: "selected-gateway", collectLog: false, skipCache: true });
  });
  it("redacts AI errors and malformed model output", async () => {
    const env = { AI: { run: vi.fn().mockRejectedValue(new Error(email.text + creds.GMAIL_REFRESH_TOKEN)) }, runtime: await loadRuntimeConfig(CHICAGO_OPERATIONS) } as any;
    await expect(classifyEmail(env, email)).rejects.toThrow("Email classification failed");
    env.AI.run.mockResolvedValue({ choices: [{ message: { tool_calls: [{ function: { arguments: { event: email.text } } }] } }] });
    await expect(classifyEmail(env, email)).rejects.toThrow("Email classification failed");
  });
  it("renders operator identity and escapes HTML and contact links", async () => {
    const input = raw(); input.operator = { displayName: 'Operator <script> & "quoted"', contactEmail: 'o"&<@example.com' };
    const instance = parseInstanceConfig(input);
    for (const path of ["/", "/privacy"]) {
      const html = await publicPage(new Request(`https://example.test${path}`), instance)!.text();
      expect(html).toContain("Operator &lt;script&gt; &amp; &quot;quoted&quot;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("Alex Example");
      expect(html).not.toContain("only user");
      if (path === "/privacy") {
        expect(html).toContain('href="mailto:o%22%26%3C%40example.com"');
        expect(html).toContain("read-only");
        expect(html).toContain("6,000");
        expect(html).toContain("never stored");
      }
    }
  });
  it("handles HEAD and unrecognized methods/paths", async () => {
    const instance = parseInstanceConfig(raw());
    const head = publicPage(new Request("https://example.test/privacy", { method: "HEAD" }), instance)!;
    expect(await head.text()).toBe(""); expect(head.headers.get("content-type")).toContain("text/html");
    expect(publicPage(new Request("https://example.test/privacy", { method: "POST" }), instance)).toBeNull();
    expect(publicPage(new Request("https://example.test/other"), instance)).toBeNull();
  });
  it.each([401, 403])("treats Gmail HTTP %s as recoverable authorization, without response content", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(email.text + creds.GMAIL_REFRESH_TOKEN, { status }));
    await expect(listMessageIds("secret-access", "synthetic", fetcher)).rejects.toBeInstanceOf(GmailAuthError);
    await expect(getMessage("secret-access", "id", "full", fetcher)).rejects.toBeInstanceOf(GmailAuthError);
  });
  it("never copies token endpoint or Gmail failure content into errors", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: email.text + creds.GMAIL_CLIENT_SECRET }, { status: 500 }));
    await expect(getAccessToken(creds, fetcher)).rejects.toThrow("Google token exchange HTTP 500");
    await expect(listMessageIds("token", "query", fetcher)).rejects.toThrow("Gmail messages.list HTTP 500");
    const network = vi.fn().mockRejectedValue(new Error(creds.GMAIL_REFRESH_TOKEN));
    await expect(getAccessToken(creds, network)).rejects.toThrow("Google token exchange failed");
  });
  it("requires a valid access token and retains revoked-grant recovery", async () => {
    await expect(getAccessToken(creds, vi.fn().mockResolvedValue(Response.json({})))).rejects.toThrow(/token exchange/);
    await expect(getAccessToken(creds, vi.fn().mockResolvedValue(Response.json({ error: "invalid_grant", error_description: creds.GMAIL_REFRESH_TOKEN }, { status: 400 })))).rejects.toBeInstanceOf(GmailAuthError);
  });
  it("preserves logistics distinctions and Indeed sender matching", () => {
    const logistics = parseClassification({ event: "interview_logistics", employer: "Synthetic Co" });
    expect(toEvidence(email, logistics, [])).toEqual({ kind: "ignore", reason: "logistics" });
    const c = parseClassification({ event: "application_confirmation", title: "Operations", employer: null });
    expect(toEvidence({ ...email, from: "indeedapply@indeed.com" }, c, [])).toMatchObject({ kind: "fyi" });
    expect(roundForInvite([], [], { from: "newsletter@evil.test", subject: "Invitation: Synthetic" }, "Synthetic Co")).toBeNull();
  });
});

describe("isolated Gmail auth setup interface", () => {
  it("pipes secrets to the real writer's isolated selected-account config and ignores subprocess output", async () => {
    const uploads: Array<{ args: string[]; options: any; config: any; mode: number; input: string }> = [];
    vi.mocked(childProcess.spawn).mockImplementation((_command, args, options) => {
      const child = new EventEmitter() as any;
      child.stdin = new EventEmitter();
      child.stdin.end = (input: string) => {
        const argv = args as string[]; const configPath = argv[argv.indexOf("--config") + 1];
        uploads.push({ args: argv, options, config: JSON.parse(readFileSync(configPath, "utf8")), mode: statSync(configPath).mode & 0o777, input });
        queueMicrotask(() => child.emit("close", 0));
      };
      return child;
    });
    const { authorizeAndStore, GMAIL_SCOPE } = await import("../../tools/gmail-auth/auth.mjs");
    const selected = raw(); selected.cloudflare.accountId = "a".repeat(32); selected.cloudflare.unboundedWorkerName = "selected-lifecycle";
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "gmail-writer-test-")));
    await mkdir(join(workspace, ".setup"), {mode: 0o700});
    await mkdir(join(workspace, ".setup/dependencies/node_modules/wrangler/bin"), {recursive:true});
    await writeFile(join(workspace, ".setup/dependencies/node_modules/wrangler/bin/wrangler.js"), "synthetic intercepted executable");
    vi.stubEnv("AMBIENT_TEST_SECRET", "UNRELATED-SENTINEL");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "AMBIENT-TOKEN");
    vi.stubEnv("CLOUDFLARE_API_KEY", "AMBIENT-KEY");
    vi.stubEnv("WRANGLER_LOG_PATH", "/unrelated/global/logs");
    const status = await authorizeAndStore(selected, { installed: { client_id: "SYNTHETIC-PRIVATE-ID", client_secret: "SYNTHETIC-PRIVATE-CLIENT" } }, {
      authorize: async () => ({ refresh_token: "SYNTHETIC-PRIVATE-REFRESH", scope: GMAIL_SCOPE }), workspace, cloudflareApiToken: "SELECTED-AUTHORIZED-TOKEN",
    });
    expect(status).toMatchObject({ ok: true }); expect(uploads).toHaveLength(3);
    for (const upload of uploads) {
      expect(upload.config).toMatchObject({ name: "selected-lifecycle", account_id: "a".repeat(32) });
      expect(upload.args[0]).toBe(join(workspace, ".setup/dependencies/node_modules/wrangler/bin/wrangler.js"));
      expect(upload.mode).toBe(0o600); expect(upload.options.cwd).toMatch(/job-pipeline-gmail-secret-/);
      expect(upload.options.env.HOME).toBe(process.env.HOME);
      expect(upload.options.env.XDG_CONFIG_HOME).toBe(join(workspace,".setup/xdg"));
      expect(upload.options.env.XDG_CACHE_HOME).toBe(join(workspace,".setup/xdg-cache"));
      expect(upload.options.env.WRANGLER_LOG_PATH).toBe(join(workspace,".setup/wrangler-logs"));
      expect(upload.options.env.WRANGLER_CACHE_DIR).toBe(join(workspace,".setup/wrangler-cache"));
      expect(upload.options.env.TMPDIR).toBe(join(workspace,".setup/tmp"));
      expect(upload.options.env.CLOUDFLARE_API_TOKEN).toBe("SELECTED-AUTHORIZED-TOKEN");
      expect(upload.options.env.CLOUDFLARE_AUTH_USE_KEYRING).toBe("false");
      expect(upload.options.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("false");
      expect(upload.options.env.WRANGLER_SEND_METRICS).toBe("false");
      expect(upload.options.env.WRANGLER_SEND_ERROR_REPORTS).toBe("false");
      expect(upload.options.env).not.toHaveProperty("AMBIENT_TEST_SECRET");
      expect(upload.options.env).not.toHaveProperty("CLOUDFLARE_API_KEY");
      expect(upload.options.env.CLOUDFLARE_ACCOUNT_ID).toBe("a".repeat(32));
      expect(upload.options.stdio).toEqual(["pipe", "ignore", "ignore"]);
      expect(JSON.stringify(upload.args)).not.toContain("SYNTHETIC-PRIVATE-"); expect(JSON.stringify(upload.config)).not.toContain("SYNTHETIC-PRIVATE-");
    }
    expect(uploads.map(upload => upload.input)).toEqual(["SYNTHETIC-PRIVATE-ID\n", "SYNTHETIC-PRIVATE-CLIENT\n", "SYNTHETIC-PRIVATE-REFRESH\n"]);
    expect(JSON.stringify(status)).not.toContain("SYNTHETIC-PRIVATE-");
    await rm(workspace, {recursive: true, force: true});
  });
  it("returns redacted failure after a secret writer error and provides an inert usage command", async () => {
    const { authorizeAndStore, main, GMAIL_SCOPE } = await import("../../tools/gmail-auth/auth.mjs");
    const writeSecret = vi.fn().mockRejectedValue(new Error("SYNTHETIC-PRIVATE-REFRESH https://example.test/?state=SYNTHETIC-PRIVATE-STATE"));
    const result = await authorizeAndStore(raw(), { installed: { client_id: "SYNTHETIC-PRIVATE-ID", client_secret: "SYNTHETIC-PRIVATE-CLIENT" } }, {
      authorize: async () => ({ refresh_token: "SYNTHETIC-PRIVATE-REFRESH", scope: GMAIL_SCOPE }), writeSecret,
    });
    expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE-");
    expect(await main([])).toMatchObject({ ok: false, error: expect.stringContaining("--instance") });
  });

  it("uses read-only OAuth and selected instance secret store without returning credentials", async () => {
    const { authorizeAndStore, GMAIL_SCOPE } = await import("../../tools/gmail-auth/auth.mjs");
    expect(GMAIL_SCOPE).toBe("https://www.googleapis.com/auth/gmail.readonly");
    const instance = parseInstanceConfig(raw()); const writeSecret = vi.fn().mockResolvedValue(undefined);
    const result = await authorizeAndStore(instance, { installed: { client_id: creds.GMAIL_CLIENT_ID, client_secret: creds.GMAIL_CLIENT_SECRET } }, {
      authorize: vi.fn().mockResolvedValue({ refresh_token: creds.GMAIL_REFRESH_TOKEN, access_token: "SECRET-ACCESS", scope: GMAIL_SCOPE }), writeSecret,
    });
    expect(writeSecret.mock.calls.map(([target, name]) => ({ target, name }))).toEqual(
      ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].map(name => ({ target: { accountId: instance.cloudflare.accountId, workerName: instance.cloudflare.unboundedWorkerName }, name })),
    );
    const serialized = JSON.stringify(result); expect(serialized).not.toContain("SECRET-");
    expect(result).toEqual({ ok: true, instanceId: instance.instanceId, workerName: instance.cloudflare.unboundedWorkerName });
  });
  it("fails closed on invalid instance, write/provider errors and broader scopes with redacted status", async () => {
    const { authorizeAndStore, GMAIL_SCOPE } = await import("../../tools/gmail-auth/auth.mjs");
    const instance = raw(); const writeSecret = vi.fn(); const client = { installed: { client_id: "synthetic-id", client_secret: "synthetic-secret" } };
    const authorize = vi.fn().mockResolvedValue({ refresh_token: "SECRET-REFRESH", scope: GMAIL_SCOPE + " https://www.googleapis.com/auth/gmail.modify" });
    expect(await authorizeAndStore(instance, client, { authorize, writeSecret })).toMatchObject({ ok: false }); expect(writeSecret).not.toHaveBeenCalled();
    authorize.mockRejectedValue(new Error("SECRET-REFRESH"));
    expect(JSON.stringify(await authorizeAndStore(instance, client, { authorize, writeSecret }))).not.toContain("SECRET-");
    instance.cloudflare.databaseId = null; authorize.mockClear();
    expect(await authorizeAndStore(instance, client, { authorize, writeSecret })).toMatchObject({ ok: false }); expect(authorize).not.toHaveBeenCalled();
  });
});

it("Gmail CLI binds nested instance/client files to the explicit private workspace and rejects escaped paths before consent", async () => {
  const {main, GMAIL_SCOPE} = await import("../../tools/gmail-auth/auth.mjs");
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "gmail-selection-"))), outside = await realpath(await mkdtemp(join(tmpdir(), "gmail-outside-")));
  try {
    await mkdir(join(workspace,".setup"), {mode:0o700}); await mkdir(join(workspace,"nested"));
    await writeFile(join(workspace,"nested/instance.json"), JSON.stringify(raw()));
    await writeFile(join(workspace,"client.json"),JSON.stringify({installed:{client_id:"SYNTHETIC",client_secret:"SYNTHETIC"}}));
    const authorize = vi.fn().mockResolvedValue({refresh_token:"SYNTHETIC",scope:GMAIL_SCOPE}), writeSecret = vi.fn().mockResolvedValue(undefined);
    const args = ["--instance",join(workspace,"nested/instance.json"),"--client",join(workspace,"client.json"),"--workspace",workspace];
    expect(await main(args,{authorize,writeSecret})).toMatchObject({ok:true}); expect(writeSecret).toHaveBeenCalledTimes(3);
    authorize.mockClear(); writeSecret.mockClear();
    await writeFile(join(outside,"client.json"),JSON.stringify({installed:{client_id:"SYNTHETIC",client_secret:"SYNTHETIC"}}));
    await symlink(join(outside,"client.json"),join(workspace,"escaped.json")); args[3]=join(workspace,"escaped.json");
    expect(await main(args,{authorize,writeSecret})).toMatchObject({ok:false}); expect(authorize).not.toHaveBeenCalled(); expect(writeSecret).not.toHaveBeenCalled();
    const missing = vi.fn(); expect(await main(["--instance",join(workspace,"nested/instance.json"),"--client",join(workspace,"client.json")],{authorize:missing,writeSecret})).toMatchObject({ok:false}); expect(missing).not.toHaveBeenCalled();
  } finally {await rm(workspace,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
it("missing private Wrangler blocks Gmail consent before authorization", async () => {
  const {authorizeAndStore} = await import("../../tools/gmail-auth/auth.mjs"); const workspace = await realpath(await mkdtemp(join(tmpdir(),"gmail-missing-")));
  try { await mkdir(join(workspace,".setup"),{mode:0o700}); const authorize=vi.fn();
    expect(await authorizeAndStore(raw(),{installed:{client_id:"SYNTHETIC",client_secret:"SYNTHETIC"}},{workspace,authorize})).toMatchObject({ok:false}); expect(authorize).not.toHaveBeenCalled();
  } finally {await rm(workspace,{recursive:true,force:true});}
});

it.each(["legacy configuration", "missing explicit token", "legacy appears during consent"])("Gmail %s refuses before consent and secret subprocesses", async (reason) => {
  const {authorizeAndStore} = await import("../../tools/gmail-auth/auth.mjs");
  const workspace=await realpath(await mkdtemp(join(tmpdir(),"gmail-preconsent-"))), home=await realpath(await mkdtemp(join(tmpdir(),"gmail-home-")));
  try {
    await mkdir(join(workspace,".setup"),{mode:0o700});await mkdir(join(workspace,".setup/dependencies/node_modules/wrangler/bin"),{recursive:true});
    await writeFile(join(workspace,".setup/dependencies/node_modules/wrangler/bin/wrangler.js"),"intercepted executable");
    const authorize=vi.fn().mockResolvedValue({refresh_token:"SYNTHETIC",scope:"https://www.googleapis.com/auth/gmail.readonly"});
    const spawn=vi.mocked(childProcess.spawn);spawn.mockClear();
    if(reason !== "missing explicit token") vi.spyOn(os,"homedir").mockReturnValue(home);
    if(reason === "legacy configuration") await mkdir(join(home,".wrangler"));
    if(reason === "legacy appears during consent") authorize.mockImplementation(async () => {await mkdir(join(home,".wrangler"));return {refresh_token:"SYNTHETIC",scope:"https://www.googleapis.com/auth/gmail.readonly"};});
    const result=await authorizeAndStore(raw(),{installed:{client_id:"SYNTHETIC",client_secret:"SYNTHETIC"}},{workspace,authorize,...reason !== "missing explicit token" ? {cloudflareApiToken:"SELECTED-TOKEN"}: {}});
    expect(result).toMatchObject({ok:false});
    if(reason === "legacy appears during consent") expect(authorize).toHaveBeenCalledOnce(); else expect(authorize).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  } finally {await rm(workspace,{recursive:true,force:true});await rm(home,{recursive:true,force:true});}
});
