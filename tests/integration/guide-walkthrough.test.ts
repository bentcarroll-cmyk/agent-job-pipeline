// Synthetic guide/adapter exercise only. No assistant session, login or live resources.
import {it, expect, afterEach} from "vitest";
import {mkdtemp, writeFile, readFile, rm} from "node:fs/promises";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {createDatabase} from "./harness";
import {createResourcePlan, FakeResourceAdapter, ensureResources, applySchema, localSetupDatabase, loadResourcePlan} from "../../tools/setup/resources";
import {activateReviewed, previewWorkspace, main} from "../../tools/setup/cli";
import {hashBytes, loadApprovedProfile} from "../../tools/setup/preflight";
import {renderConfig} from "../../tools/setup/render-config";
import {verifyGuides} from "../../scripts/verify-guides";
import {authorizeAndStore, GMAIL_SCOPE} from "../../tools/gmail-auth/auth.mjs";
import {CHICAGO_OPERATIONS, BOSTON_ENGINEERING} from "../fixtures/candidates";
const roots: string[] = [], dbs: Array<Awaited<ReturnType<typeof createDatabase>>> = [];
afterEach(async () => {for (const h of dbs.splice(0)) await h.dispose();for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true});});
it.each([["Codex", ".agents", CHICAGO_OPERATIONS], ["Claude", ".claude", BOSTON_ENGINEERING]] as const)("%s guide through fake adapter and local D1 is explicitly synthetic", async (assistant, directory, fixture) => {
  await verifyGuides();
  const adapter = await readFile(new URL(`../../${directory}/skills/job-materials/SKILL.md`, import.meta.url), "utf8");
  const canonical = resolve(directory, "skills/job-materials", "../../../skills/prepare-application/SKILL.md");
  expect(adapter).toContain("../../../skills/prepare-application/SKILL.md");
  expect(await readFile(canonical,"utf8")).toContain("Prepare or revise requested");
  if (assistant === "Claude") expect(await readFile(new URL("../../CLAUDE.md",import.meta.url),"utf8")).toContain("@AGENTS.md");
  const root = await mkdtemp(join(tmpdir(), "synthetic-guide-")); roots.push(root);
  const raw = JSON.parse(await readFile(new URL("../../examples/instance.draft.json",import.meta.url),"utf8"));
  const candidate = structuredClone(fixture), readable = `Synthetic criteria reviewed for ${assistant}; not human approval.\n`;
  candidate.approval.readableSha256 = hashBytes(readable);
  await writeFile(join(root,"candidate.json"),JSON.stringify(candidate)); await writeFile(join(root,"criteria.md"),readable);
  const runtime = await loadApprovedProfile(root), plan = await createResourcePlan(root,raw), fake = new FakeResourceAdapter(root,plan);
  const instance = await ensureResources(plan.instance,fake); await writeFile(join(root,"instance.json"),JSON.stringify(instance));
  const h = await createDatabase(); dbs.push(h); const db = localSetupDatabase(h.db);
  await applySchema(db,{instanceId:instance.instanceId,accountId:instance.cloudflare.accountId,databaseId:instance.cloudflare.databaseId},new URL("../..",import.meta.url).pathname);
  const builds: string[] = [];
  await previewWorkspace(root,instance,runtime,async (_root,_config,kind) => {builds.push(kind);});
  expect(builds).toEqual(["fixed","unbounded"]); // Intercepted, not actual build evidence.
  expect(JSON.parse(await readFile(join(root,".setup/preview.json"),"utf8")).livePreview).toBe(false);
  const secretNames: string[] = [];
  expect(await authorizeAndStore(instance,{installed:{client_id:"SYNTHETIC-ID",client_secret:"SYNTHETIC-SECRET"}},{authorize:async()=>({refresh_token:"SYNTHETIC-GRANT",scope:GMAIL_SCOPE}),writeSecret:async(target,name)=>{expect(target).toEqual({accountId:instance.cloudflare.accountId,workerName:instance.cloudflare.unboundedWorkerName});secretNames.push(name);}})).toMatchObject({ok:true});
  expect(secretNames).toEqual(["GMAIL_CLIENT_ID","GMAIL_CLIENT_SECRET","GMAIL_REFRESH_TOKEN"]);
  const review = {instanceId:instance.instanceId,instanceSha256:hashBytes(JSON.stringify(instance)),criteriaVersion:runtime.criteriaVersion,readableSha256:candidate.approval.readableSha256,resourceIds:Object.fromEntries((await loadResourcePlan(root)).intents.map(i=>[i.kind,i.id!])),expectedRevision:null,externalQuiesced:true,receiptsReconciled:true,evidence:"SYNTHETIC: fake resources never deployed; no delivery possible",reviewedAt:new Date().toISOString()};
  expect(await activateReviewed(root,instance,runtime,fake,db,review)).toBe(1);
  const operational = await renderConfig(instance,candidate,"unbounded","/tmp/synthetic.ts","operational",join(root,".setup/dependencies/node_modules/@anthropic-ai/sdk/index.mjs"));
  expect(operational.text).toContain('crons = ["*/5 * * * *"]');
  expect(operational.text).toContain('[alias]');
  expect(await main(["status","--workspace",root,"--instance",join(root,"instance.json")])).toBe("[]");
  // No simulated capability claim becomes a real assistant/account receipt.
  expect(fake.records).toHaveLength(4); expect(instance.radar.enabled).toBe(false);
});
