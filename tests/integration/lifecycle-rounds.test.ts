import { afterEach, expect, it, vi } from "vitest";
import type { Classification } from "../../src/lifecycle/classify";
import { answerQuestion, decideAndRecord, undoChange } from "../../src/lifecycle/record";
import { createDatabase, loadSchema } from "./harness";

// Fabricated mail, as the classifier would read it. One interview brings
// between one and five emails, most in threads of their own.
const active: Array<Awaited<ReturnType<typeof createDatabase>>> = [];
afterEach(async () => { for (const instance of active.splice(0)) await instance.dispose(); });

type Mail = { at: string; from: string; subject: string; thread: string; byOwner?: boolean; event?: Classification["event"]; employer?: string; stage?: Classification["roundStage"]; when?: string };

// The mailbox owner's own mail, which Gmail labels SENT.
const OWNER = "alex@example.com";

async function database() {
  const instance = await createDatabase(); active.push(instance);
  await loadSchema(instance.db, "root");
  return instance.db;
}

const posting = (db: D1Database, id: string, company: string, title: string) =>
  db.prepare("INSERT INTO jobs (id,company,title,url,first_seen_at,last_seen_at,is_known_application,known_application_source,application_status) VALUES (?,?,?,?,'2026-04-15','2026-04-15',0,NULL,'applied')").bind(id, company, title, `https://example.test/${id}`).run();
const known = (db: D1Database, id: number, employer: string, title: string, status: string) =>
  db.prepare("INSERT INTO known_applications (id, employer, title, status, source) VALUES (?,?,?,?,'aiapply')").bind(id, employer, title, status).run();

// Oldest first, as the daily run does it.
async function deliver(db: D1Database, employer: string, title: string, mail: Mail[]): Promise<string[]> {
  const decisions: string[] = [];
  for (const m of [...mail].sort((a, b) => a.at.localeCompare(b.at))) {
    const c: Classification = { event: m.event ?? "interview_invitation", employer: m.employer ?? employer, title, requisitionId: null, roundStage: m.stage ?? null, scheduledFor: m.when ?? null };
    const id = `${m.thread}-${m.at}`;
    decisions.push(await decideAndRecord(db, { id, email: { id, threadId: m.thread, from: m.from, subject: m.subject, date: m.at, byOwner: m.byOwner }, ok: true, c }, true, "2026-05-04T07:43:00.000Z"));
  }
  return decisions;
}

// Slack's replies are stubbed; only the database is checked.
const slackEnv = (db: D1Database) => ({ DB: db, SLACK_BOT_TOKEN: "SYNTHETIC-SLACK", SLACK_CHANNEL_ID: "CEXAMPLE123", SLACK_SIGNING_SECRET: "SYNTHETIC-SIGNING", SLACK_ALLOWED_USER_ID: "UEXAMPLE123" }) as any;

const rounds = async (db: D1Database) =>
  (await db.prepare("SELECT round, stage, scheduled_for FROM interview_rounds ORDER BY round, scheduled_for").all()).results;

it("records eight emails as three rounds, the third with two conversations", async () => {
  const db = await database();
  await posting(db, "greenhouse:fixturealpha:1001", "Fixture Alpha", "Operations Analyst");
  await deliver(db, "Fixture Alpha", "Operations Analyst", [
    { at: "2026-04-24T19:07:00.000Z", from: "no-reply@fixturealpha.test", subject: "Interview request: Operations Analyst", thread: "p1", stage: "recruiter_screen" },
    { at: "2026-04-26T11:13:00.000Z", from: "coordinator@fixturealpha.test", subject: "Action required: NDA before your interview", thread: "p2", stage: "other" },
    { at: "2026-04-26T11:23:00.000Z", from: "coordinator@fixturealpha.test", subject: "Schedule your interview with Fixture Alpha", thread: "p3", stage: "hiring_manager" },
    { at: "2026-04-27T15:13:00.000Z", from: "coordinator@fixturealpha.test", subject: "Interview confirmed: Operations Analyst", thread: "p4", event: "interview_logistics", when: "2026-05-02T14:13:00-05:00" },
    { at: "2026-05-03T16:58:00.000Z", from: "recruiter@fixturealpha.test", subject: "Next steps: your availability for interviews", thread: "p5", stage: "other" },
    { at: "2026-05-03T17:03:00.000Z", from: "recruiter@fixturealpha.test", subject: "Interview confirmed: Operations Analyst", thread: "p6", event: "interview_logistics", when: "2026-05-08T11:43:00-05:00" },
    { at: "2026-05-03T17:03:00.000Z", from: "recruiter@fixturealpha.test", subject: "Invitation: Interview with Fixture Alpha", thread: "p7", when: "2026-05-08T11:43:00-05:00" },
    { at: "2026-05-03T17:03:00.000Z", from: "recruiter@fixturealpha.test", subject: "Invitation: Second interview with Fixture Alpha", thread: "p8", when: "2026-05-10T06:13:00-05:00" },
  ]);
  expect(await rounds(db)).toEqual([
    { round: 1, stage: "recruiter_screen", scheduled_for: null },
    { round: 2, stage: "hiring_manager", scheduled_for: "2026-05-02T14:13:00-05:00" },
    { round: 3, stage: "other", scheduled_for: "2026-05-08T11:43:00-05:00" },
    { round: 3, stage: null, scheduled_for: "2026-05-10T06:13:00-05:00" },
  ]);
});

