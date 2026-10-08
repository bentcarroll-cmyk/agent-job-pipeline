import { expect, it } from "vitest";
import { buildPlan } from "./import/plan";
import { legacyCandidates } from "./import/legacy";
const row: any = {ownerTable:"known_applications",ownerId:"known:1", employer:"Synthetic Labs",title:"Director of Operations",requisitionId:"SYN-100",postingUrl:null,status:"applied",statusUpdatedAt:null,appliedAt:null,source:"fixture",sourceJobId:null};
it.each(["Director of Operations","Operations Director",null])("does not update conflicting requisitions through title/proximity %s", title => {
  const plan=buildPlan({existing:[row],candidates:[], evidence:[{event:"rejection",employer:row.employer,title,requisitionId:"SYN-200",date:"2026-01-10",evidence:"Synthetic rejection"}],answers:{},questions:[],generatedAt:"2026-01-11"} as any);
  expect(plan.updates).toEqual([]); expect(plan.questions).toHaveLength(1); expect(plan.projected[0]).toMatchObject({status:"applied",appliedAt:null,statusUpdatedAt:null});
});
it("rejects a conflict derived from the stored canonical URL",()=>{
 const plan=buildPlan({existing:[{...row,requisitionId:null,postingUrl:"https://jobs.lever.co/synthetic/SYN-100"}],candidates:[],evidence:[{event:"application_confirmation",employer:row.employer,title:row.title,requisitionId:"SYN-200",date:"2026-01-10",evidence:"Synthetic confirmation"}],answers:{},questions:[],generatedAt:"2026-01-11"} as any);
 expect(plan.updates).toEqual([]);expect(plan.questions).toHaveLength(1);
});
it.each([null,"2025-04-03"])("does not invent user confirmation provenance %s",date=>{
 const output=legacyCandidates({legacy:[{employer:"Synthetic",title:"Operator",linear_reference:{linear_id:"SYN-1"},review:{review_decision:"pursue"}}],register:[],issues:[],pursue:{applied_confirmed_by_email:[],applied_confirmed_by_user:date?[{linear_id:"SYN-1",confirmed_on:date,source:"Selected interview"}]:["SYN-1"],not_applied:[]},holdForReview:[],answers:{}} as any);
 expect(output.candidates[0]).toMatchObject({status:"applied",appliedAt:null,statusAt:null});
 expect(output.candidates[0].evidence).toBe(date?"User confirmed applying: Selected interview (confirmed 2025-04-03)":"User confirmed applying (undated)");
});
it("uses supplied register provenance",()=>{
 const output=legacyCandidates({legacy:[],register:[{company:"Synthetic",role:"Operator",stage:"Application received",confirmationDate:null,source:"Selected register"}],issues:[],pursue:{applied_confirmed_by_email:[],applied_confirmed_by_user:[],not_applied:[]},holdForReview:[],answers:{}} as any);
 expect(output.candidates[0].evidence).toBe("Selected register: Application received (undated)");expect(output.candidates[0].appliedAt).toBeNull();
});

