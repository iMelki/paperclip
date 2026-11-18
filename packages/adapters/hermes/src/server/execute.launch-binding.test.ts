/**
 * What hermes_local binds before it starts the child process.
 *
 * The run token travels to the Paperclip API URL and the model receives the agent's instructions, so
 * both must be known and checked: a loopback-only API URL used identically in the prompt and the
 * environment, a real model and provider that extra arguments cannot override, no run key on any
 * command line or in any log, and no stray case variant of a reserved credential in the environment.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" })),
  };
});

import { assertNoCompetingLaunchFlags, buildPrompt, execute, isAutoModel } from "./execute.js";
import { resolveConfiguredApiUrl } from "./api-url.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const MODEL = "anthropic/claude-haiku-5.5";
const DUMMY_KEY = "dummy-run-key-7f3a91";

function makeCtx(config: Record<string, unknown>, authToken: string | null = DUMMY_KEY) {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      runId: "run-binding-1",
      authToken,
      agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: process.execPath, model: MODEL, provider: "openrouter", timeoutSec: 60, graceSec: 5, ...config },
      context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
      onLog: vi.fn(async (_stream: string, chunk: string) => { logs.push(chunk); }),
      onMeta: vi.fn(async () => undefined),
      onSpawn: vi.fn(async () => undefined),
    },
  };
}

function lastSpawn() {
  const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[calls.length - 1];
  return { args: call[2] as string[], env: (call[3] as { env: Record<string, string> }).env };
}
const neverStarted = () => expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();

describe("the configured Paperclip API URL must be loopback", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["a public host", "https://paperclip.example/api"],
    ["a tailnet host", "http://box.tailnet.example:3100"],
    ["embedded credentials", "http://user:hunter2@127.0.0.1:3100"],
    ["a query string", "http://127.0.0.1:3100/?token=abc"],
    ["a fragment", "http://127.0.0.1:3100/#frag"],
    ["a non-HTTP scheme", "ftp://127.0.0.1:3100"],
    ["a lookalike host", "http://127.0.0.1.evil.example:3100"],
    ["an unrelated path", "http://127.0.0.1:3100/other"],
    ["not a URL", "not a url"],
  ])("refuses %s before any child process, and never echoes the URL", async (_label, url) => {
    const { ctx, logs } = makeCtx({ paperclipApiUrl: url });
    const failure = await execute(ctx as never).then(() => null, (err: Error) => err);
    expect(failure?.message).toMatch(/paperclipApiUrl/);
    expect(failure?.message).not.toContain("hunter2");
    expect(logs.join("")).not.toContain("hunter2");
    neverStarted();
  });

  it.each([
    ["http://127.0.0.1:5113", "http://127.0.0.1:5113"],
    ["http://127.0.0.1:5113/", "http://127.0.0.1:5113"],
    ["http://localhost:3100/api", "http://localhost:3100"],
    ["http://[::1]:3100", "http://[::1]:3100"],
  ])("accepts %s: the child variable is the bare origin, the prompt shows the /api base", async (url, origin) => {
    const { ctx } = makeCtx({ paperclipApiUrl: url });
    await execute(ctx as never);
    const { args, env } = lastSpawn();
    // Like every other adapter and the shared skill: PAPERCLIP_API_URL is the origin, paths add /api.
    expect(env.PAPERCLIP_API_URL).toBe(origin);
    expect(env.PAPERCLIP_API_URL.endsWith("/api")).toBe(false);
    expect(args[args.indexOf("-q") + 1]).toContain(`- API base: ${origin}/api`);
  });

  it("buildPrompt refuses a non-loopback override too (it is exported)", () => {
    expect(() => buildPrompt(makeCtx({}).ctx as never, { paperclipApiUrl: "https://paperclip.example/api" })).toThrow(/loopback/);
  });

  it("resolveConfiguredApiUrl returns null when nothing is configured", () => {
    expect(resolveConfiguredApiUrl(undefined)).toBeNull();
    expect(resolveConfiguredApiUrl("   ")).toBeNull();
  });
});

describe("the effective model and provider are bound", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["auto", "AUTO", " auto ", "openrouter/auto", "OpenRouter/Auto", "openrouter/auto:nitro"])(
    "treats %j as an auto router", (model) => expect(isAutoModel(model)).toBe(true),
  );
  it.each([MODEL, "anthropic/claude-sonnet-5.5", "z-ai/glm-5.3", "autopilot-model"])(
    "treats %j as an explicit model", (model) => expect(isAutoModel(model)).toBe(false),
  );

  it("refuses a provider that cannot be bound", async () => {
    await expect(execute(makeCtx({ provider: "auto", model: "unknownvendor-model" }).ctx as never)).rejects.toThrow(/provider/);
    neverStarted();
  });

  it.each([
    ["-m", ["-m", "other/model"]],
    ["--model", ["--model", "other/model"]],
    ["--model=value", ["--model=other/model"]],
    ["an argparse prefix of --model", ["--mod", "other/model"]],
    ["--provider", ["--provider", "openrouter"]],
    ["--provider=value", ["--provider=custom"]],
    ["a prefix of --provider", ["--prov", "custom"]],
    ["--profile", ["--profile", "other"]],
    ["-p", ["-p", "other"]],
    ["a short-flag cluster ending in m", ["-Qm", "other/model"]],
  ])("refuses a competing %s in extraArgs, before any child process", async (_label, extraArgs) => {
    await expect(execute(makeCtx({ extraArgs }).ctx as never)).rejects.toThrow(/extraArgs/);
    neverStarted();
  });

  it("still allows harmless extra arguments", () => {
    expect(() => assertNoCompetingLaunchFlags(["--max-turns", "5", "--checkpoints", "-v"])).not.toThrow();
    expect(() => assertNoCompetingLaunchFlags(undefined)).not.toThrow();
  });

  it("passes exactly one model flag and one provider flag", async () => {
    await execute(makeCtx({}).ctx as never);
    const { args } = lastSpawn();
    expect(args.filter((arg) => arg === "-m")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--provider")).toHaveLength(1);
  });
});

describe("the run key never reaches a command line or a log", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is in the child environment only, not in argv, the prompt or any log line", async () => {
    const { ctx, logs } = makeCtx({});
    await execute(ctx as never);
    const { args, env } = lastSpawn();
    expect(env.PAPERCLIP_API_KEY).toBe(DUMMY_KEY);
    expect(args.join("\n")).not.toContain(DUMMY_KEY);
    expect(logs.join("")).not.toContain(DUMMY_KEY);
  });

  it("strips every case variant of the reserved credentials, then injects the trusted key once", async () => {
    const { ctx } = makeCtx({ env: {
      paperclip_api_key: "stale-lower", Paperclip_Api_Key: "stale-mixed", hermes_yolo_mode: "1", HERMES_YOLO_MODE: "1",
    } });
    await execute(ctx as never);
    const { env } = lastSpawn();
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PAPERCLIP_API_KEY");
    expect(keys).toEqual(["PAPERCLIP_API_KEY"]);
    expect(env.PAPERCLIP_API_KEY).toBe(DUMMY_KEY);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "HERMES_YOLO_MODE")).toEqual([]);
  });

  it("without a run token no case variant of the key survives", async () => {
    const { ctx } = makeCtx({ env: { Paperclip_Api_Key: "stale-mixed" } }, null);
    await execute(ctx as never);
    expect(Object.keys(lastSpawn().env).filter((key) => key.toUpperCase() === "PAPERCLIP_API_KEY")).toEqual([]);
  });
});


const bashAvailable = spawnSync("bash", ["-c", "command -v mktemp printf >/dev/null"], { encoding: "utf8" }).status === 0;
const slash = (value: string) => value.split(String.fromCharCode(92)).join("/");

describe.skipIf(!bashAvailable)("the documented API call keeps the run key out of argv", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paperclip-hermes-argv-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  /** Runs a documented snippet with recording curl and jq shims; returns what curl was asked to send. */
  async function runSnippet(snippet: string, apiUrl: string) {
    const argvLog = path.join(dir, "argv.log");
    const headerLog = path.join(dir, "headers.log");
    await fs.mkdir(path.join(dir, "bin"), { recursive: true });
    // curl shim: record every argument; for -H @file also record the file's content (what real curl would send).
    await fs.writeFile(path.join(dir, "bin", "curl"), [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\n' "$a" >> '${slash(argvLog)}'; done`,
      "prev=''",
      `for a in "$@"; do case "$prev" in -H) case "$a" in @*) cat "\${a#@}" >> '${slash(headerLog)}';; esac;; esac; prev="$a"; done`,
      "cat >/dev/null",
    ].join("\n"), { mode: 0o755 });
    await fs.writeFile(path.join(dir, "bin", "jq"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    const result = spawnSync("bash", ["-c", snippet], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        PAPERCLIP_API_URL: apiUrl,
        PAPERCLIP_API_KEY: DUMMY_KEY,
        PAPERCLIP_RUN_ID: "run-binding-1",
      },
    });
    return {
      result,
      argv: await fs.readFile(argvLog, "utf8").catch(() => ""),
      headers: await fs.readFile(headerLog, "utf8").catch(() => ""),
    };
  }

  it("the prompt's example: dummy key absent from argv, present in the header file, no doubled /api", async () => {
    const { ctx } = makeCtx({});
    const prompt = buildPrompt(ctx as never, { paperclipApiUrl: "http://127.0.0.1:5113/api" });
    const snippet = prompt.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(snippet).toBeTruthy();
    const { result, argv, headers } = await runSnippet(snippet!, "http://127.0.0.1:5113");
    expect(result.status, result.stderr).toBe(0);
    expect(argv).not.toContain(DUMMY_KEY);
    expect(result.stdout + result.stderr).not.toContain(DUMMY_KEY);
    expect(headers).toContain(`Authorization: Bearer ${DUMMY_KEY}`);
    expect(headers).toContain("X-Paperclip-Run-Id: run-binding-1");
    expect(argv).toContain("http://127.0.0.1:5113/api/issues/issue-1");
    expect(argv).not.toContain("/api/api");
  });

  const skillSnippet = readFileSync(new URL("../../../../../skills/paperclip/SKILL.md", import.meta.url), "utf8")
    .match(/```bash\n(hdr=[\s\S]*?)\n```/)?.[1];

  it.each([
    ["the bare origin every adapter sets", "http://127.0.0.1:5113"],
    ["an origin that already ends in /api", "http://127.0.0.1:5113/api"],
  ])("the shared skill's example builds the right URL from %s, with the key out of argv", async (_label, apiUrl) => {
    expect(skillSnippet).toBeTruthy();
    const { result, argv, headers } = await runSnippet(skillSnippet!, apiUrl);
    expect(result.status, result.stderr).toBe(0);
    expect(argv).toContain("http://127.0.0.1:5113/api/agents/me");
    expect(argv).not.toContain("/api/api");
    expect(argv).not.toContain(DUMMY_KEY);
    expect(headers).toContain(`Authorization: Bearer ${DUMMY_KEY}`);
  });
});
