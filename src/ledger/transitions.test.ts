import { describe, expect, it } from "vitest";
import { decideTransition, statusRank } from "./transitions";

describe("decideTransition", () => {
  it("applies a confirmation to a prepared application", () => {
    expect(decideTransition("packet_ready", "application_confirmation", null, "2026-09-19")).toEqual({
      action: "apply",
      to: "applied",
    });
  });

  it("leaves a matching status alone", () => {
    expect(decideTransition("applied", "application_confirmation", null, "2026-09-19")).toEqual({
      action: "unchanged",
      reason: "same_status",
    });
  });

  it("ignores a rejection for something already passed on", () => {
    expect(decideTransition("passed", "rejection", null, "2026-09-19")).toEqual({
      action: "unchanged",
      reason: "already_inactive",
    });
  });

  it("ignores a confirmation that predates a later status", () => {
    expect(decideTransition("closed", "application_confirmation", "2026-09-16", "2026-09-15")).toEqual({
      action: "unchanged",
      reason: "older_evidence",
    });
    expect(decideTransition("interviewing", "application_confirmation", "2026-09-19", "2026-09-19")).toEqual({
      action: "unchanged",
      reason: "older_evidence",
    });
  });

  it("asks before reopening a closed application", () => {
    expect(decideTransition("closed", "application_confirmation", "2026-09-10", "2026-09-19")).toEqual({
      action: "review",
      to: "applied",
      reason: "transition_not_allowed",
    });
  });

  it("asks before jumping from applied straight to an offer", () => {
    expect(decideTransition("applied", "offer", null, "2026-09-19")).toEqual({
      action: "review",
      to: "offer",
      reason: "transition_not_allowed",
    });
  });

  it("asks when the recorded status is newer than the email", () => {
    expect(decideTransition("applied", "rejection", "2026-09-20T10:32:06.000Z", "2026-09-16")).toEqual({
      action: "review",
      to: "closed",
      reason: "status_newer_than_evidence",
    });
  });

  it("treats a status set the same day as the email as not newer", () => {
    expect(decideTransition("applied", "rejection", "2026-09-16T22:00:00Z", "2026-09-16T09:00:00Z")).toEqual({
      action: "apply",
      to: "closed",
    });
  });
});

describe("statusRank", () => {
  it("orders the stages, with every terminal status last", () => {
    expect(statusRank("packet_ready")).toBeLessThan(statusRank("applied"));
    expect(statusRank("applied")).toBeLessThan(statusRank("interviewing"));
    expect(statusRank("interviewing")).toBeLessThan(statusRank("offer"));
    expect(statusRank("offer")).toBeLessThan(statusRank("closed"));
    expect(statusRank("not_pursuing")).toBe(statusRank("closed"));
  });
});
