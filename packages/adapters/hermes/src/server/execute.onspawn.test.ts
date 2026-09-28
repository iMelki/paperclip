/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  realpath: vi.fn(async (input: string) => input),
  lstat: vi.fn(async (input: string) => ({
    isFile: () => input.endsWith("profile.yaml"),
    isSymbolicLink: () => false,
  })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("pins a strict named profile, scrubs host credentials, and never passes --yolo", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "host-only-canary";
    try {
      const hermesHome = path.join(os.tmpdir(), "paperclip-hermes-strict-fixture");
      const { ctx } = makeCtx({
        strictIsolation: true,
        hermesHome,
        hermesProfile: "research",
        hermesCommand: path.join(hermesHome, "bin", "hermes"),
        paperclipApiUrl: "http://127.0.0.1:3100/api",
        model: "gpt-5.5",
        provider: "openai-codex",
        timeoutSec: 900,
        maxTurnsPerRun: 3,
        persistSession: false,
      });
      await execute(ctx as any);
      const [,, args, opts] = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
      expect(args.slice(0, 3)).toEqual(["--profile", "research", "chat"]);
      expect(args).not.toContain("--yolo");
      expect(opts.timeoutSec).toBe(900);
      expect(opts.env.HERMES_HOME).toBe(hermesHome);
      expect(opts.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("starts a fresh strict session with the full brief when stale runtime state has a session ID", async () => {
    const hermesHome = path.join(os.tmpdir(), "paperclip-hermes-strict-fixture");
    const { ctx } = makeCtx({
      strictIsolation: true,
      hermesHome,
      hermesProfile: "research",
      hermesCommand: path.join(hermesHome, "bin", "hermes"),
      paperclipApiUrl: "http://127.0.0.1:3100/api",
      model: "gpt-5.5",
      provider: "openai-codex",
      timeoutSec: 900,
      maxTurnsPerRun: 3,
      persistSession: false,
    });
    const staleCtx = {
      ...ctx,
      runtime: { ...ctx.runtime, sessionParams: { sessionId: "prior-session" } },
      context: {
        ...ctx.context,
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "issue-1", identifier: "ASS-1", title: "Continue the task", status: "in_progress" },
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          comments: [{ id: "comment-1", body: "Please continue.", createdAt: "2026-09-28T00:00:00.000Z" }],
          fallbackFetchNeeded: false,
        },
        paperclipTaskMarkdown: "Full task brief with the issue description.",
        paperclipTaskMarkdownCompact: "Compact task brief without the description.",
      },
    };

    await execute(staleCtx as any);

    const [,, args] = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    const prompt = args[args.indexOf("-q") + 1];
    expect(args).not.toContain("--resume");
    expect(prompt).toContain("Full task brief with the issue description.");
    expect(prompt).not.toContain("Compact task brief without the description.");
    expect(prompt).not.toContain("## Paperclip Resume Delta");
    expect(staleCtx.onLog).not.toHaveBeenCalledWith(
      "stdout", expect.stringContaining("Resuming session"),
    );
  });

  it.each(["--yolo", "--yol", "--yol=1"])(
    "rejects extraArgs approval bypass %s before spawn",
    async (flag) => {
      const { ctx } = makeCtx({ extraArgs: [flag] });
      await expect(execute(ctx as any)).rejects.toThrow(/forbids --yolo/);
      expect(serverUtils.runChildProcess).not.toHaveBeenCalled();
    },
  );

  it("scrubs every case variant of the YOLO environment override", async () => {
    const { ctx } = makeCtx({
      env: { hermes_yolo_mode: "1", HeRmEs_YoLo_MoDe: "1" },
    });
    await execute(ctx as any);
    const [,,, opts] = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(Object.keys(opts.env).filter((key) => key.toUpperCase() === "HERMES_YOLO_MODE"))
      .toEqual([]);
  });
});
