import { describe, expect, it } from "vitest";
import { assignRound, decideInThread, isReply, opensRound, startsFirstRound, type ExistingRound, type Invitation } from "../../src/lifecycle/decide";
import { parseMessage } from "../../src/lifecycle/gmail-message";
import { renderSummary } from "../../src/lifecycle/slack-blocks";
import type { LedgerRow } from "../../src/ledger/types";
import type { OutcomeEvidence } from "../../src/ledger/import/types";

// Fabricated applications and mail. Each case reproduces a sequence that broke
// round counting.
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  ownerTable: "known_applications",
  ownerId: "101",
  employer: "Fixture Lambda",
  title: "Operations Lead",
  status: "applied",
  statusUpdatedAt: "2026-04-13",
  source: "codex_pipeline",
  sourceJobId: "JOB-000001",
  canonicalId: null,
  postingUrl: null,
  requisitionId: null,
  appliedAt: "2026-04-13",
  statusSource: "ledger_import",
  ...over,
});
const ev = (over: Partial<OutcomeEvidence>): OutcomeEvidence => ({
  event: "rejection",
  employer: "Fixture Lambda",
  title: "Operations Lead",
  requisitionId: null,
  date: "2026-04-16",
  evidence: "2026-04-16 · no-reply@ats.example.com · Thank you for your application!",
  ...over,
});
const round = (over: Partial<ExistingRound>): ExistingRound => ({
  id: 1,
  round: 1,
  stage: null,
  scheduledFor: null,
  invitedAt: "2026-04-29T11:30:00.000Z",
  gmailThreadId: "t1",
  ...over,
});
const invite = (over: Partial<Invitation>): Invitation => ({
  threadId: "t2",
  date: "2026-04-29T16:36:00.000Z",
  stage: null,
  scheduledFor: null,
  opensRound: true,
  ...over,
});