it("records a recruiter's notes and the scheduling system's emails as one round per interview", async () => {
  const db = await database();
  await posting(db, "greenhouse:fixturebeta:2001", "Fixture Beta", "Program Manager");
  await deliver(db, "Fixture Beta", "Program Manager", [
    { at: "2026-04-24T13:23:00.000Z", from: "talent@fixturebeta.test", subject: "Phone screen request: Program Manager (REQ-2001)", thread: "w1", stage: "recruiter_screen" },
    { at: "2026-04-28T10:45:00.000Z", from: "talent@fixturebeta.test", subject: "Reminder: your phone screen for Program Manager is tomorrow", thread: "w2", event: "interview_logistics", when: "2026-04-29T05:43:00-05:00" },
    { at: "2026-04-29T11:30:00.000Z", from: "recruiter@fixturebeta.test", subject: "Follow-up email", thread: "w3" },
    { at: "2026-04-29T13:35:00.000Z", from: OWNER, byOwner: true, subject: "Re: Follow-up email", thread: "w3" },
    { at: "2026-04-29T16:36:00.000Z", from: "talent@fixturebeta.test", subject: "Hiring manager interview request: Program Manager (REQ-2001)", thread: "w4", stage: "hiring_manager" },
    { at: "2026-04-30T18:15:00.000Z", from: "talent@fixturebeta.test", subject: "Reminder: your hiring manager interview for Program Manager is tomorrow", thread: "w5", event: "interview_logistics", when: "2026-05-01T11:13:00-07:00" },
    { at: "2026-05-03T13:58:00.000Z", from: "recruiter@fixturebeta.test", subject: "Follow-up email", thread: "w6", stage: "other" },
    { at: "2026-05-03T17:50:00.000Z", from: "talent@fixturebeta.test", subject: "Panel interview request: Program Manager", thread: "w7", stage: "panel" },
  ]);
  expect(await rounds(db)).toEqual([
    { round: 1, stage: "recruiter_screen", scheduled_for: "2026-04-29T05:43:00-05:00" },
    { round: 2, stage: "hiring_manager", scheduled_for: "2026-05-01T11:13:00-07:00" },
    { round: 3, stage: "panel", scheduled_for: null },
  ]);
});

it("records an interview loop over two days as one round, without its relays and reference checks", async () => {
  const db = await database();
  await known(db, 201, "Fixture Gamma", "Operations Manager", "interviewing");
  await deliver(db, "Fixture Gamma", "Operations Manager", [
    { at: "2026-04-26T13:46:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Gamma wants to interview you", thread: "l1" },
    { at: "2026-04-29T06:05:00.000Z", from: "coordinator@fixturegamma.test", subject: "Invitation: Interview with Alex Example (part 1)", thread: "l2", when: "2026-04-29T12:13:00-05:00" },
    { at: "2026-04-29T06:34:00.000Z", from: "coordinator@fixturegamma.test", subject: "Invitation: Interview with Alex Example (part 2)", thread: "l3", stage: "other", when: "2026-04-30T09:33:00-05:00" },
    { at: "2026-04-29T08:36:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Gamma wants to interview you", thread: "l4" },
    { at: "2026-04-30T19:58:00.000Z", from: "hello@aiapplynotif.com", subject: "A follow-up from Fixture Gamma", thread: "l5", stage: "other" },
    { at: "2026-04-30T20:16:00.000Z", from: "alex@work.example.com", subject: "Reference check - Fixture Gamma", thread: "l6", stage: "other" },
    { at: "2026-04-30T22:31:00.000Z", from: OWNER, byOwner: true, subject: "Reference check - Fixture Gamma", thread: "l7", stage: "other" },
    { at: "2026-04-30T23:01:00.000Z", from: "hiring@fixturegamma.test", subject: "Re: Reference check - Fixture Gamma", thread: "l7", stage: "other" },
  ]);
  expect(await rounds(db)).toEqual([
    { round: 1, stage: null, scheduled_for: "2026-04-29T12:13:00-05:00" },
    { round: 1, stage: "other", scheduled_for: "2026-04-30T09:33:00-05:00" },
  ]);
});

