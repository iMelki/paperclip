import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { execute, testEnvironment } from "@paperclipai/adapter-cursor-local/server";

async function writeFakeAgentCommand(binDir: string, argsCapturePath: string): Promise<string> {
  const commandPath = path.join(binDir, "agent");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.PAPERCLIP_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(process.argv.slice(2)), "utf8");
}
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "hello",
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function writeFakeCursorAgentCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const outPath = process.env.PAPERCLIP_TEST_ARGS_PATH;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    command: process.argv[1],
    argv: process.argv.slice(2),
    path: process.env.PATH || "",
  }), "utf8");
}
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "output_text", text: "hello" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result: "hello",
}));
`;
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

function toShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match) return value.replace(/\\/g, "/");
  const [, drive, rest] = match;
  return `/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

function fromShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const driveMatch = /^\/([A-Za-z])\/(.*)$/.exec(value);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `${drive.toUpperCase()}:\\${rest.replace(/\//g, "\\")}`;
  }
  if (value.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), value.slice("/tmp/".length).replace(/\//g, path.sep));
  }
  return value;
}

function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      const command = fromShellPath(input.command);
      const cwd = fromShellPath(input.cwd ?? process.cwd());
      return await runChildProcess(`cursor-sandbox-env-${counter}`, command, input.args ?? [], {
        cwd,
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
}

describe("cursor environment diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("CURSOR_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-cursor-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "cursor_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("does not add --yolo or -f to hello probe args when extraArgs are empty", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeAgentCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        command: "agent",
        cwd,
        env: {
          CURSOR_API_KEY: "test-key",
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("--trust");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("-f");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not add --yolo or -f to execute args when extraArgs are empty", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-local-execute-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const homeDir = path.join(root, "home");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    await writeFakeAgentCommand(binDir, argsCapturePath);

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    let commandArgs: string[] = [];
    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-cursor-trust-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Cursor",
          adapterType: "cursor",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "agent",
          cwd,
          promptTemplate: "Respond with hello.",
          env: {
            CURSOR_API_KEY: "test-key",
            PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
        context: {},
        onLog: async () => {},
        onMeta: async (meta) => {
          commandArgs = Array.isArray(meta.commandArgs) ? meta.commandArgs : [];
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(commandArgs).toContain("--trust");
      expect(commandArgs).not.toContain("--yolo");
      expect(commandArgs).not.toContain("-f");
      expect(commandNotes.some((note) => note.includes("Auto-added --trust"))).toBe(true);
      expect(commandNotes.some((note) => note.includes("--yolo"))).toBe(false);
      const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
      expect(args).toContain("--trust");
      expect(args).not.toContain("--yolo");
      expect(args).not.toContain("-f");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not auto-add --trust when extraArgs already bypass trust", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-local-probe-extra-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeAgentCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        command: "agent",
        cwd,
        extraArgs: ["--yolo"],
        env: {
          CURSOR_API_KEY: "test-key",
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--trust");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not auto-add a second --trust when extraArgs already include --trust", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-local-probe-trust-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const argsCapturePath = path.join(root, "args.json");
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeAgentCommand(binDir, argsCapturePath);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "cursor",
      config: {
        command: "agent",
        cwd,
        extraArgs: ["--trust"],
        env: {
          CURSOR_API_KEY: "test-key",
          PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });

    expect(result.status).toBe("pass");
    const args = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as string[];
    expect(args.filter((arg) => arg === "--trust")).toHaveLength(1);
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("-f");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("prefers ~/.local/bin/cursor-agent for remote sandbox probes when using the default command", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-sandbox-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const homeDir = path.join(root, "home");
    const remoteCwdLocal = path.join(root, "workspace");
    const remoteCwd = toShellPath(remoteCwdLocal);
    const argsCapturePath = path.join(root, "args.json");
    const cursorAgentPath = path.join(homeDir, ".local", "bin", "cursor-agent");
    await fs.mkdir(remoteCwdLocal, { recursive: true });
    await writeFakeCursorAgentCommand(cursorAgentPath);

    const previousHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "cursor",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd,
          runner: createLocalSandboxRunner(),
          timeoutMs: 30_000,
        },
        config: {
          command: "agent",
          cwd: remoteCwd,
          env: {
            CURSOR_API_KEY: "test-key",
            PAPERCLIP_TEST_ARGS_PATH: argsCapturePath,
          },
        },
      });

      expect(result.status).toBe("pass");
      const capture = JSON.parse(await fs.readFile(argsCapturePath, "utf8")) as {
        command: string;
        argv: string[];
        path: string;
      };
      expect(capture.command).toBe(cursorAgentPath);
      const expectedSandboxLocalBin = process.platform === "win32"
        ? `/tmp/${path.basename(root)}/home/.local/bin`
        : path.join(homeDir, ".local", "bin");
      expect(capture.path).toContain(`${expectedSandboxLocalBin}:`);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits cursor_native_auth_present when cli-config.json has authInfo and CURSOR_API_KEY is unset", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const cursorHome = path.join(root, ".cursor");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(cursorHome, { recursive: true });
      await fs.writeFile(
        path.join(cursorHome, "cli-config.json"),
        JSON.stringify({
          authInfo: {
            email: "test@example.com",
            displayName: "Test User",
            userId: 12345,
          },
        }),
      );

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "cursor",
        config: {
          command: process.execPath,
          cwd,
          env: { CURSOR_HOME: cursorHome },
        },
      });

      expect(result.checks.some((check) => check.code === "cursor_native_auth_present")).toBe(true);
      expect(result.checks.some((check) => check.code === "cursor_api_key_missing")).toBe(false);
      const authCheck = result.checks.find((check) => check.code === "cursor_native_auth_present");
      expect(authCheck?.detail).toContain("test@example.com");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits cursor_api_key_missing when neither env var nor native auth exists", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-cursor-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const cursorHome = path.join(root, ".cursor");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(cursorHome, { recursive: true });
      // No cli-config.json written

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "cursor",
        config: {
          command: process.execPath,
          cwd,
          env: { CURSOR_HOME: cursorHome },
        },
      });

      expect(result.checks.some((check) => check.code === "cursor_api_key_missing")).toBe(true);
      expect(result.checks.some((check) => check.code === "cursor_native_auth_present")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