describe("assignRound", () => {
  it("starts round 1", () => {
    expect(assignRound([], invite({}))).toEqual({ action: "new", round: 1 });
  });

  it("starts round 1 even from mail that could not open a later one", () => {
    expect(assignRound([], invite({ opensRound: false }))).toEqual({ action: "new", round: 1 });
  });

  it("treats another email in a known thread as the same round, taking its time", () => {
    const next = invite({ threadId: "t1", scheduledFor: "2026-05-01T11:13:00-07:00" });
    expect(assignRound([round({ id: 4 })], next)).toEqual({ action: "update", id: 4, scheduledFor: "2026-05-01T11:13:00-07:00", stage: null });
  });

  it("treats a second notice of the same start time as the same round (a relay quoting it in another time zone)", () => {
    const first = round({ id: 16, scheduledFor: "2026-04-29T11:13:00-05:00", invitedAt: "2026-04-26T09:36:00.000Z" });
    const relay = invite({ date: "2026-04-27T02:15:00.000Z", scheduledFor: "2026-04-29T16:13:00+00:00" });
    expect(assignRound([first], relay)).toEqual({ action: "update", id: 16, scheduledFor: null, stage: null });
  });

  it("opens the next round once the last one has happened (a phone screen, then the recruiter's note)", () => {
    const screen = round({ id: 13, stage: "recruiter_screen", scheduledFor: "2026-04-29T05:43:00-05:00", invitedAt: "2026-04-24T13:23:00.000Z" });
    expect(assignRound([screen], invite({ date: "2026-04-29T11:30:00.000Z" }))).toEqual({ action: "new", round: 2 });
  });

  it("opens the next round from an invitation in an earlier round's thread once that round has happened", () => {
    const screen = round({ id: 12, stage: "recruiter_screen", scheduledFor: "2026-04-30T06:43:00-05:00", invitedAt: "2026-04-24T11:11:00.000Z" });
    const panel = invite({ threadId: "t1", date: "2026-05-01T10:43:00.000Z", stage: "panel", scheduledFor: "2026-05-06T10:43:00-05:00" });
    expect(assignRound([screen], panel)).toEqual({ action: "new", round: 2 });
  });

  it("joins a round invited hours earlier that has no time yet, filling in its step (the scheduling system's email after the recruiter's)", () => {
    const pending = round({ id: 24, round: 2 });
    expect(assignRound([round({ scheduledFor: "2026-04-29T05:43:00-05:00" }), pending], invite({ stage: "hiring_manager" }))).toEqual({
      action: "update",
      id: 24,
      scheduledFor: null,
      stage: "hiring_manager",
    });
  });

  it("opens the next round when a later email names a different step (a screen, then the hiring manager)", () => {
    const screen = round({ id: 14, stage: "recruiter_screen", invitedAt: "2026-04-24T19:07:00.000Z" });
    expect(assignRound([screen], invite({ date: "2026-04-26T11:23:00.000Z", stage: "hiring_manager" }))).toEqual({ action: "new", round: 2 });
  });

  it("keeps a repeat invitation to the same step in one round, however late it comes", () => {
    const screen = round({ id: 14, stage: "recruiter_screen", invitedAt: "2026-04-24T19:07:00.000Z" });
    expect(assignRound([screen], invite({ date: "2026-04-27T05:43:00.000Z", stage: "recruiter_screen" }))).toEqual({
      action: "update",
      id: 14,
      scheduledFor: null,
      stage: null,
    });
  });

  it("puts a calendar invite's time on the round still waiting for one (an interview loop over two days)", () => {
    const loop = round({ id: 20, invitedAt: "2026-04-26T13:46:00.000Z" });
    const calendar = invite({ date: "2026-04-29T06:05:00.000Z", scheduledFor: "2026-04-29T12:13:00-05:00" });
    expect(assignRound([loop], calendar)).toEqual({ action: "update", id: 20, scheduledFor: "2026-04-29T12:13:00-05:00", stage: null });
  });

  it("adds a second conversation to a round that has not happened yet, under the same number (final interviews on two days)", () => {
    const rounds = [
      round({ id: 14, round: 1, scheduledFor: "2026-04-26T05:43:00-05:00" }),
      round({ id: 17, round: 2, scheduledFor: "2026-05-02T14:13:00-05:00" }),
      round({ id: 31, round: 3, stage: "other", scheduledFor: "2026-05-08T11:43:00-05:00", invitedAt: "2026-05-03T16:58:00.000Z" }),
    ];
    const second = invite({ date: "2026-05-03T17:03:00.000Z", scheduledFor: "2026-05-10T06:13:00-05:00" });
    expect(assignRound(rounds, second)).toEqual({ action: "new", round: 3 });
  });

  it("counts untimed mail about an upcoming round as that round (an AIApply relay after the calendar invites)", () => {
    const sessions = [
      round({ id: 20, scheduledFor: "2026-04-29T12:13:00-05:00" }),
      round({ id: 22, scheduledFor: "2026-04-30T09:33:00-05:00", gmailThreadId: "t3" }),
    ];
    expect(assignRound(sessions, invite({ threadId: "t4", date: "2026-04-29T08:36:00.000Z" }))).toEqual({ action: "update", id: 20, scheduledFor: null, stage: null });
  });

  it("opens no later round from mail that cannot be an invitation (a reference check after the loop)", () => {
    const loop = [round({ id: 20, scheduledFor: "2026-04-29T12:13:00-05:00" })];
    expect(assignRound(loop, invite({ date: "2026-04-30T20:16:00.000Z", stage: "other", opensRound: false }))).toEqual({ action: "none" });
  });

  it("reads a hand-recorded round's invitation as lasting its day", () => {
    const seeded = round({ id: 2, invitedAt: "2026-04-15" });
    expect(assignRound([seeded], invite({ date: "2026-04-15T18:53:00.000Z" }))).toMatchObject({ action: "update", id: 2 });
    expect(assignRound([seeded], invite({ date: "2026-04-16T18:53:00.000Z" }))).toEqual({ action: "new", round: 2 });
  });

  it("makes a vague invitation a day after an untimed one the next round (a screen, then a second interview)", () => {
    const afterScreen = [round({ id: 9, stage: "recruiter_screen", invitedAt: "2026-04-16T14:46:00.000Z", gmailThreadId: "t-screen" })];
    const second = invite({ threadId: "t-second", date: "2026-04-17T14:36:00.000Z", stage: "other" });
    expect(assignRound(afterScreen, second)).toEqual({ action: "new", round: 2 });
  });
});