it("still counts a screen and a second interview a day later as two rounds", async () => {
  const db = await database();
  await known(db, 202, "Fixture Gamma", "Product Manager", "applied");
  await deliver(db, "Fixture Gamma", "Product Manager", [
    { at: "2026-04-16T14:46:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Gamma wants to interview you", thread: "s1", stage: "recruiter_screen" },
    { at: "2026-04-17T14:36:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Gamma wants to interview you", thread: "s2", stage: "other" },
    { at: "2026-04-17T19:52:00.000Z", from: "manager@fixturegamma.test", subject: "Invitation: Alex Example and the hiring team", thread: "s3", event: "interview_logistics", when: "2026-04-19T06:43:00-05:00" },
  ]);
  expect(await rounds(db)).toEqual([
    { round: 1, stage: "recruiter_screen", scheduled_for: null },
    { round: 2, stage: "other", scheduled_for: "2026-04-19T06:43:00-05:00" },
  ]);
});

it("records two relays of one interview once", async () => {
  const db = await database();
  await known(db, 203, "Fixture Delta", "Business Operations Manager", "applied");
  await deliver(db, "Fixture Delta", "Business Operations Manager", [
    { at: "2026-04-26T09:36:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Delta wants to interview you", thread: "o1", when: "2026-04-29T11:13:00-05:00" },
    { at: "2026-04-27T02:15:00.000Z", from: "hello@aiapplynotif.com", subject: "Fixture Delta wants to interview you", thread: "o2", when: "2026-04-29T16:13:00+00:00" },
  ]);
  expect(await rounds(db)).toEqual([{ round: 1, stage: null, scheduled_for: "2026-04-29T11:13:00-05:00" }]);
});

it("files a parent company's reply under the subsidiary's application when it continues that thread, and asks about anything else", async () => {
  const db = await database();
  await known(db, 301, "Fixture Kappa", "Senior Analyst", "applied");
  await posting(db, "workday:fixtureomega:r-1001", "Fixtureomega", "Director, Strategy");
  await deliver(db, "Fixture Kappa", "Senior Analyst", [
    { at: "2026-04-18T13:45:00.000Z", from: OWNER, byOwner: true, subject: "Re: Next steps: Senior Analyst - Fixture Kappa", thread: "e1", stage: "final" },
  ]);
  const decisions = await deliver(db, "FixtureOmega", "Senior Analyst - Fixture Kappa", [
    { at: "2026-04-29T14:44:00.000Z", from: "recruiter@fixtureomega.test", subject: "Re: Next steps: Senior Analyst - Fixture Kappa", thread: "e1", event: "offer" },
    // Automated mail that Gmail filed in the same thread by its subject line.
    { at: "2026-04-30T05:43:00.000Z", from: "notices@example-ats.test", subject: "Next steps: Senior Analyst - Fixture Kappa", thread: "e1", event: "offer" },
    { at: "2026-05-01T15:27:00.000Z", from: "notices@example-ats.test", subject: "Your offer of employment at FixtureOmega as Senior Analyst - Fixture Kappa", thread: "e2", event: "offer" },
  ]);
  expect(decisions).toEqual(["applied", "question", "question"]);
  expect(await db.prepare("SELECT status FROM known_applications WHERE id = 301").first()).toEqual({ status: "offer" });
});

it("keeps a screen's time when later mail in the recruiter's thread gives another", async () => {
  const db = await database();
  await known(db, 501, "Fixture Zeta", "Product Lead", "interviewing");
  await deliver(db, "Fixture Zeta", "Product Lead", [
    { at: "2026-04-24T11:11:00.000Z", from: "noreply@ats.example.com", subject: "Your application: Product Lead", thread: "r1", stage: "recruiter_screen" },
    { at: "2026-04-30T16:43:00.000Z", from: "coordinator@fixturezeta.test", subject: "Onsite interviews: Product Lead", thread: "r2", stage: "panel", when: "2026-05-06T10:43:00-05:00" },
  ]);
  // The screen's time, recorded by hand.
  await db.prepare("UPDATE interview_rounds SET scheduled_for = '2026-04-30T06:43:00-05:00' WHERE round = 1").run();
  const decisions = await deliver(db, "Fixture Zeta", "Product Lead", [
    { at: "2026-05-05T14:18:00.000Z", from: OWNER, byOwner: true, subject: "Re: Your application: Product Lead", thread: "r1", event: "interview_logistics", when: "2026-05-06T06:13:00-05:00" },
    { at: "2026-05-06T07:18:00.000Z", from: "recruiter@fixturezeta.test", subject: "Re: Your application: Product Lead", thread: "r1", event: "interview_logistics", when: "2026-05-06T10:43:00-05:00" },
  ]);
  expect(decisions).toEqual(["ignored", "ignored"]);
  expect(await rounds(db)).toEqual([
    { round: 1, stage: "recruiter_screen", scheduled_for: "2026-04-30T06:43:00-05:00" },
    { round: 2, stage: "panel", scheduled_for: "2026-05-06T10:43:00-05:00" },
  ]);
});

