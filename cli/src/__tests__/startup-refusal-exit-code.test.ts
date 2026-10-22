import { describe, expect, it } from "vitest";
import { startupRefusalExitCode } from "../commands/run.js";

function refusal(exitCode: unknown): Error {
  const err = new Error("An existing PostgreSQL may own the data directory");
  err.name = "EmbeddedPostgresLockRefusal";
  Object.assign(err, { exitCode });
  return err;
}

describe("startupRefusalExitCode", () => {
  it("carries the server's lock-refusal exit code across the CLI boundary", () => {
    expect(startupRefusalExitCode(refusal(75))).toBe(75);
  });

  it("falls back to the generic failure code for other errors and malformed codes", () => {
    expect(startupRefusalExitCode(new Error("boom"))).toBeNull();
    expect(startupRefusalExitCode("EmbeddedPostgresLockRefusal")).toBeNull();
    for (const bad of [0, 256, 1.5, "75", undefined]) {
      expect(startupRefusalExitCode(refusal(bad))).toBeNull();
    }
  });
});
