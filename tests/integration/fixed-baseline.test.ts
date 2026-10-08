import { readFileSync } from "node:fs";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({WorkflowEntrypoint:class {env:unknown;constructor(_ctx:unknown,env:unknown){this.env=env;}}}));
import { AgentWorkflow } from "../../src/index";
import * as sources from "../../src/sources";
import { createDatabase, loadSchema } from "./harness";
import { CHICAGO_OPERATIONS, posting } from "../fixtures/candidates";
import { completePosting } from "../fixtures/policy-postings";
import { hasFixedBaseline, completeFixedBaseline } from "../../src/discovery/baseline";
import { acquireLease } from "../../src/operations/leases";
import { candidateCriteriaVersion } from "../../src/config/candidate";
let db:D1Database,dispose:()=>Promise<void>;
const steps={do:async(_name:string,...args:any[])=>args.at(-1)(),sleep:async()=>{}};
const instance=JSON.parse(readFileSync(new URL("../../examples/instance.json",import.meta.url),"utf8"));
let sequence=0;
const run=(extra:any={},step=steps)=>new AgentWorkflow({} as any,{DB:db,CANDIDATE_CONFIG:JSON.stringify(CHICAGO_OPERATIONS),INSTANCE_CONFIG:JSON.stringify(instance),...extra} as any).run({instanceId:`baseline-${sequence++}`,payload:{}} as any,step as any);
function catalog(jobs:sources.NormalizedJob[],fail=false){vi.spyOn(sources,"fetchAllPostings").mockImplementation(async(list,observe)=>{for(const source of list) await observe?.({source,status:fail?"failed":"complete",startedAt:"2026-01-01",finishedAt:"2026-01-01",jobs,error:fail?"synthetic source failed":null});return {jobs,errors:fail?["synthetic source failed"]:[]};});}
beforeEach(async()=>{({db,dispose}=await createDatabase());await loadSchema(db,"root");vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("Unexpected provider or Slack call");}));});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await dispose();});
it("ignores unrelated manual/unbounded rows, resumes interrupted writes and screens only later jobs",async()=>{
 await db.prepare("INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,application_status,discovery_source) VALUES ('manual','Synthetic','Operator','https://example.test/manual','2026-01-01','2026-01-01','applied','manual_add'),('unbounded','Synthetic','Operator','https://example.test/unbounded','2026-01-01','2026-01-01','not_applied','unbounded_search')").run();
 const jobs=Array.from({length:55},(_,i)=>posting({id:`greenhouse:Example Automation:${i}`,url:`https://job-boards.greenhouse.io/example-automation/jobs/${i}`}));catalog(jobs);
 const batch=db.batch.bind(db);
 // Stop after the actual first write chunk, regardless of adapter statement representation.
 let interrupted=false;const partial={...db,batch:async(stmts:any)=>{const result=await batch(stmts);if(!interrupted && (await db.prepare("SELECT count(*) n FROM jobs").first<any>())!.n>=52){interrupted=true;throw new Error("synthetic partial write");}return result;},prepare:db.prepare.bind(db)};
 await expect(run({DB:partial})).rejects.toThrow("synthetic partial write");
 expect(await db.prepare("SELECT count(*) n FROM jobs").first()).toEqual({n:52});
 expect(await run()).toMatchObject({baseline:true,jobCount:55});
 expect(await db.prepare("SELECT application_status FROM jobs WHERE id='manual'").first()).toEqual({application_status:"applied"});
 expect(await db.prepare("SELECT count(*) n FROM jobs WHERE match IS NOT NULL").first()).toEqual({n:0});expect(fetch).not.toHaveBeenCalled();
 const later=completePosting({id:"greenhouse:Example Automation:1000",url:"https://job-boards.greenhouse.io/example-automation/jobs/1000"});catalog([...jobs,later]);
 vi.spyOn(sources,"fetchPosting").mockResolvedValue(later);
 const model=vi.fn(async()=>{throw new Error("Synthetic later posting screened");});
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({ok:true})));
 vi.spyOn(console,"log").mockImplementation(()=>{});
 await run({AI:{run:model}});
 expect(model).toHaveBeenCalledOnce();
 expect(await db.prepare("SELECT job_id FROM discovery_retries").first()).toEqual({job_id:later.id});
 expect(await db.prepare("SELECT count(*) n FROM jobs WHERE match IS NOT NULL").first()).toEqual({n:0});

});
it.each(["failed","partial","empty"])("only complete source coverage establishes baseline: %s",async kind=>{
 const candidate=structuredClone(CHICAGO_OPERATIONS);if(kind==="partial")candidate.search.sources=[...candidate.search.sources,{...candidate.search.sources[0],company:"Synthetic Second",slug:"synthetic-second"} as any];candidate.approval.configSha256=await candidateCriteriaVersion(candidate);
 const env={CANDIDATE_CONFIG:JSON.stringify(candidate)};
 let failed=kind!=="empty";vi.spyOn(sources,"fetchAllPostings").mockImplementation(async(list,observe)=>{for(const [i,source] of list.entries())await observe?.({source,status:failed&&i===0?"failed":"complete",startedAt:"2026-01-01",finishedAt:"2026-01-01",jobs:[],error:failed&&i===0?"synthetic":null});return{jobs:[],errors:failed?["synthetic"]:[]};});
 await run(env);failed=false;
 const result=await run(env,{do:async(name:string,...args:any[])=>{if(name==="fetch-new-postings")return Promise.reject(new Error("complete baseline"));return args.at(-1)();},sleep:async()=>{}}).catch(e=>e.message);
 if(kind==="empty")expect(result).toBe("complete baseline");else expect(result).toMatchObject({baseline:true});expect(fetch).not.toHaveBeenCalled();
});

it("scopes baseline completion to instance and source configuration and fences stale writers",async()=>{
 const selected=CHICAGO_OPERATIONS.search.sources;
 const lease=(await acquireLease(db,"fixed_boards","first"))!;
 await completeFixedBaseline(db,lease,"instance-a",selected);
 expect(await hasFixedBaseline(db,"instance-a",selected)).toBe(true);
 expect(await hasFixedBaseline(db,"instance-b",selected)).toBe(false);
 expect(await hasFixedBaseline(db,"instance-a",[])).toBe(false);
 await db.prepare("UPDATE discovery_run_leases SET expires_at=0").run();
 await acquireLease(db,"fixed_boards","replacement");
 await expect(completeFixedBaseline(db,lease,"instance-b",selected)).rejects.toThrow(/lease lost/i);
 expect(await hasFixedBaseline(db,"instance-b",selected)).toBe(false);
});
