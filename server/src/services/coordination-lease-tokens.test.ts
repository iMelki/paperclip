import { describe, expect, it } from "vitest";
import { hashCoordinationLeaseToken, verifyCoordinationLeaseToken } from "./coordination-lease-tokens.js";

describe("coordination lease token hashing", () => {
  it("stores a deterministic SHA-256 digest instead of the bearer token", () => {
    const token = "coordination-lease-secret";
    const hash = hashCoordinationLeaseToken(token);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(verifyCoordinationLeaseToken(token, hash)).toBe(true);
    expect(verifyCoordinationLeaseToken("wrong-token", hash)).toBe(false);
  });

  it("fails closed for empty tokens and malformed stored hashes", () => {
    expect(() => hashCoordinationLeaseToken("")).toThrow("must not be empty");
    expect(verifyCoordinationLeaseToken("token", "not-a-sha256-hash")).toBe(false);
    expect(verifyCoordinationLeaseToken("", "a".repeat(64))).toBe(false);
  });
});
