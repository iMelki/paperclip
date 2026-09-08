import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(resolve(process.cwd(), "server/src/__tests__/forbidden-tokens.test.ts"));
const {
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  runForbiddenTokenCheck,
} = require(resolve(process.cwd(), "scripts/check-forbidden-tokens-core.cjs"));

describe("forbidden token check", () => {
  it("derives username tokens without relying on whoami", () => {
    const tokens = resolveDynamicForbiddenTokens(
      { USER: "paperclip", LOGNAME: "paperclip", USERNAME: "pc" },
      {
        userInfo: () => ({ username: "paperclip" }),
      },
    );

    expect(tokens).toEqual(["paperclip", "pc"]);
  });

  it("falls back cleanly when user resolution fails", () => {
    const tokens = resolveDynamicForbiddenTokens(
      {},
      {
        userInfo: () => {
          throw new Error("missing user");
        },
      },
    );

    expect(tokens).toEqual([]);
  });

  it("merges dynamic and file-based forbidden tokens", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tokensFile = path.join(os.tmpdir(), `forbidden-tokens-${Date.now()}.txt`);
    fs.writeFileSync(tokensFile, "# comment\npaperclip\ncustom-token\n");

    try {
      const tokens = resolveForbiddenTokens(tokensFile, { USER: "paperclip" }, {
        userInfo: () => ({ username: "paperclip" }),
      });

      expect(tokens).toEqual(["paperclip", "custom-token"]);
    } finally {
      fs.unlinkSync(tokensFile);
    }
  });

  it("reports matches without leaking which token was searched", () => {
    const grep = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "server/file.ts:1:found\n" })
      .mockReturnValue({ status: 1, stdout: "" });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["paperclip", "custom-token"],
      grep,
      log,
      error,
    });

    expect(exitCode).toBe(1);
    expect(grep).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("ERROR: Forbidden tokens found in tracked files:\n");
    expect(error).toHaveBeenCalledWith("  server/file.ts:1:found");
    expect(error).toHaveBeenCalledWith("\nBuild blocked. Remove the forbidden token(s) before publishing.");
  });

  it("treats git exit 1 as a clean tree, not an error", () => {
    const grep = vi.fn().mockReturnValue({ status: 1, stdout: "" });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["a"], grep, log, error });

    expect(exitCode).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });

  // Regression: the scan used to run through cmd.exe, which left single quotes on
  // the pathspecs, so git aborted with 128 on every call and the catch-all read it
  // as "no matches". The check passed unconditionally on every Windows host.
  // A scan that did not run must never be reported as a scan that found nothing.
  it("fails closed when git aborts instead of reporting no matches", () => {
    const grep = vi.fn().mockReturnValue({ status: 128, stdout: "" });
    const log = vi.fn();
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({ repoRoot: "/repo", tokens: ["a"], grep, log, error });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "ERROR: forbidden-token scan did not run (git exited 128).",
    );
    expect(log).not.toHaveBeenCalledWith("  ✓  No forbidden tokens found.");
  });

  it("fails closed when the git process never produced an exit status", () => {
    const grep = vi.fn().mockReturnValue({ status: null, stdout: "" });
    const error = vi.fn();

    const exitCode = runForbiddenTokenCheck({
      repoRoot: "/repo",
      tokens: ["a"],
      grep,
      log: vi.fn(),
      error,
    });

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "ERROR: forbidden-token scan did not run (git exited abnormally).",
    );
  });

  // The bug was invisible to every mocked test because no mock reproduced the
  // real shell. This exercises the real git binary against the real repo: it must
  // return a usable status (0 or 1), never an abort.
  it("actually runs git against this repo (no shell quoting in the path)", async () => {
    const { gitGrepToken } = require(
      resolve(process.cwd(), "scripts/check-forbidden-tokens-core.cjs"),
    ) as { gitGrepToken: (o: { token: string; repoRoot: string }) => { status: number | null } };

    const result = gitGrepToken({ token: "paperclip", repoRoot: process.cwd() });

    expect([0, 1]).toContain(result.status);
  });
});
