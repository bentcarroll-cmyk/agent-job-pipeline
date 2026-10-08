// Run with: node --import tsx tools/gmail-auth/auth.mjs --instance PATH --client PATH
// Credentials and authorization state stay in memory/stdin, never stdout or argv.
import { assertWorkspace, privatePath, isolatedWranglerEnvironment, atomicPrivateWrite } from "../setup/core-guards.mjs";
import { setupPath, validateSetupTree } from "../setup/state.ts";
import { parseInstanceConfig } from "../../src/config/instance.ts";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_FAILURE = { ok: false, error: "Gmail authorization or secret storage failed; verify the selected instance and private OAuth client, then retry." };

// Test/setup seam: only this function receives provider credentials. The result
// is a redacted status; injected secret sinks must not log their input.
export async function authorizeAndStore(rawInstance, clientJson, dependencies = {}) {
  try {
    const instance = parseInstanceConfig(rawInstance);
    const client = clientJson?.installed;
    if (typeof client?.client_id !== "string" || !client.client_id.trim() ||
        typeof client?.client_secret !== "string" || !client.client_secret.trim()) throw new Error("installed client required");
    const providerToken = dependencies.cloudflareApiToken;
    if (!dependencies.writeSecret) {
      if (!dependencies.workspace) throw new Error("Selected dependency workspace required");
      await validateSetupTree(dependencies.workspace);
      await access(await setupPath(dependencies.workspace, "dependencies/node_modules/wrangler/bin/wrangler.js"));
      // Capability and global-state isolation must pass before opening Google consent.
      await isolatedWranglerEnvironment(dependencies.workspace, providerToken);
    }
    const authorize = dependencies.authorize ?? authorizeLoopback;
    const writeSecret = dependencies.writeSecret ?? ((target, name, value) => writeWorkerSecret(target, name, value, dependencies.workspace, providerToken));
    const tokens = await authorize(client);
    if (typeof tokens?.refresh_token !== "string" || !tokens.refresh_token.trim() ||
        tokens.scope !== GMAIL_SCOPE) throw new Error("read-only grant required");
    const target = { accountId: instance.cloudflare.accountId, workerName: instance.cloudflare.unboundedWorkerName };
    // Each upload uses an isolated generated config, so Wrangler cannot discover
    // a source checkout's config/account/worker. Values go through stdin only.
    await writeSecret(target, "GMAIL_CLIENT_ID", client.client_id);
    await writeSecret(target, "GMAIL_CLIENT_SECRET", client.client_secret);
    await writeSecret(target, "GMAIL_REFRESH_TOKEN", tokens.refresh_token);
    return { ok: true, instanceId: instance.instanceId, workerName: target.workerName };
  } catch {
    return { ...AUTH_FAILURE };
  }
}

function childInput(command, args, input, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => fail(new Error("local subprocess failed")));
    child.stdin.on("error", () => fail(new Error("local subprocess input failed")));
    child.once("close", code => code === 0 ? done() : fail(new Error("local subprocess failed")));
    child.stdin.end(input);
  });
}

async function writeWorkerSecret(target, name, value, workspace, providerToken) {
  // Repeat refusal/path checks after consent and before every write.
  const environment = await isolatedWranglerEnvironment(workspace, providerToken);
  const root = await mkdtemp(join(environment.TMPDIR, "job-pipeline-gmail-secret-"));
  try {
    const config = join(root, "wrangler.json");
    await atomicPrivateWrite(workspace, config, JSON.stringify({ name: target.workerName, account_id: target.accountId, compatibility_date: "2026-09-01" }));
    if (!workspace) throw new Error("Selected private dependency workspace required");
    await validateSetupTree(workspace);
    const wrangler = await setupPath(workspace, "dependencies/node_modules/wrangler/bin/wrangler.js");
    await childInput(process.execPath, [wrangler, "secret", "put", name, "--config", config], value + "\n", {
      cwd: root, env: { ...environment, CLOUDFLARE_ACCOUNT_ID: target.accountId },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function authorizeLoopback(client) {
  if (process.platform !== "darwin") throw new Error("macOS browser handoff required");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let receiveCode, rejectCode, timer;
  const codePromise = new Promise((yes, no) => { receiveCode = yes; rejectCode = no; });
  // Attach a handler before opening the browser, so a timeout or rejection
  // cannot produce an unhandled rejection containing sensitive auth state.
  codePromise.catch(() => {});
  const server = createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { response.writeHead(400).end("Invalid authorization response."); return; }
    if (url.pathname !== "/oauth/callback") { response.writeHead(404).end(); return; }
    if (url.searchParams.get("state") !== state) { response.writeHead(400).end("Invalid authorization response."); return; }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      response.writeHead(400).end("Authorization declined. Retry locally."); rejectCode(new Error("authorization declined")); return;
    }
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Authorization received. Return to your terminal for secret storage status.");
    receiveCode(code);
  });
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    timer = setTimeout(() => rejectCode(new Error("authorization timed out")), 180_000);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", scope: GMAIL_SCOPE,
      access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
    // AppleScript is sent on stdin. The authorization URL/state never appear
    // in process arguments or terminal output. No callback request logging.
    await childInput("/usr/bin/osascript", [], `open location ${JSON.stringify(url.toString())}\n`);
    const code = await codePromise;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier,
        redirect_uri: redirect, grant_type: "authorization_code" }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("token exchange failed");
    return await response.json();
  } finally {
    clearTimeout(timer);
    await new Promise(done => server.close(done));
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const usage = "Usage: node --import tsx tools/gmail-auth/auth.mjs --instance <selected-instance.json> --client <private-installed-oauth-client.json> [--workspace <selected-workspace>]";
  if (![4, 6].includes(args.length) || (args.length === 6 && (args[4] !== "--workspace" || !args[5])) || args[0] !== "--instance" || args[2] !== "--client" || !args[1] || !args[3]) return { ok: false, error: usage };
  try {
    const release = fileURLToPath(new URL("../..", import.meta.url));
    const chosen = args.length === 6 ? args[5] : resolve(args[1], "..");
    const workspace = await assertWorkspace(chosen, [release, resolve(release, "../glm-agent-pipeline")]);
    await validateSetupTree(workspace);
    const instance = JSON.parse(await readFile(await privatePath(workspace, args[1]), "utf8"));
    const client = JSON.parse(await readFile(await privatePath(workspace, args[3]), "utf8"));
    return await authorizeAndStore(instance, client, {...dependencies, workspace, cloudflareApiToken: dependencies.cloudflareApiToken ?? process.env.CLOUDFLARE_API_TOKEN});
  } catch { return { ...AUTH_FAILURE }; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = await main();
  process.stdout.write(JSON.stringify(status) + "\n");
  if (!status.ok) process.exitCode = 1;
}
