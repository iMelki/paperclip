import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("runChildProcess environment inheritance", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function probe(inheritEnv?: boolean, explicitKey?: string) {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID"]) {
      vi.stubEnv(key, "synthetic-ambient-only-canary");
    }
    const code = [
      "const env = process.env;",
      "console.log(JSON.stringify({",
      "openai: env.OPENAI_API_KEY === 'synthetic-ambient-only-canary',",
      "anthropic: env.ANTHROPIC_API_KEY === 'synthetic-ambient-only-canary',",
      "aws: env.AWS_ACCESS_KEY_ID === 'synthetic-ambient-only-canary',",
      "explicit: env.OPENAI_API_KEY === 'synthetic-explicit-only-canary'",
      "}));",
    ].join("\n");
    const result = await runChildProcess("environment-fixture", process.execPath, ["-e", code], {
      cwd: os.tmpdir(),
      env: { PATH: path.dirname(process.execPath), ...(explicitKey ? { OPENAI_API_KEY: explicitKey } : {}) },
      inheritEnv,
      timeoutSec: 3,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    return JSON.parse(result.stdout.trim());
  }

  it("preserves inherited environment by default for existing callers", async () => {
    expect(await probe()).toEqual({ openai: true, anthropic: true, aws: true, explicit: false });
  });

  it("does not restore omitted ambient provider keys when inheritance is disabled", async () => {
    expect(await probe(false)).toEqual({ openai: false, anthropic: false, aws: false, explicit: false });
  });

  it("preserves explicitly supplied keys without importing other ambient providers", async () => {
    expect(await probe(false, "synthetic-explicit-only-canary"))
      .toEqual({ openai: false, anthropic: false, aws: false, explicit: true });
  });
});
