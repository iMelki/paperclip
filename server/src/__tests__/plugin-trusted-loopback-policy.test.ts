import { describe, expect, it } from "vitest";
import {
  getTrustedLoopbackHttpRules,
  parseTrustedLoopbackHttpRules,
  resolveTrustedLoopbackFetchTarget,
  setTrustedLoopbackHttpRules,
  TrustedLoopbackHttpPolicyError,
} from "../services/plugin-trusted-loopback-policy.js";

const rules = parseTrustedLoopbackHttpRules([
  {
    method: "post",
    origin: "http://127.0.0.1:3021",
    pathnamePattern: "/api/callbacks/*",
  },
  {
    method: "GET",
    origin: "http://[::1]:5114",
    pathnamePattern: "/health",
  },
]);

describe("trusted loopback HTTP policy", () => {
  it("normalizes methods and matches one whole-segment wildcard", () => {
    expect(rules[0]?.method).toBe("POST");
    expect(resolveTrustedLoopbackFetchTarget({
      url: "http://127.0.0.1:3021/api/callbacks/run-1",
      method: "POST",
      rules,
    })).toMatchObject({
      resolvedAddress: "127.0.0.1",
      hostHeader: "127.0.0.1:3021",
      useTls: false,
    });
  });

  it("matches an exact IPv6 loopback rule", () => {
    expect(resolveTrustedLoopbackFetchTarget({
      url: "http://[::1]:5114/health",
      method: "GET",
      rules,
    })).toMatchObject({
      resolvedAddress: "::1",
      hostHeader: "[::1]:5114",
      useTls: false,
    });
  });

  it("returns null for undeclared loopback, method mismatch, and public URLs", () => {
    expect(resolveTrustedLoopbackFetchTarget({
      url: "http://127.0.0.1:3021/api/other/run-1",
      method: "POST",
      rules,
    })).toBeNull();
    expect(resolveTrustedLoopbackFetchTarget({
      url: "http://127.0.0.1:3021/api/callbacks/",
      method: "POST",
      rules,
    })).toBeNull();
    expect(resolveTrustedLoopbackFetchTarget({
      url: "http://127.0.0.1:3021/api/callbacks/run-1",
      method: "GET",
      rules,
    })).toBeNull();
    expect(resolveTrustedLoopbackFetchTarget({
      url: "https://example.com/api/callbacks/run-1",
      method: "POST",
      rules,
    })).toBeNull();
  });

  it.each([
    ["localhost aliases", { method: "GET", origin: "http://localhost:3021", pathnamePattern: "/health" }],
    ["missing ports", { method: "GET", origin: "http://127.0.0.1", pathnamePattern: "/health" }],
    ["credentials", { method: "GET", origin: "http://user@127.0.0.1:3021", pathnamePattern: "/health" }],
    ["queries", { method: "GET", origin: "http://127.0.0.1:3021?x=1", pathnamePattern: "/health" }],
    ["fragments", { method: "GET", origin: "http://127.0.0.1:3021#x", pathnamePattern: "/health" }],
    ["partial wildcards", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/run-*" }],
    ["multiple wildcards", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/*/*" }],
    ["dot segments", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/../health" }],
    ["encoded wildcards", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/%2A" }],
    ["nested encoded wildcards", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/%252A" }],
    ["encoded dot segments", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/%2e%2e/health" }],
    ["encoded separators", { method: "GET", origin: "http://127.0.0.1:3021", pathnamePattern: "/api/%2fhealth" }],
  ])("rejects %s in operator-authored rules", (_label, rule) => {
    expect(() => parseTrustedLoopbackHttpRules([rule])).toThrow(
      TrustedLoopbackHttpPolicyError,
    );
  });

  it.each([
    "http://127.0.0.1:3021/health?verbose=1",
    "http://127.0.0.1:3021/health#details",
    "http://127.0.0.1:3021/api/../health",
    "http://127.0.0.1:3021/api/%2e%2e/health",
    "http://127.0.0.1:3021/api/%2A",
    "http://127.0.0.1:3021/api/%252A",
    "http://127.0.0.1:3021/api/%252fhealth",
    "http://127.0.0.1:3021/api/%2525252525252525252fhealth",
    "http://127.0.0.1:3021/api\\health",
  ])("rejects ambiguous or transformable loopback request path %s", (url) => {
    expect(() => resolveTrustedLoopbackFetchTarget({
      url,
      method: "GET",
      rules: [{
        method: "GET",
        origin: "http://127.0.0.1:3021",
        pathnamePattern: "/health",
      }],
    })).toThrow(TrustedLoopbackHttpPolicyError);
  });

  it("preserves unrelated host and plugin settings when rules are updated", () => {
    const next = setTrustedLoopbackHttpRules({
      pluginOwned: { value: 1 },
      __paperclipHost: { anotherHostSetting: true },
    }, rules);

    expect(next).toMatchObject({
      pluginOwned: { value: 1 },
      __paperclipHost: {
        anotherHostSetting: true,
        trustedLoopbackHttpRules: rules,
      },
    });
    expect(getTrustedLoopbackHttpRules(next)).toEqual(rules);
  });
});