describe("opensRound", () => {
  it("accepts an employer's or a relay's invitation", () => {
    expect(opensRound({ from: "recruiter@fixturemu.test", subject: "Panel interview availability | Alex Example" })).toBe(true);
    expect(opensRound({ from: "hello@aiapplynotif.com", subject: "Fixture Gamma wants to interview you" })).toBe(true);
  });

  it("rejects the mailbox owner's own replies, forwards and drafts", () => {
    expect(opensRound({ from: "alex@example.com", subject: "Re: Follow-up email", byOwner: true })).toBe(false);
    expect(opensRound({ from: "recruiter@fixturebeta.test", subject: "Re: Follow-up email", byOwner: false })).toBe(true);
  });

  it("rejects reference checks, NDAs and AIApply's follow-up notices, whoever sends them", () => {
    expect(opensRound({ from: "hiring@fixturegamma.test", subject: "Re: Reference check - Fixture Gamma" })).toBe(false);
    expect(opensRound({ from: "coordinator@fixturealpha.test", subject: "Action required: NDA before your interview" })).toBe(false);
    expect(opensRound({ from: "hello@aiapplynotif.com", subject: "A follow-up from Fixture Gamma" })).toBe(false);
  });
});

describe("parseMessage", () => {
  const message = (labelIds?: string[]) => ({
    id: "m1",
    threadId: "t1",
    internalDate: String(Date.parse("2026-04-29T13:35:00.000Z")),
    labelIds,
    payload: { headers: [{ name: "From", value: "Alex Example <alex@example.com>" }, { name: "Subject", value: "Re: Follow-up email" }] },
  });

  it("marks the mail the account sent or drafted, from Gmail's SENT and DRAFT labels", () => {
    expect(parseMessage(message(["SENT"])).byOwner).toBe(true);
    expect(parseMessage(message(["DRAFT"])).byOwner).toBe(true);
    expect(parseMessage(message(["INBOX", "UNREAD"])).byOwner).toBe(false);
    expect(parseMessage(message()).byOwner).toBe(false);
  });
});

describe("isReply", () => {
  it("recognises replies and forwards", () => {
    expect(isReply("Re: Next steps: Senior Analyst - Fixture Kappa")).toBe(true);
    expect(isReply("Fwd: Next steps: Senior Analyst - Fixture Kappa")).toBe(true);
    expect(isReply("FW: Thanks for the chat!")).toBe(true);
  });

  it("does not take automated mail for one, though Gmail threads it by subject line", () => {
    expect(isReply("Fixture Gamma wants to interview you")).toBe(false);
    expect(isReply("Thank you for applying to Fixture Mu")).toBe(false);
    expect(isReply("Regarding your application")).toBe(false);
  });
});