it("takes no interview time from the owner's own mail, even for a round still to come", async () => {
  const db = await database();
  await known(db, 402, "Fixture Eta", "Product Manager", "interviewing");
  await deliver(db, "Fixture Eta", "Product Manager", [
    { at: "2026-05-01T11:43:00.000Z", from: "coordinator@fixtureeta.test", subject: "Panel interview with Fixture Eta", thread: "t1", stage: "panel", when: "2026-05-07T04:58:00-05:00" },
    { at: "2026-05-02T11:43:00.000Z", from: OWNER, byOwner: true, subject: "Re: Panel interview with Fixture Eta", thread: "t1", event: "interview_logistics", when: "2026-05-07T06:13:00-05:00" },
  ]);
  expect(await rounds(db)).toEqual([{ round: 1, stage: "panel", scheduled_for: "2026-05-07T04:58:00-05:00" }]);
});

it("asks about a scheduling email as an invitation when nothing came before it, and records round 1 on the answer", async () => {
  const db = await database();
  await known(db, 401, "Fixture Theta", "Senior Data Engineer", "applied");
  const decisions = await deliver(db, "Fixture Theta", "Data Engineer", [
    { at: "2026-05-06T13:28:00.000Z", from: "scheduler@fixturetheta.test", subject: "Fixture Theta interview - Alex Example (Data Engineer 1001)", thread: "b1", event: "interview_logistics", when: "2026-05-09T04:43:00-06:00" },
  ]);
  // The email's title drops "Senior", so the match is the owner's to confirm.
  expect(decisions).toEqual(["question"]);
  const id = "b1-2026-05-06T13:28:00.000Z";
  const asked = await db.prepare("SELECT event, question_json FROM lifecycle_receipts WHERE gmail_message_id = ?").bind(id).first<{ event: string; question_json: string }>();
  expect(asked?.event).toBe("interview_invitation");
  expect(JSON.parse(asked!.question_json).options).toContain("401");

  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
  await answerQuestion(slackEnv(db), id, "401", { channelId: "CEXAMPLE123", messageTs: "1.0" });
  vi.unstubAllGlobals();

  expect(await db.prepare("SELECT status FROM known_applications WHERE id = 401").first()).toEqual({ status: "interviewing" });
  expect(await rounds(db)).toEqual([{ round: 1, stage: null, scheduled_for: "2026-05-09T04:43:00-06:00" }]);
});

it("puts back the time a scheduling email moved when the owner taps Undo", async () => {
  const db = await database();
  await known(db, 402, "Fixture Eta", "Product Manager", "interviewing");
  await deliver(db, "Fixture Eta", "Product Manager", [
    { at: "2026-05-01T11:43:00.000Z", from: "coordinator@fixtureeta.test", subject: "Panel interview with Fixture Eta", thread: "t1", stage: "panel", when: "2026-05-07T04:58:00-05:00" },
    { at: "2026-05-02T11:43:00.000Z", from: "coordinator@fixtureeta.test", subject: "Re: Panel interview with Fixture Eta", thread: "t1", event: "interview_logistics", when: "2026-05-07T06:13:00-05:00" },
  ]);
  expect(await rounds(db)).toEqual([{ round: 1, stage: "panel", scheduled_for: "2026-05-07T06:13:00-05:00" }]);

  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
  await undoChange(slackEnv(db), "t1-2026-05-02T11:43:00.000Z", { channelId: "CEXAMPLE123", messageTs: "1.0", blocks: [], text: "" });
  vi.unstubAllGlobals();

  expect(await rounds(db)).toEqual([{ round: 1, stage: "panel", scheduled_for: "2026-05-07T04:58:00-05:00" }]);
  expect(await db.prepare("SELECT decision FROM lifecycle_receipts WHERE gmail_message_id = 't1-2026-05-02T11:43:00.000Z'").first()).toEqual({ decision: "ignored" });
});
