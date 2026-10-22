import { describe, expect, it } from "vitest";
import {
  requestPathForHttpLog,
  shouldOmitHttpRequestBody,
  shouldSilenceHttpSuccessLog,
} from "../middleware/http-log-policy.js";

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 304)).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/index.html", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("PATCH", "/api/issues/PAP-1383", 200)).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 404)).toBe(false);
  });
});

describe("HTTP sensitive request logging policy", () => {
  it.each([
    "/api/auth/sign-in/email",
    "/api/board-claim/challenge-secret/claim",
    "/api/cli-auth/challenges/challenge-id/approve",
    "/api/agents/me/secrets/API_KEY/value",
    "/api/companies/company-id/me/user-secrets",
    "/api/companies/company-id/secret-provider-configs",
    "/api/companies/company-id/secret-proposals/proposal-id/approve",
    "/API/companies/company-id/SECRETS",
  ])("omits the complete request body for credential route %s", (url) => {
    expect(shouldOmitHttpRequestBody(url)).toBe(true);
  });

  it("keeps ordinary application request bodies eligible for structural redaction", () => {
    expect(shouldOmitHttpRequestBody("/api/issues/issue-id")).toBe(false);
  });

  it("removes claim query and path credentials from the log path", () => {
    expect(requestPathForHttpLog("/api/board-claim/challenge-secret/claim?code=123456"))
      .toBe("/api/board-claim/[REDACTED]/claim");
    expect(requestPathForHttpLog("/API/Board-Claim/challenge-secret/claim"))
      .toBe("/API/Board-Claim/[REDACTED]/claim");
  });
});