// An application recorded under a subsidiary, mail that names its parent.
describe("decideInThread", () => {
  const subsidiary = row({ ownerId: "301", employer: "Fixture Kappa", title: "Senior Analyst", status: "interviewing", statusUpdatedAt: "2026-04-05" });
  const parent = row({ ownerTable: "jobs", ownerId: "workday:fixtureomega:r-1001", employer: "Fixtureomega", title: "Director, Strategy", status: "closed" });
  const rows = [subsidiary, parent];
  const offer = ev({
    event: "offer",
    employer: "FixtureOmega",
    title: "Senior Analyst - Fixture Kappa",
    date: "2026-04-29",
    evidence: "2026-04-29 · recruiter@fixtureomega.test · Re: Next steps: Senior Analyst - Fixture Kappa",
    sender: "recruiter@fixtureomega.test",
  });

  it("asks about mail that names the parent company when its thread is new", () => {
    expect(decideInThread(rows, offer, null, [], "now").kind).toBe("question");
  });

  it("gives it to the application the rest of its thread belongs to", () => {
    expect(decideInThread(rows, offer, null, ["301", "301"], "now")).toMatchObject({ kind: "applied", change: { ownerId: "301", from: "interviewing", to: "offer" } });
  });

  it("still asks when the thread has served two applications, or one no longer on record", () => {
    expect(decideInThread(rows, offer, null, ["301", "302"], "now").kind).toBe("question");
    expect(decideInThread(rows, offer, null, ["999"], "now").kind).toBe("question");
  });

  it("lets the owner's own answer stand", () => {
    const asked = decideInThread(rows, offer, null, [], "now");
    const id = asked.kind === "question" ? asked.question.id : "";
    expect(decideInThread(rows, offer, { questionId: id, value: "skip" }, ["301"], "now")).toEqual({ kind: "skipped" });
  });

  it("leaves a status it may not change as a question for the owner", () => {
    const closed = [row({ ...subsidiary, status: "closed", statusUpdatedAt: "2026-04-25" }), parent];
    const d = decideInThread(closed, offer, null, ["301"], "now");
    expect(d).toMatchObject({ kind: "question", question: { kind: "transition_review" } });
  });
});

describe("startsFirstRound", () => {
  const theta = row({ ownerId: "401", employer: "Fixture Theta", title: "Senior Data Engineer", status: "applied" });
  const eta = row({ ownerId: "402", employer: "Fixture Eta", title: "Product Manager", status: "interviewing" });
  const latest = [{ id: 35, ownerTable: "known_applications", ownerId: "402", round: 3, scheduledFor: "2026-05-07T04:58:00-05:00" }];
  const rows = [theta, eta];
  const note = { from: "scheduler@fixturetheta.test", subject: "Fixture Theta interview - Alex Example (Data Engineer 1001)" };
  const at = { employer: "Fixture Theta", scheduledFor: "2026-05-09T04:43:00-06:00" };

  it("takes an employer's scheduling email as the invitation when its application has no round yet", () => {
    expect(startsFirstRound(latest, rows, note, at)).toBe(true);
  });

  it("leaves an application that already has a round to the scheduling rules", () => {
    const email = { from: "coordinator@fixtureeta.test", subject: "Your interview with Fixture Eta" };
    expect(startsFirstRound(latest, rows, email, { employer: "Fixture Eta", scheduledFor: "2026-05-14T05:43:00-05:00" })).toBe(false);
  });

  it("needs the employer's own domain or Google Calendar, a time, and an application on record", () => {
    expect(startsFirstRound(latest, rows, { ...note, from: "events@newsletter.example.com" }, at)).toBe(false);
    expect(startsFirstRound(latest, rows, note, { ...at, scheduledFor: null })).toBe(false);
    expect(startsFirstRound(latest, rows, { from: "hr@acme.example.com", subject: "Acme Interview" }, { employer: "Acme", scheduledFor: at.scheduledFor })).toBe(false);
    expect(startsFirstRound(latest, rows, { from: "calendar-notification@google.com", subject: "Invitation: Fixture Theta interview" }, at)).toBe(true);
  });
});

describe("renderSummary", () => {
  it("shows an interview time recorded from a scheduling email, with Undo", () => {
    const [msg] = renderSummary(
      [{ kind: "scheduled", messageId: "m7", employer: "Fixture Kappa", title: "Analyst, P&O", round: 2, scheduledFor: "2026-04-18T06:43:00-05:00" }],
      { test: false, dateLabel: "d", staleQuestions: 0, timezone: "America/New_York" },
    );
    expect(msg.blocks[1].text.text).toBe("🗓 *Fixture Kappa*, Analyst, P&amp;O: *round 2* on Sat, Apr 18, 7:43 AM EDT");
    expect(msg.blocks[1].block_id).toBe("lc:m7");
    expect(msg.blocks[1].accessory).toMatchObject({ action_id: "lifecycle_undo", value: "m7" });
  });
});