it("does not use near-title fallback across different requisitions",()=>{
 const plan=buildPlan({existing:[{...row,title:"Director of Strategy Operations"}],candidates:[],evidence:[{event:"rejection",employer:row.employer,title:"Strategy Operations Director",requisitionId:"SYN-200",date:"2026-01-10",evidence:"Synthetic rejection"}],questions:[],answers:{},generatedAt:"2026-01-11"});
 expect(plan.updates).toEqual([]);expect(plan.questions).toHaveLength(1);
});
it("updates a matching explicit requisition despite a changed title",()=>{
 const plan=buildPlan({existing:[row],candidates:[],evidence:[{event:"rejection",employer:row.employer,title:"Director of Operational Programs",requisitionId:"SYN-100",date:"2026-01-10",evidence:"Synthetic rejection"}],questions:[],answers:{},generatedAt:"2026-01-11"});
 expect(plan.updates[0].after.status).toBe("closed");expect(plan.questions).toEqual([]);
});
it.each(["historical","email","register"])("keeps %s confirmation observation separate from unknown application time",kind=>{
 const record={employer:"Synthetic",title:"Operator",linear_reference:{linear_id:"SYN-1"},review:{review_decision:"pursue"},...(kind==="historical"?{historical_state:{application_status:{state:"applied",confirmed_on:"2025-02-03"}}}:{})};
 const result=legacyCandidates({legacy:kind==="register"?[]:[record],register:kind==="register"?[{company:"Synthetic",role:"Operator",stage:"Application received",confirmationDate:"2025-02-03",source:"Selected source"}]:[],issues:[],pursue:{applied_confirmed_by_email:kind==="email"?[{linear_id:"SYN-1",employer:"Synthetic",evidence_date:"2025-02-03"}]:[],applied_confirmed_by_user:[],not_applied:[]},holdForReview:[],answers:{}});
 expect(result.candidates[0]).toMatchObject({status:"applied",appliedAt:null,statusAt:null});expect(result.candidates[0].evidence).toContain("2025-02-03");
});
it("preserves explicit submission time instead of the later confirmation observation",()=>{
 const result=legacyCandidates({legacy:[{employer:"Synthetic",title:"Operator",historical_state:{application_status:{state:"applied",submitted_at:"2025-02-01",confirmed_on:"2025-02-03"}}}],register:[],issues:[],pursue:{applied_confirmed_by_email:[],applied_confirmed_by_user:[],not_applied:[]},holdForReview:[],answers:{}});
 expect(result.candidates[0]).toMatchObject({status:"applied",appliedAt:"2025-02-01",statusAt:"2025-02-01"});
});
it("does not turn a review observation into application timing when the answer confirms applied",()=>{
 const result=legacyCandidates({legacy:[],register:[{company:"Synthetic",role:"Operator",stage:"Unconfirmed",confirmationDate:"2025-02-03",latestEventDate:"2025-02-04"}],issues:[],pursue:{applied_confirmed_by_email:[],applied_confirmed_by_user:[],not_applied:[]},holdForReview:[],answers:{"register:synthetic":"applied"}});
 expect(result.candidates[0]).toMatchObject({status:"applied",appliedAt:null,statusAt:null});
});

const workdayRow = {...row, requisitionId:null, source:'codex_pipeline', sourceJobId:'fixture-old', postingUrl:'https://synthetic.wd1.myworkdayjobs.com/External/job/Test/Operations_R-100'};
it.each(['fixture-new', 'fixture-old'])("holds different known Workday sites before automatic candidate matching (%s)", sourceJobId => {
 const plan=buildPlan({existing:[workdayRow], candidates:[{source:'codex_pipeline',sourceJobId,employer:row.employer,title:row.title,status:'closed',statusAt:'2026-01-10',appliedAt:'2026-01-01',postingUrl:'https://synthetic.wd1.myworkdayjobs.com/Internal/job/Test/Operations_R-100',requisitionId:null,mergeInto:null,evidence:'Synthetic site conflict'}],evidence:[],answers:{},questions:[],generatedAt:'2026-01-11'} as any);
 expect(plan.updates).toEqual([]); expect(plan.inserts).toEqual([]); expect(plan.questions).toHaveLength(1);
 expect(plan.projected[0]).toMatchObject({status:'applied',appliedAt:null,statusUpdatedAt:null,postingUrl:workdayRow.postingUrl});
});
it('normalizes same-site Workday locale and apply paths when reconciling a candidate',()=>{
 const plan=buildPlan({existing:[workdayRow], candidates:[{source:'codex_pipeline',sourceJobId:'fixture-new',employer:row.employer,title:row.title,status:'closed',statusAt:'2026-01-10',appliedAt:null,postingUrl:'https://synthetic.wd1.myworkdayjobs.com/en-US/External/job/Test/Operations_R-100/apply',requisitionId:null,mergeInto:null,evidence:'Synthetic same-site outcome'}],evidence:[],answers:{},questions:[],generatedAt:'2026-01-11'} as any);
 expect(plan.questions).toEqual([]); expect(plan.updates[0].after).toMatchObject({status:'closed',statusUpdatedAt:'2026-01-10'});
});
