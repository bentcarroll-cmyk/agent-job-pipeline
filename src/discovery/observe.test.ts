import { expect, it } from "vitest";
import { observedUrl, pageErrorCode } from "./observe";
import { parseJobUrl } from "../unbounded/discovery";
it("keeps job identity while removing tracking and secret-like parameters", () => {
  expect(observedUrl("https://careers.fixture.test/apply?jobSeqNo=R17&utm_source=x&token=synthetic#form"))
    .toBe("https://careers.fixture.test/apply?jobSeqNo=R17");
});
it("retains unregistered employer URLs without promoting URL shape to job identity", () => {
  const url = "https://careers.fixture.test/jobs/engineering-17";
  expect(observedUrl(url)).toBe(url);
  expect(parseJobUrl(url, "Engineering manager")).toBeNull();
});
it("classifies blocked, throttled, timeout and malformed attempts separately", () => {
  expect(pageErrorCode("Blocked: HTTP 403", null)).toBe("http_403");
  expect(pageErrorCode("serper: HTTP 429", 429)).toBe("http_429");
  expect(pageErrorCode("request timed out", null)).toBe("timeout");
  expect(pageErrorCode("missing or invalid organic results", null)).toBe("malformed_response");
});
