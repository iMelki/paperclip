import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import {
  ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS,
  PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
  PAPERCLIP_EXECUTION_TARGET_INVALID,
  AdapterExecutionTargetProcessSessionLaunchAmbiguousError,
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  issuePaperclipCallbackBridgeTestCapability,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
  type AdapterExecutionTargetPaperclipBridgeHandle,
} from "@paperclipai/adapter-utils/execution-target";

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations (a runner-backed sandbox test
// exercises them end-to-end against a local runner). This lets the staging
// tests assert the exact `runtimeRootDir`/`workspaceLocalDir`/`assets` the
// engine threads without changing any real behavior for the other tests.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(actual.startAdapterExecutionTargetPaperclipBridge),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(actual.startAdapterExecutionTargetProcessSessionBridge),
  };
});
import {
  createAcpxEngineExecutor as createAcpxEngineExecutorImpl,
  findAncestorBin,
  geminiVersionSupportsNativeAcpFlag,
  parseGeminiVersionParts,
  rewriteGeminiAcpFlagForVersion,
  reconcileAndReleaseAcpxProcessSessionLaunchResources,
  requestStopAndWaitAcpxProcessSessionLaunch,
  summarizeAcpxTurnUsage,
  type AcpxEngineExecutorOptions,
} from "./execute.js";
import { runChildProcess } from "../server-utils.js";
import { resolveTestShellCommand } from "../test-shell.js";


const tempRoots: string[] = [];
const invocationClaudeSettingsPath = path.resolve(".claude", "settings.local.json");
let invocationClaudeSettingsBefore: Buffer | null = null;
let defaultRunExecutorWorkspace: { cwd: string; stateDir: string } | null = null;
const paperclipCallbackBridgeTestCapability = issuePaperclipCallbackBridgeTestCapability();
// The local POSIX shell fixture is authoritative on POSIX. On native Windows,
// Git Bash `$!` is an MSYS pid while the wrapper receipt is a native Node pid;
// Node's native `process.kill(pid, 0)` therefore cannot prove the advertised
// launcher/wrapper tree. Keep the real lifecycle coverage mandatory in Ubuntu
// CI, but never claim provider process-tree custody from this Windows fixture.
const itPosixSandboxLifecycle = process.platform === "win32" ? it.skip : it;
const describePosixSandboxLifecycle = process.platform === "win32" ? describe.skip : describe;

function createAcpxEngineExecutor(
  options: AcpxEngineExecutorOptions = {},
) {
  return createAcpxEngineExecutorImpl({
    ...options,
    testOnlyEnableRemoteProcessSessionReleaseProtocol: true,
    testOnlyPaperclipCallbackBridgeCapability: paperclipCallbackBridgeTestCapability,
  });
}

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

function localTestProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

function paperclipBridgeHandleFixture(input: {
  runId: string;
  remoteCwd: string;
  env?: Record<string, string>;
  stop: () => Promise<void>;
}): AdapterExecutionTargetPaperclipBridgeHandle {
  const instanceId = "00000000-0000-4000-8000-000000000041";
  const instanceDir = path.posix.join(
    input.remoteCwd,
    ".paperclip-runtime",
    "acpx",
    "paperclip-bridge",
    "instances",
    instanceId,
  );
  return {
    env: input.env ?? {},
    launchIdentity: {
      runId: input.runId,
      adapterKey: "custom_local",
      instanceId,
      instanceNonce: instanceId,
      transport: "sandbox",
      providerKey: "local-test",
      environmentId: "environment-1",
      leaseId: "lease-1",
      remoteCwd: input.remoteCwd,
      instanceDir,
      queueDir: path.posix.join(instanceDir, "queue"),
      assetRemoteDir: path.posix.join(instanceDir, "server"),
      manifestPath: path.posix.join(instanceDir, "instance.json"),
    },
    processIdentity: {
      schema: "paperclip-sandbox-callback-process/v1",
      platform: "linux",
      pid: 41,
      bootIdentity: "boot-fixture",
      osStartIdentity: "start-fixture",
      executablePath: "/usr/bin/node",
      scriptMarker: "a".repeat(64),
      instanceNonce: instanceId,
    },
    stop: input.stop,
  };
}

async function reconcileLocalTestProcessTree(input: { sessionDir: string }): Promise<boolean> {
  // Test-only proof for the local runner. It never kills a process or stands in
  // for provider custody: it reads the exact launch-owned pid receipts and
  // returns true only after launcher, wrapper, and accepted child are absent.
  const readPid = async (fileName: string): Promise<number | null> => {
    const raw = await fs.readFile(path.join(input.sessionDir, fileName), "utf8").catch(() => null);
    const pid = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  const accepted = await fs.readFile(
    path.join(input.sessionDir, "launch.accepted.json"),
    "utf8",
  ).then((raw) => JSON.parse(raw) as { childPid?: unknown }, () => null);
  const pids = [
    await readPid("launcher.pid"),
    await readPid("wrapper.pid"),
    typeof accepted?.childPid === "number" && Number.isInteger(accepted.childPid) && accepted.childPid > 0
      ? accepted.childPid
      : null,
  ];
  if (pids.some((pid) => pid === null)) return false;
  const exactPids = pids as number[];
  const deadline = Date.now() + 2_000;
  do {
    if (exactPids.every((pid) => !localTestProcessIsAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

async function findUnreconciledAcceptedProcessSessions(root: string): Promise<string[]> {
  const found = new Set<string>();
  const readText = async (file: string): Promise<string | null> =>
    fs.readFile(file, "utf8").catch(() => null);
  const readJsonObject = async (file: string): Promise<Record<string, unknown> | null> => {
    const raw = await readText(file);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const visit = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") found.add(dir);
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("launch.accepted.json")) {
      const accepted = await readJsonObject(path.join(dir, "launch.accepted.json"));
      const terminal = await readJsonObject(path.join(dir, "terminal.receipt.json"));
      const childClosed = await readText(path.join(dir, "child.closed"));
      const wrapperDone = await readText(path.join(dir, "wrapper.done"));
      const launchId = typeof accepted?.launchId === "string" && accepted.launchId.length > 0
        ? accepted.launchId
        : null;
      const acceptedMatches = Boolean(
        accepted
        && accepted.schemaVersion === 1
        && launchId
        && Number.isInteger(accepted.wrapperPid)
        && Number(accepted.wrapperPid) > 0,
      );
      const terminalMatches = Boolean(
        terminal
        && terminal.schemaVersion === 1
        && terminal.launchId === launchId
        && terminal.type === "exit"
        && (terminal.code === null || Number.isInteger(terminal.code))
        && (terminal.signal === null || typeof terminal.signal === "string")
        && typeof terminal.timestamp === "string"
        && terminal.timestamp.length > 0,
      );
      const terminalComplete = Boolean(
        acceptedMatches
        && terminalMatches
        && childClosed?.trim()
        && wrapperDone?.trim(),
      );
      if (!terminalComplete) found.add(dir);
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => visit(path.join(dir, entry.name))),
    );
  };
  await visit(root);
  return [...found];
}

beforeEach(async () => {
  defaultRunExecutorWorkspace = null;
  invocationClaudeSettingsBefore = await readOptionalFile(invocationClaudeSettingsPath);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await expect(
    readOptionalFile(invocationClaudeSettingsPath),
    "ACPX tests must not create or rewrite checkout-local Claude settings",
  ).resolves.toEqual(invocationClaudeSettingsBefore);
  // Production stop() now fences the detached process-session wrapper PID
  // before removing its queue. Keep this cleanup immediate and retry-free so a
  // leaked cwd/event writer fails the test instead of hiding behind rm retries.
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      const unreconciled = await findUnreconciledAcceptedProcessSessions(root);
      if (unreconciled.length > 0) {
        console.warn(
          `[paperclip-test] Preserving ${root}: ${unreconciled.length} accepted process-session ` +
          "launch(es) do not have complete terminal evidence.",
        );
        return;
      }
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function readOptionalFile(candidate: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function onlyChildDir(parent: string): Promise<string> {
  const entries = await fs.readdir(parent);
  expect(entries).toHaveLength(1);
  return path.join(parent, entries[0]!);
}

async function createSkill(root: string, name: string, body = `---\nrequired: false\n---\n# ${name}\n`) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
  return {
    key: `paperclipai/test/${name}`,
    runtimeName: name,
    source: skillDir,
    required: false,
  };
}

function createLocalSandboxRunner(
  onExecute?: (input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  }) => void,
) {
  let counter = 0;
  // Synthetic provider-duration accumulators so per-step payload assertions can
  // verify the `providerExecMs`/`providerGetMs` threading end-to-end (the real
  // sandbox runner sources these from the Daytona plugin's result metadata; this
  // double stands in for that with a fixed per-exec cost).
  let providerExecMs = 0;
  let providerGetMs = 0;
  return {
    supportsConfidentialStdin: true,
    supportsProcessTreeCustody: process.platform !== "win32",
    reconcileProcessTreeCustody: reconcileLocalTestProcessTree,
    execCount: () => counter,
    providerExecMs: () => providerExecMs,
    providerGetMs: () => providerGetMs,
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
      providerExecMs += 600;
      providerGetMs += 15;
      onExecute?.(input);
      const command = resolveTestShellCommand(input.command);
      return await runChildProcess(`acpx-sandbox-run-${counter}`, command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
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

function buildRuntime(
  onSetConfigOption?: (input: { key: string; value: string }) => void,
  onEnsureSession?: (input: Record<string, unknown>) => void,
) {
  return {
    ensureSession: async (input: Record<string, unknown>) => {
      onEnsureSession?.(input);
      return ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
      });
    },
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    setConfigOption: async (input: { key: string; value: string }) => {
      onSetConfigOption?.(input);
    },
    close: async () => {},
  };
}

async function runExecutor(
  config: Record<string, unknown>,
  options: {
    context?: Record<string, unknown>;
    executionTransport?: Record<string, unknown>;
    authToken?: string;
    executionTarget?: Record<string, unknown>;
    runtimeMcp?: AdapterRuntimeMcpAccess;
    prepareRemoteManagedHome?: AcpxEngineExecutorOptions["prepareRemoteManagedHome"];
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const configOptions: Array<{ key: string; value: string }> = [];
  const sessionInputs: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  let scopedConfig = config;
  let scopedContext = options.context ?? {};
  const workspaceContext = scopedContext.paperclipWorkspace;
  const workspaceCwd = workspaceContext
    && typeof workspaceContext === "object"
    && !Array.isArray(workspaceContext)
    && typeof (workspaceContext as Record<string, unknown>).cwd === "string"
    ? String((workspaceContext as Record<string, unknown>).cwd)
    : "";
  if (typeof config.cwd !== "string" && workspaceCwd.length === 0) {
    if (defaultRunExecutorWorkspace === null) {
      const root = await makeTempRoot();
      const cwd = path.join(root, "worktree");
      await fs.mkdir(cwd, { recursive: true });
      defaultRunExecutorWorkspace = { cwd, stateDir: path.join(root, "state") };
    }
    const { cwd, stateDir } = defaultRunExecutorWorkspace;
    scopedConfig = {
      ...config,
      cwd,
      ...(typeof config.stateDir === "string" ? {} : { stateDir }),
    };
    scopedContext = {
      ...scopedContext,
      paperclipWorkspace: {
        ...(workspaceContext && typeof workspaceContext === "object" && !Array.isArray(workspaceContext)
          ? workspaceContext as Record<string, unknown>
          : {}),
        cwd,
        workspaceWorktreePath: cwd,
      },
    };
  }
  const execute = createAcpxEngineExecutor({
    ...(options.prepareRemoteManagedHome
      ? { prepareRemoteManagedHome: options.prepareRemoteManagedHome }
      : {}),
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as Record<string, unknown>);
      return buildRuntime(
        ({ key, value }) => configOptions.push({ key, value }),
        (input) => sessionInputs.push(input),
      ) as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
    },
      runtime: {},
      config: scopedConfig,
      context: scopedContext,
      executionTransport: options.executionTransport,
      authToken: options.authToken,
      executionTarget: options.executionTarget,
      runtimeMcp: options.runtimeMcp,
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
    onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
      events.push(event);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, events, runtimeOptions, configOptions, sessionInputs, result };
}

describe("shared ACPX engine runtime behavior", () => {
  it("advertises local process-tree custody only where the pid identity model is authoritative", () => {
    const runner = createLocalSandboxRunner();
    expect(runner.supportsProcessTreeCustody).toBe(process.platform !== "win32");
  });

  it("retains malformed, conflicting, or incomplete accepted process-session evidence", async () => {
    const root = await makeTempRoot();
    const sessionDir = path.join(root, "remote", "process-sessions", "session-1");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "launch.accepted.json"), "{malformed\n", "utf8");

    await expect(findUnreconciledAcceptedProcessSessions(root)).resolves.toEqual([sessionDir]);

    await fs.writeFile(path.join(sessionDir, "launch.accepted.json"), JSON.stringify({
      schemaVersion: 1,
      launchId: "launch-1",
      wrapperPid: 101,
      childPid: 102,
      acceptedAt: "2026-08-08T00:00:00.000Z",
    }) + "\n", "utf8");
    await Promise.all([
      fs.writeFile(path.join(sessionDir, "terminal.receipt.json"), JSON.stringify({
        schemaVersion: 1,
        launchId: "different-launch",
        type: "exit",
        code: 0,
        signal: null,
        timestamp: "2026-08-08T00:00:01.000Z",
      }) + "\n", "utf8"),
      fs.writeFile(path.join(sessionDir, "child.closed"), "\n", "utf8"),
      fs.writeFile(path.join(sessionDir, "wrapper.done"), "done\n", "utf8"),
    ]);
    await expect(findUnreconciledAcceptedProcessSessions(root)).resolves.toEqual([sessionDir]);

    await fs.writeFile(path.join(sessionDir, "terminal.receipt.json"), JSON.stringify({
      schemaVersion: 1,
      launchId: "launch-1",
      type: "exit",
      code: 0,
      signal: null,
      timestamp: "2026-08-08T00:00:01.000Z",
    }) + "\n", "utf8");
    await expect(findUnreconciledAcceptedProcessSessions(root)).resolves.toEqual([sessionDir]);

    await fs.writeFile(path.join(sessionDir, "child.closed"), "closed\n", "utf8");
    await expect(findUnreconciledAcceptedProcessSessions(root)).resolves.toEqual([]);
  });

  it("preserves a process-session root when evidence scanning is unavailable", async () => {
    const root = await makeTempRoot();
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("sentinel scan failure"), { code: "EACCES" }),
    );
    try {
      await expect(findUnreconciledAcceptedProcessSessions(root)).resolves.toEqual([root]);
    } finally {
      readdir.mockRestore();
    }
  });

  it("sets Codex model, effort, and fast mode through CODEX_CONFIG without session config calls", async () => {
    const { configOptions, meta } = await runExecutor({
      agent: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      fastMode: true,
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "high",
      service_tier: "fast",
      features: { fast_mode: true },
    });
    expect(configOptions).toEqual([]);
    expect(meta[0]?.commandNotes).toContain(
      "Requested ACPX model: gpt-5.6-sol (set via CODEX_CONFIG at startup).",
    );
  });

  it("forwards arbitrary Codex model IDs verbatim without picker-dependent session config", async () => {
    const arbitraryModel = "gpt-999-test-does-not-exist";
    const { configOptions, meta } = await runExecutor({
      agent: "codex",
      model: arbitraryModel,
      reasoningEffort: "xhigh",
      fastMode: true,
    });

    const codexConfig = JSON.parse(
      String((meta[0]?.env as Record<string, string>).CODEX_CONFIG),
    ) as Record<string, unknown>;
    expect(codexConfig.model).toBe(arbitraryModel);
    expect(codexConfig.model_reasoning_effort).toBe("xhigh");
    expect(configOptions).toEqual([]);
  });

  it("merges user CODEX_CONFIG while runtime model settings win", async () => {
    const { meta } = await runExecutor({
      agent: "codex",
      model: "gpt-runtime",
      fastMode: true,
      env: {
        CODEX_CONFIG: JSON.stringify({
          model: "gpt-user",
          approval_policy: "never",
          features: { experimental_feature: true, fast_mode: false },
        }),
      },
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-runtime",
      approval_policy: "never",
      service_tier: "fast",
      features: { experimental_feature: true, fast_mode: true },
    });
  });

  it("warns when runtime settings replace malformed user CODEX_CONFIG", async () => {
    const { logs, meta } = await runExecutor({
      agent: "codex",
      model: "gpt-runtime",
      env: { CODEX_CONFIG: "not-json" },
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-runtime",
    });
    expect(logs).toContainEqual({
      stream: "stderr",
      text: "[paperclip] Ignoring invalid user CODEX_CONFIG while applying runtime Codex settings; expected a JSON object.\n",
    });
  });

  it("keeps Claude startup model handling and Gemini session config handling unchanged", async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, "worktree");
    const stateDir = path.join(root, "state");
    const sourceTreeSettingsPath = path.resolve(".claude", "settings.local.json");
    const sourceTreeSettingsBefore = await readOptionalFile(sourceTreeSettingsPath);
    await fs.mkdir(cwd, { recursive: true });
    const context = { paperclipWorkspace: { cwd, workspaceWorktreePath: cwd } };

    const claude = await runExecutor(
      { agent: "claude", model: "claude-opus-4-7", cwd, stateDir },
      { context },
    );
    expect((claude.meta[0]?.env as Record<string, string>).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-7",
    );
    expect(claude.configOptions).toEqual([]);

    const gemini = await runExecutor({
      agent: "gemini",
      model: "gemini-2.5-pro",
      thinkingEffort: "high",
      cwd,
      stateDir,
    }, { context });
    expect(gemini.configOptions).toEqual([
      { key: "model", value: "gemini-2.5-pro" },
      { key: "effort", value: "high" },
    ]);
    await expect(readOptionalFile(sourceTreeSettingsPath)).resolves.toEqual(sourceTreeSettingsBefore);
  });

  it("does not inject CODEX_CONFIG or session config when Codex overrides are absent", async () => {
    const { configOptions, meta } = await runExecutor({ agent: "codex" });

    expect((meta[0]?.env as Record<string, string>).CODEX_CONFIG).toBeUndefined();
    expect(configOptions).toEqual([]);
  });

  it("includes Paperclip env and API access notes in the ACPX prompt without leaking the token", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      {
        authToken: "runtime-secret-token",
        context: {
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "issue-1", identifier: "TEST-1" },
          },
        },
      },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    const promptMetrics = meta[0]?.promptMetrics as Record<string, number> | undefined;
    expect(prompt).toContain("Paperclip runtime note:");
    expect(prompt).toContain("PAPERCLIP_AGENT_ID");
    expect(prompt).toContain("PAPERCLIP_API_KEY");
    expect(prompt).toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain('PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"');
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/agents/me");
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
    expect(prompt).toContain("X-Paperclip-Run-Id");
    expect(prompt).not.toContain("$PAPERCLIP_API_URL/api/");
    expect(prompt).not.toContain("/api/issues/{id}");
    expect(prompt).not.toContain("-d '{...}'");
    expect(prompt).not.toContain("runtime-secret-token");
    expect(promptMetrics?.runtimeNoteChars).toBeGreaterThan(0);
  });

  it("does not show a scoped issue API command when the task id is unavailable", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      { authToken: "runtime-secret-token" },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain("Use a real issue id from the current context before making issue write requests.");
    expect(prompt).not.toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
  });

  it("emits ACP text deltas as stdout transcript records", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "text_delta",
              text: "streamed hello",
              stream: "output",
              tag: "agent_message_chunk",
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-streaming-text-delta",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(logs).toContainEqual({
      stream: "stdout",
      text: `${JSON.stringify({
        type: "acpx.text_delta",
        text: "streamed hello",
        channel: "output",
        tag: "agent_message_chunk",
      })}\n`,
    });
  });

  it("captures per-run usage, cost deltas, and billing identity from the ACP runtime", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    let statusCalls = 0;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        getStatus: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { usage: { cost: { amount: 0.4, currency: "USD" } } }
            : {
                usage: {
                  cumulative: {
                    inputTokens: 120,
                    outputTokens: 4500,
                    cachedReadTokens: 900,
                    cachedWriteTokens: 30,
                  },
                  cost: { amount: 1.15, currency: "USD" },
                },
              };
        },
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "status",
              text: "usage",
              tag: "usage_update",
              used: 5550,
              size: 200000,
              cost: { amount: 1.1, currency: "USD" },
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
      resolveBillingIdentity: () => ({ provider: "anthropic", biller: "anthropic", billingType: "api" }),
    });

    const result = await execute({
      runId: "run-usage-capture",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(statusCalls).toBe(2);
    // Cache-write tokens count as input tokens; cached reads stay separate.
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 4500, cachedInputTokens: 900 });
    expect(result.usageBasis).toBe("per_run");
    // Agent-reported cost is cumulative; this run pays the delta.
    expect(result.costUsd).toBeCloseTo(0.75);
    expect(result.provider).toBe("anthropic");
    expect(result.biller).toBe("anthropic");
    expect(result.billingType).toBe("api");
    expect((result.resultJson as Record<string, unknown>)?.cumulativeCostUsd).toBeCloseTo(1.15);
    expect((result.resultJson as Record<string, unknown>)?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 4500,
      cachedReadTokens: 900,
      cachedWriteTokens: 30,
    });
    const statusLine = logs.find((entry) => entry.text.includes('"acpx.status"'));
    expect(statusLine?.text).toContain('"cost"');
  });

  it("falls back to usage_update events when the runtime lacks getStatus", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "status",
              text: "usage",
              tag: "usage_update",
              cost: { amount: 0.31, currency: "USD" },
              breakdown: { inputTokens: 40, outputTokens: 700, cachedReadTokens: 60 },
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-usage-event-fallback",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 700, cachedInputTokens: 60 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBeCloseTo(0.31);
    expect(result.provider).toBe("acpx");
    expect(result.billingType).toBe("unknown");
  });

  it.skipIf(process.platform === "win32")("materializes ACPX Claude skills without symlinked descendants", async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, "worktree");
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    await Promise.all([
      fs.mkdir(cwd, { recursive: true }),
      fs.mkdir(outsideRoot, { recursive: true }),
    ]);
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const skill = await createSkill(skillRoot, "danger");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(skill.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(skill.source, "leak-dir"));

    const stateDir = path.join(root, "state");
    const sourceTreeSettingsPath = path.resolve(".claude", "settings.local.json");
    const sourceTreeSettingsBefore = await readOptionalFile(sourceTreeSettingsPath);
    const { meta } = await runExecutor(
      {
        agent: "claude",
        stateDir,
        cwd,
        paperclipRuntimeSkills: [skill],
        paperclipSkillSync: { desiredSkills: [skill.key] },
      },
      { context: { paperclipWorkspace: { cwd, workspaceWorktreePath: cwd } } },
    );

    const mountedRoot = await onlyChildDir(path.join(stateDir, "runtime-skills", "claude"));
    const skillsHome = path.join(mountedRoot, ".claude", "skills");
    const materializedSkill = path.join(skillsHome, skill.runtimeName);
    expect(await fs.readFile(path.join(materializedSkill, "SKILL.md"), "utf8")).toContain("# danger");
    expect(await pathExists(path.join(materializedSkill, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(materializedSkill, "leak-dir"))).toBe(false);
    expect(String(meta[0]?.prompt ?? "")).toContain(`Skill root: ${skillsHome}`);
    await expect(readOptionalFile(sourceTreeSettingsPath)).resolves.toEqual(sourceTreeSettingsBefore);
  });

  it.skipIf(process.platform === "win32")("revokes removed ACPX Codex skills and skips symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const keep = await createSkill(skillRoot, "keep");
    const remove = await createSkill(skillRoot, "remove");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(keep.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(keep.source, "leak-dir"));

    const baseConfig = {
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [keep, remove],
    };

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key, remove.key] },
    });
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName, "SKILL.md"))).toBe(true);

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key] },
    });

    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak-dir"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("removes legacy ACPX Codex skill symlinks when a skill is no longer desired", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const codexHome = path.join(root, "codex-home");
    const legacy = await createSkill(skillRoot, "legacy");
    const skillsHome = path.join(codexHome, "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(legacy.source, path.join(skillsHome, legacy.runtimeName));

    await runExecutor({
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [legacy],
      paperclipSkillSync: { desiredSkills: [] },
    });

    expect(await pathExists(path.join(skillsHome, legacy.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("replaces stale managed Codex auth files with source symlinks", async () => {
    const root = await makeTempRoot();
    const sourceCodexHome = path.join(root, "source-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const paperclipInstanceId = "test-instance";
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      paperclipInstanceId,
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    const sourceAuth = path.join(sourceCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");
    await fs.writeFile(sourceAuth, "{\"source\":true}", "utf8");
    await fs.writeFile(managedAuth, "{\"stale\":true}", "utf8");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    try {
      process.env.CODEX_HOME = sourceCodexHome;
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = paperclipInstanceId;
      await runExecutor({
        agent: "codex",
        stateDir: path.join(root, "state"),
        paperclipRuntimeSkills: [],
        paperclipSkillSync: { desiredSkills: [] },
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    }

    const authStat = await fs.lstat(managedAuth);
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(managedAuth), await fs.readlink(managedAuth))).toBe(sourceAuth);
  });

  it("uses direct registry commands and per-session env across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    const first = await runExecutor(
      { ...baseConfig, agent: "custom-a" },
      { authToken: "old-key" },
    );
    const second = await runExecutor(
      { ...baseConfig, agent: "custom-b" },
      { authToken: "new-key" },
    );

    expect(
      (first.runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve(
        "custom-a",
      ),
    ).toBe("node ./fake-acp.js");
    expect(
      (second.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("new-key");
    await expect(fs.access(path.join(stateDir, "wrappers"))).rejects.toThrow();
  });

  it("forwards resolved adapter env through session options without overriding runtime vars", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const { sessionInputs } = await runExecutor(
      {
        agentCommand: "node ./fake-acp.js",
        stateDir,
        env: {
          OOGA_BOOGA_123: "plain-value",
          // Server-resolved secret_ref values arrive here as plain strings.
          OPENROUTER_API_KEY: "resolved-secret-value",
          // Reserved-namespace config keys must not clobber runtime identity/wake.
          PAPERCLIP_TASK_ID: "attacker-issue",
          // PAPERCLIP_API_KEY is never accepted from config.
          PAPERCLIP_API_KEY: "config-key",
          // A PAPERCLIP_*-named key the harness does not assign flows through.
          PAPERCLIP_CLOUD_PROVIDER_TOKEN: "cloud-token",
        },
      },
      {
        authToken: "runtime-secret-token",
        context: { taskId: "issue-real", wakeReason: "issue_assigned" },
      },
    );
    const env = (sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env;
    expect(env.OOGA_BOOGA_123).toBe("plain-value");
    expect(env.OPENROUTER_API_KEY).toBe("resolved-secret-value");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-real");
    expect(env.PAPERCLIP_API_KEY).toBe("runtime-secret-token");
    expect(env.PAPERCLIP_CLOUD_PROVIDER_TOKEN).toBe("cloud-token");
  });

  it("busts the session fingerprint when resolved adapter env changes but not across wakes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    const first = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-1" } },
      { context: { taskId: "issue-1", wakeReason: "issue_assigned" } },
    );
    const changedEnv = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-2" } },
      { context: { taskId: "issue-1", wakeReason: "issue_assigned" } },
    );
    const sameEnvNewWake = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-1" } },
      { context: { taskId: "issue-1", wakeReason: "comment", wakeCommentId: "c-9" } },
    );

    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    // A changed forwarded env value invalidates warm-handle / session reuse so
    // the next launch sources the latest env.
    expect(fp(first)).toBeDefined();
    expect(fp(changedEnv)).not.toBe(fp(first));
    // A new heartbeat with the same config env keeps the fingerprint stable, so
    // per-wake PAPERCLIP_* churn does not needlessly reset the session.
    expect(fp(sameEnvNewWake)).toBe(fp(first));
  });

  it("busts the session fingerprint when a stable configured PAPERCLIP_* value rotates", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    // A configured PAPERCLIP_*-named value the harness does not assign (e.g. a
    // cloud provider token binding) is stable per-run config: rotating it must
    // invalidate a warm/resumable session so the next launch sources the new
    // value, even across an otherwise-identical wake context.
    const context = { taskId: "issue-1", wakeReason: "issue_assigned" };
    const withKey = await runExecutor(
      { ...baseConfig, env: { PAPERCLIP_CLOUD_PROVIDER_TOKEN: "explicit-key-1" } },
      { context },
    );
    const rotatedKey = await runExecutor(
      { ...baseConfig, env: { PAPERCLIP_CLOUD_PROVIDER_TOKEN: "explicit-key-2" } },
      { context },
    );

    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    expect(fp(withKey)).toBeDefined();
    expect(fp(rotatedKey)).not.toBe(fp(withKey));
  });

  itPosixSandboxLifecycle("shapes ACPX session env for remote execution identities", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "local");
    const remoteCwd = path.join(root, "remote");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const { sessionInputs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", cwd: localCwd, stateDir: path.join(root, "state") },
      {
        authToken: "real-run-jwt",
        context: { paperclipWorkspace: { cwd: localCwd, workspaceWorktreePath: localCwd } },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        },
      },
    );
    const env = (sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env;
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe(remoteCwd);
    expect(env.PAPERCLIP_WORKSPACE_CWD).not.toBe(localCwd);
    expect(env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    // The test-only runner-backed lane advertises the remote session cwd while
    // keeping the relay proxy's host spawn rooted in the real local worktree.
    expect(runtimeOptions[0]!.cwd).toBe(remoteCwd);
    expect(runtimeOptions[0]!.spawnCwd).toBe(localCwd);
  });

  it("does not materialize credential wrapper scripts", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    await runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js", stateDir });
    await expect(fs.access(path.join(stateDir, "wrappers"))).rejects.toThrow();
  });

  it("keeps concurrent credentials isolated in their session options", async () => {
    const [first, second] = await Promise.all([
      runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js" }, { authToken: "first" }),
      runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js" }, { authToken: "second" }),
    ]);
    expect(
      (first.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("first");
    expect(
      (second.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("second");
  });

  it("enriches acpx.error diagnostics and child stderr when ensureSession rejects", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const runStderrDir = path.join(stateDir, "run-stderr");
    await fs.mkdir(runStderrDir, { recursive: true });
    const stderrTail = "claude-agent-acp: SDK init failed (auth missing)";
    await fs.writeFile(path.join(runStderrDir, "run-1.log"), `${stderrTail}\n`, "utf8");

    class FakeAcpRuntimeError extends Error {
      readonly code = "ACP_SESSION_INIT_FAILED";
      readonly cause: Error;
      readonly retryable = false;
      constructor(message: string, cause: Error) {
        super(message);
        this.name = "AcpRuntimeError";
        this.cause = cause;
      }
    }

    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => {
          throw new FakeAcpRuntimeError(
            "session/new failed: backend rejected initialize",
            new Error("upstream timeout"),
          );
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_session_init_failed");
    const meta = result.errorMeta ?? {};
    expect(meta.errorName).toBe("AcpRuntimeError");
    expect(meta.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(meta.causeMessage).toBe("upstream timeout");
    expect(meta.retryable).toBe(false);
    expect(typeof meta.stackPreview).toBe("string");
    expect(meta.phase).toBe("ensure_session");

    const errorLogLine = logs.find((entry) => entry.stream === "stdout" && entry.text.includes("\"type\":\"acpx.error\""));
    expect(errorLogLine).toBeTruthy();
    const errorPayload = JSON.parse(errorLogLine!.text.trim());
    expect(errorPayload.phase).toBe("ensure_session");
    expect(errorPayload.errorName).toBe("AcpRuntimeError");
    expect(errorPayload.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(errorPayload.causeMessage).toBe("upstream timeout");
    expect(errorPayload.childStderrTail).toContain("SDK init failed");

    const stderrLog = logs.find((entry) => entry.stream === "stderr" && entry.text.includes("ACPX child stderr tail"));
    expect(stderrLog).toBeTruthy();
    expect(stderrLog!.text).toContain(stderrTail);
  });

  it("configures in-process child stderr capture without forcing verbose mode", async () => {
    const root = await makeTempRoot();
    const { runtimeOptions } = await runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") });
    expect(runtimeOptions[0]!.verbose).toBe(false);
    expect(runtimeOptions[0]!.onAgentStderr).toBeTypeOf("function");
    // Local lane is byte-identical: no host-spawn redirect, so `spawnCwd` is
    // unset and acpx falls back to `cwd`.
    expect(runtimeOptions[0]!.spawnCwd).toBeUndefined();
  });

  itPosixSandboxLifecycle("starts sandbox ACP process sessions in the remote execution cwd", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });

    let launchRequest: Record<string, unknown> | null = null;
    let launchScript: string | null = null;
    const runner = createLocalSandboxRunner(
      (input: { args?: string[]; env?: Record<string, string>; stdin?: string }) => {
        if (
          input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL !== "bridge"
          || typeof input.stdin !== "string"
        ) return;
        try {
          const candidate = JSON.parse(input.stdin) as Record<string, unknown>;
          if (candidate.schemaVersion !== 1 || typeof candidate.config !== "object") return;
          launchRequest = candidate;
          launchScript = input.args?.[1] ?? "";
        } catch {
          // Other bridge commands may use non-JSON stdin; only the launch
          // request is relevant to this confidentiality assertion.
        }
      },
    );

    const hostOnlySentinelKey = "PAPERCLIP_HOST_ONLY_TEST_SENTINEL";
    const previousHostOnlySentinel = process.env[hostOnlySentinelKey];
    process.env[hostOnlySentinelKey] = "must-not-cross-remote-boundary";
    let runtimeOptions: Record<string, unknown>[];
    let sessionInputs: Record<string, unknown>[];
    try {
      ({ runtimeOptions, sessionInputs } = await runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        {
          authToken: "real-run-jwt",
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "fake-plugin",
            remoteCwd,
            runner,
          },
        },
      ));
    } finally {
      if (previousHostOnlySentinel === undefined) delete process.env[hostOnlySentinelKey];
      else process.env[hostOnlySentinelKey] = previousHostOnlySentinel;
    }

    expect(launchRequest).toMatchObject({
      schemaVersion: 1,
      config: {
        command: "sh",
        args: ["-lc", "exec node ./fake-acp.js"],
        cwd: remoteCwd,
      },
    });
    expect(launchScript).toContain("cat >");
    expect(launchScript).toContain("PAPERCLIP_PROCESS_SESSION_REQUEST_PATH");
    expect(launchScript).not.toContain("PAPERCLIP_PROCESS_SESSION_COMMAND_B64");
    expect(launchScript).not.toContain("real-run-jwt");

    // Host-spawn cwd decoupling: on the remote process-session lane the acpx
    // runtime host-spawns the relay proxy, whose `chdir` must land in a
    // HOST-valid dir — the engine's host `cwd` (`localCwd`) — while the advertised
    // ACP `session/new` cwd and the in-sandbox `commandPayload.cwd` stay
    // `remoteCwd`. `spawnCwd` carries the host-only redirect; it must differ from
    // the advertised session cwd. (Threading proof; the acpx runtime honoring
    // `spawnCwd ?? cwd` at the real host spawn is proven in remote-spawn-smoke.)
    expect(runtimeOptions[0]!.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]!.cwd).toBe(remoteCwd);
    expect(runtimeOptions[0]!.spawnCwd).toBe(localCwd);
    expect(runtimeOptions[0]!.spawnCwd).not.toBe(sessionInputs[0]!.cwd);
    const requestConfig = ((launchRequest as Record<string, unknown> | null)?.config ?? {}) as Record<string, unknown>;
    const payloadEnv = (requestConfig.env ?? {}) as Record<string, unknown>;
    expect(payloadEnv).toMatchObject({
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    });
    expect(String(payloadEnv.PAPERCLIP_API_URL ?? "")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
    expect(payloadEnv.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
    expect(payloadEnv[hostOnlySentinelKey]).toBeUndefined();
  });

  itPosixSandboxLifecycle("keeps the session fingerprint stable when only the host spawn cwd changes", async () => {
    // `spawnCwd` (the host-only spawn redirect = the host `cwd`) must NOT enter
    // the session fingerprint or compat key: two runs of the same session that
    // stage into the same in-sandbox `remoteCwd` from DIFFERENT host worktrees
    // must reuse — not invalidate — the staged runtime. So the fingerprint has to
    // ignore the host cwd and key only on the advertised session cwd (`remoteCwd`).
    const root = await makeTempRoot();
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(remoteCwd, { recursive: true });

    const runOnce = async (hostWorktree: string) => {
      const localCwd = path.join(root, hostWorktree);
      await fs.mkdir(localCwd, { recursive: true });
      return runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, hostWorktree, "state"), cwd: localCwd },
        {
          authToken: "real-run-jwt",
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "fake-plugin",
            remoteCwd,
            runner: createLocalSandboxRunner(),
          },
        },
      );
    };

    const first = await runOnce("worktree-a");
    const second = await runOnce("worktree-b");

    // Host cwd (and therefore `spawnCwd`) differs between the two runs...
    expect(first.runtimeOptions[0]!.spawnCwd).not.toBe(second.runtimeOptions[0]!.spawnCwd);
    // ...but the advertised session cwd — and thus the fingerprint — is identical.
    expect(first.sessionInputs[0]!.cwd).toBe(remoteCwd);
    expect(second.sessionInputs[0]!.cwd).toBe(remoteCwd);
    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;
    expect(fp(first)).toBeDefined();
    expect(fp(second)).toBe(fp(first));
  });

  it("routes child stderr in-process while keeping the unfiltered run log", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        runtimeOptions = options;
        return buildRuntime() as never;
      },
    });
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await execute({
        runId: "run-nes-close-1",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      runtimeOptions?.onAgentStderr?.("Error handling request { method: 'nes/cl");
      runtimeOptions?.onAgentStderr?.("ose' } { code: -32601 }\n");
      runtimeOptions?.onAgentStderr?.("some genuine crash: TypeError: x is not a function\n");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).not.toContain("nes/close");
    expect(writes.join("")).toContain("some genuine crash");
    const runLog = await fs.readFile(path.join(stateDir, "run-stderr", "run-nes-close-1.log"), "utf8");
    expect(runLog).toContain("nes/close");
    expect(runLog).toContain("some genuine crash");
  });

  it("routes reused warm-runtime stderr to the current run log", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const warmHandles = new Map();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        runtimeOptions = options;
        return buildRuntime() as never;
      },
    });
    const config = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      mode: "persistent",
      warmHandleIdleMs: 60_000,
    };
    const first = await execute({
      runId: "run-warm-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    const second = await execute({
      runId: "run-warm-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    expect(second.exitCode).toBe(0);
    runtimeOptions?.onAgentStderr?.("current-run-stderr\n");
    await expect(fs.readFile(path.join(stateDir, "run-stderr", "run-warm-1.log"), "utf8")).rejects.toThrow();
    await expect(fs.readFile(path.join(stateDir, "run-stderr", "run-warm-2.log"), "utf8")).resolves.toContain("current-run-stderr");
  });

  it("passes Paperclip env through ACPX session options instead of process.env", async () => {
    let observedSessionEnv: Record<string, string> | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async (input: { sessionOptions?: { env?: Record<string, string> } }) => {
          observedSessionEnv = input.sessionOptions?.env;
          return { backendSessionId: "backend-session", agentSessionId: "agent-session", runtimeSessionName: "runtime-session" };
        },
        startTurn: () => ({
          events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    try {
      delete process.env.PAPERCLIP_API_KEY;
      const result = await execute({
        runId: "run-1",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js" },
        context: {},
        authToken: "runtime-key",
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      expect(observedSessionEnv?.PAPERCLIP_API_KEY).toBe("runtime-key");
      expect(process.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("writes a Paperclip-managed .claude/settings.local.json for the claude agent so it can reach the Paperclip API", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd, agentHome: path.join(root, "agent-home") } } },
    );

    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      permissions?: {
        allow?: unknown;
        additionalDirectories?: unknown;
        defaultMode?: unknown;
      };
    };
    expect(written.permissions?.defaultMode).toBe("default");
    const allow = written.permissions?.allow;
    expect(Array.isArray(allow)).toBe(true);
    expect(allow).toContain("Bash(curl:*)");
    expect(allow).toContain(`Bash(${cwd}/scripts/paperclip-issue-update.sh:*)`);
    const additionalDirectories = written.permissions?.additionalDirectories as string[] | undefined;
    expect(Array.isArray(additionalDirectories)).toBe(true);
    expect(additionalDirectories).toContain(stateDir);
    expect(additionalDirectories).toContain(path.join(root, "agent-home"));

    const note = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("Paperclip-managed Claude settings"),
    );
    expect(note).toBeTruthy();
  });

  it("merges Paperclip allowlist into an existing .claude/settings.local.json without losing user entries", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          statusLine: { type: "command", command: "preserve-me" },
          permissions: {
            allow: ["Bash(npm test:*)"],
            additionalDirectories: ["/Users/example/custom"],
            defaultMode: "acceptEdits",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as {
      statusLine?: unknown;
      permissions?: {
        allow?: string[];
        additionalDirectories?: string[];
        defaultMode?: string;
      };
    };
    expect(written.statusLine).toEqual({ type: "command", command: "preserve-me" });
    expect(written.permissions?.defaultMode).toBe("acceptEdits");
    expect(written.permissions?.allow).toContain("Bash(npm test:*)");
    expect(written.permissions?.allow).toContain("Bash(curl:*)");
    expect(written.permissions?.additionalDirectories).toContain("/Users/example/custom");
    expect(written.permissions?.additionalDirectories).toContain(stateDir);
  });

  it("overrides a user-supplied dontAsk defaultMode so ACPX can route Bash through canUseTool", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "dontAsk" } }, null, 2),
      "utf8",
    );

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as { permissions?: { defaultMode?: string } };
    expect(written.permissions?.defaultMode).toBe("default");

    const overrideNote = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("overrode user dontAsk"),
    );
    expect(overrideNote).toBeTruthy();
  });

  it("opts the claude agent into ACPX runtime verbose logs but leaves codex/custom agents quiet", async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const verboseByAgent: Record<string, boolean | undefined> = {};
    for (const agent of ["claude", "codex", "custom"] as const) {
      const runtimeOptions: AcpRuntimeOptions[] = [];
      const execute = createAcpxEngineExecutor({
        createRuntime: (options) => {
          runtimeOptions.push(options as AcpRuntimeOptions);
          return buildRuntime() as never;
        },
      });
      const result = await execute({
        runId: `run-${agent}`,
        agent: { id: `agent-${agent}`, companyId: "company-1" },
        runtime: {},
        config:
          agent === "custom"
            ? { agent, agentCommand: "node ./fake-acp.js", stateDir: path.join(root, `state-${agent}`), cwd }
            : { agent, stateDir: path.join(root, `state-${agent}`), cwd },
        context: { paperclipWorkspace: { cwd } },
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      verboseByAgent[agent] = (runtimeOptions[0] as { verbose?: boolean } | undefined)?.verbose;
    }

    expect(verboseByAgent.claude).toBe(true);
    expect(verboseByAgent.codex).toBe(false);
    expect(verboseByAgent.custom).toBe(false);
  });

  it("does not touch .claude/settings.local.json for the codex agent", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    await runExecutor(
      { agent: "codex", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    expect(await pathExists(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("changes the ACPX session fingerprint when the resolved secret manifest rotates", async () => {
    const root = await makeTempRoot();
    const baseConfig = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
    };

    const first = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 1,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });
    const second = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 2,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });

    expect(first.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(second.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(first.result.sessionParams?.configFingerprint).not.toBe(second.result.sessionParams?.configFingerprint);
  });

  it("injects runtime MCP servers and fingerprints their identity without persisting bearer tokens", async () => {
    const root = await makeTempRoot();
    const baseConfig = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
    };
    const server = {
      name: "github",
      url: "https://paperclip.example/api/tool-gateway/gateways/github/mcp",
      connectionId: "connection-1",
    };
    const first = await runExecutor(baseConfig, {
      runtimeMcp: { getServers: () => [{ ...server, token: "token-one" }] },
    });
    const rotatedToken = await runExecutor(baseConfig, {
      runtimeMcp: { getServers: () => [{ ...server, token: "token-two" }] },
    });
    const changedSet = await runExecutor(baseConfig, {
      runtimeMcp: {
        getServers: () => [{ ...server, connectionId: "connection-2", token: "token-two" }],
      },
    });

    expect(first.runtimeOptions[0]?.mcpServers).toEqual([{
      type: "http",
      name: "github",
      url: server.url,
      headers: [{ name: "Authorization", value: "Bearer token-one" }],
    }]);
    expect(first.result.sessionParams?.mcpServers).toEqual([{
      name: "github",
      url: server.url,
      connectionId: "connection-1",
    }]);
    expect(JSON.stringify(first.result.sessionParams)).not.toContain("token-one");
    expect(first.result.sessionParams?.configFingerprint).toBe(rotatedToken.result.sessionParams?.configFingerprint);
    expect(first.result.sessionParams?.configFingerprint).not.toBe(changedSet.result.sessionParams?.configFingerprint);
  });
});

describe("findAncestorBin", () => {
  async function writeFakeBin(dir: string, name: string) {
    const binDir = path.join(dir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, name);
    await fs.writeFile(binPath, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
    return binPath;
  }

  it("finds the binary in the start directory's own node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(packageDir, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("finds the binary hoisted to an ancestor node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(root, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("returns null when the binary is not present in any ancestor", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBeNull();
  });

  it("terminates at the filesystem root instead of looping forever", async () => {
    const resolved = await findAncestorBin("/", "definitely-not-a-real-bin-name-xyz");
    expect(resolved).toBeNull();
  });
});

describe("gemini ACP flag selection", () => {
  it("parses semantic version parts from gemini --version output", () => {
    expect(parseGeminiVersionParts("0.30.0")).toEqual([0, 30, 0]);
    expect(parseGeminiVersionParts("gemini-cli v1.2.3\n")).toEqual([1, 2, 3]);
    expect(parseGeminiVersionParts("no version here")).toBeNull();
    expect(parseGeminiVersionParts(null)).toBeNull();
  });

  it("keeps --acp for gemini >= 0.33.0 and unknown versions", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 33, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([0, 34, 1])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([1, 0, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag(null)).toBe(true);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 33, 0])).toBe("gemini --acp");
  });

  it("downgrades --acp to --experimental-acp for gemini < 0.33.0", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 30, 0])).toBe(false);
    expect(geminiVersionSupportsNativeAcpFlag([0, 32, 9])).toBe(false);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 30, 0])).toBe("gemini --experimental-acp");
    expect(rewriteGeminiAcpFlagForVersion("/opt/bin/gemini --acp", [0, 30, 0])).toBe(
      "/opt/bin/gemini --experimental-acp",
    );
  });

  async function writeFakeGemini(binDir: string, version: string) {
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, process.platform === "win32" ? "gemini.cmd" : "gemini");
    const contents = process.platform === "win32"
      ? `@echo off\r\necho ${version}\r\n`
      : `#!/bin/sh\necho "${version}"\n`;
    await fs.writeFile(binPath, contents, { mode: 0o755 });
  }

  function pathWithFakeBin(binDir: string): string {
    return [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  }

  it("registers the gemini multi-word command directly", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.33.0");
    const { runtimeOptions } = await runExecutor({ agent: "gemini", stateDir: path.join(root, "state"), env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) } });
    expect((runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve("gemini")).toBe("gemini --acp");
  });

  it("downgrades the registered gemini command when the local CLI predates --acp", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.30.0");
    const { runtimeOptions } = await runExecutor({ agent: "gemini", stateDir: path.join(root, "state"), env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) } });
    expect((runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve("gemini")).toBe("gemini --experimental-acp");
  });

  itPosixSandboxLifecycle("applies the 4h sandbox backstop when timeoutSec is unset on a sandbox execution target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd },
      {
        authToken: "real-run-jwt",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "acme-sandbox",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: cwd,
          runner: createLocalSandboxRunner(),
        },
      },
    );

    // The sandbox default flows into the ACPX runtime wall-clock timer.
    expect(runtimeOptions[0]?.timeoutMs).toBe(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000);
    // The effective timeout and its source are stated at run start so a later
    // timeout is diagnosable from the run log alone.
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain(
      `[paperclip] Adapter execution timeout: timeoutSec=${DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC} ` +
        "(sandbox default; set adapterConfig.timeoutSec to override).",
    );
  });

  it("keeps local execution unlimited by default and logs the unlimited timeout", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      cwd,
    });

    expect(runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain("Adapter execution timeout: none");
  });

  itPosixSandboxLifecycle("prefers a configured timeoutSec over the sandbox default", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 90 },
      {
        authToken: "real-run-jwt",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: cwd,
          runner: createLocalSandboxRunner(),
        },
      },
    );

    expect(runtimeOptions[0]?.timeoutMs).toBe(90 * 1000);
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: timeoutSec=90 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
  });

  itPosixSandboxLifecycle("keeps the sandbox backstop for an explicit timeoutSec of 0 but honors a negative opt-out", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });
    const sandboxContext = {
      authToken: "real-run-jwt",
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "fake-plugin",
        remoteCwd: cwd,
        runner: createLocalSandboxRunner(),
      },
    };

    // The config UI persists the schema default of 0 for untouched fields, so
    // an explicit 0 cannot mean "no timeout" — it keeps the 4h backstop.
    const explicitZero = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 0 },
      sandboxContext,
    );
    expect(explicitZero.runtimeOptions[0]?.timeoutMs).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000,
    );

    // A negative timeoutSec is the documented opt-out from any adapter
    // wall-clock timeout, sandbox targets included.
    const negativeOptOut = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: -1 },
      sandboxContext,
    );
    expect(negativeOptOut.runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = negativeOptOut.logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; " +
        "set it to a positive value to add one).",
    );
  });

  it("reports a self-describing timeout error when the wall-clock timer kills a turn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const cancelReasons: string[] = [];
    let releaseTurn: (() => void) | null = null;
    const turnCancelled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          // Never yields on its own: only the Paperclip wall-clock timer's
          // cancel unblocks the turn, simulating a hung run.
          events: (async function* () {
            await turnCancelled;
          })(),
          result: turnCancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
          cancel: async ({ reason }: { reason: string }) => {
            cancelReasons.push(reason);
            releaseTurn?.();
          },
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-timeout-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd,
        timeoutSec: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    const expectedMessage =
      "Run exceeded the adapter execution timeout (timeoutSec=1, configured via adapterConfig.timeoutSec). " +
      "Set adapterConfig.timeoutSec to raise it.";
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("acpx_timeout");
    expect(result.errorMessage).toBe(expectedMessage);
    expect(cancelReasons).toContain(expectedMessage);
  }, 15_000);
});

describe("summarizeAcpxTurnUsage", () => {
  it("uses the post-turn amount alone when the cumulative cost counter reset", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cost: { amount: 2.5, currency: "USD" } } },
      postStatus: {
        usage: {
          cumulative: { inputTokens: 10, outputTokens: 20 },
          cost: { amount: 0.3, currency: "USD" },
        },
      },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.costUsd).toBeCloseTo(0.3);
    expect(summary.cumulativeCostUsd).toBeCloseTo(0.3);
  });

  it("ignores non-USD cost amounts", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: { usage: { cost: { amount: 4, currency: "EUR" } } },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.costUsd).toBeNull();
    expect(summary.cumulativeCostUsd).toBeNull();
  });

  it("returns no usage when nothing was reported", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: null,
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.usage).toBeNull();
    expect(summary.costUsd).toBeNull();
  });
});

describe("summarizeAcpxTurnUsage no-report turns", () => {
  it("suppresses usage when the turn reported nothing and the persisted breakdown is unchanged", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale, cost: { amount: 0.5, currency: "USD" } } },
      postStatus: { usage: { cumulative: { ...stale }, cost: { amount: 0.5, currency: "USD" } } },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.usage).toBeNull();
    expect(summary.usageDetail).toBeNull();
    expect(summary.costUsd).toBeCloseTo(0);
  });

  it("prefers current event usage when the persisted breakdown is stale", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const current = { inputTokens: 25, outputTokens: 75, cachedReadTokens: 5 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale } },
      postStatus: { usage: { cumulative: { ...stale } } },
      eventBreakdown: current,
      eventCostUsd: null,
    });
    expect(summary.usage).toEqual({
      inputTokens: 25,
      outputTokens: 75,
      cachedInputTokens: 5,
    });
    expect(summary.usageDetail).toMatchObject(current);
  });

  it("treats omitted and explicit zero fields as the same stale breakdown", () => {
    const current = { inputTokens: 25, outputTokens: 75, cachedReadTokens: 5 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: { inputTokens: 10, outputTokens: 500 } } },
      postStatus: {
        usage: {
          cumulative: {
            inputTokens: 10,
            outputTokens: 500,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            thoughtTokens: 0,
            totalTokens: 0,
          },
        },
      },
      eventBreakdown: current,
      eventCostUsd: null,
    });
    expect(summary.usage).toEqual({
      inputTokens: 25,
      outputTokens: 75,
      cachedInputTokens: 5,
    });
  });

  it("does not reuse stale tokens when the turn reports cost only", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale, cost: { amount: 0.5, currency: "USD" } } },
      postStatus: {
        usage: { cumulative: { ...stale }, cost: { amount: 0.5, currency: "USD" } },
      },
      eventBreakdown: null,
      eventCostUsd: 0.75,
    });
    expect(summary.usage).toBeNull();
    expect(summary.usageDetail).toBeNull();
    expect(summary.costUsd).toBeCloseTo(0.25);
    expect(summary.cumulativeCostUsd).toBeCloseTo(0.75);
  });
});

describe("ACPX engine remote sandbox staging seam (PR 1: workspace + cwd)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupRemoteSandbox() {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // A file present only in the HOST worktree proves the workspace is shipped
    // into the sandbox: the local runner extracts the staged tar into remoteCwd.
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const runner = createLocalSandboxRunner();
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner,
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  it.each(["novita", "custom-provider"])(
    "fails closed before staging or launch for %s without authoritative tree custody",
    async (providerKey) => {
      const root = await makeTempRoot();
      const stateDir = path.join(root, "state");
      const localCwd = path.join(root, "worktree");
      await fs.mkdir(localCwd, { recursive: true });
      const runnerExecute = vi.fn();
      const createRuntime = vi.fn(() => buildRuntime() as never);
      const onEvent = vi.fn<(event: { eventType?: string }) => Promise<void>>(async () => {});
      const execute = createAcpxEngineExecutor({ createRuntime });

      await expect(
        execute({
          runId: `run-no-custody-${providerKey}`,
          agent: { id: "agent-1", companyId: "company-1" },
          runtime: {},
          config: {
            agent: "custom",
            agentCommand: "node ./fake-acp.js",
            stateDir,
            cwd: localCwd,
            env: { PAPERCLIP_API_KEY: "must-never-reach-provider" },
          },
          context: {},
          authToken: "must-never-reach-provider",
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey,
            remoteCwd: "/workspace",
            runner: {
              supportsConfidentialStdin: providerKey !== "novita",
              execute: runnerExecute,
            },
          },
          onLog: async () => {},
          onMeta: async () => {},
          onEvent,
        } as never),
      ).rejects.toThrow("authoritative process-tree custody");

      expect(runnerExecute).not.toHaveBeenCalled();
      expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
      expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
      expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(
        onEvent.mock.calls.some(([event]) => event.eventType === "acp.process_session.launch"),
      ).toBe(false);
    },
  );

  it("keeps the incomplete remote release protocol disabled even when capabilities are advertised", async () => {
    // Environment/config strings are deliberately ignored; only the injected
    // internal test dependency can exercise the inert controller.
    vi.stubEnv("PAPERCLIP_TEST_ENABLE_REMOTE_ACP_RELEASE_PROTOCOL", "1");
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const runnerExecute = vi.fn();
    const reconcileProcessTreeCustody = vi.fn(async () => true);
    const createRuntime = vi.fn(() => buildRuntime() as never);
    const onEvent = vi.fn<(event: { eventType?: string }) => Promise<void>>(async () => {});
    const onLog = vi.fn(async () => undefined);
    const execute = createAcpxEngineExecutorImpl({ createRuntime });

    const result = await execute({
        runId: "run-release-protocol-disabled",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          cwd: localCwd,
          env: { PAPERCLIP_API_KEY: "must-never-dispatch" },
        },
        context: {},
        authToken: "must-never-dispatch",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "future-provider",
          remoteCwd: "/workspace",
          runner: {
            supportsConfidentialStdin: true,
            supportsProcessTreeCustody: true,
            reconcileProcessTreeCustody,
            execute: runnerExecute,
          },
        },
        onLog,
        onMeta: async () => {},
        onEvent,
      } as never);

    expect(result).toMatchObject({
      errorCode: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
      errorMeta: { retryable: false, needsHuman: true },
      resultJson: { phase: "preflight" },
    });

    expect(onLog).not.toHaveBeenCalled();
    expect(runnerExecute).not.toHaveBeenCalled();
    expect(reconcileProcessTreeCustody).not.toHaveBeenCalled();
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(
      onEvent.mock.calls.some(([event]) => event.eventType === "acp.process_session.launch"),
    ).toBe(false);
  });

  it("never falls back to host ACPX for a runner-backed custom agent without a command", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const runnerExecute = vi.fn();
    const createRuntime = vi.fn(() => buildRuntime() as never);
    const execute = createAcpxEngineExecutorImpl({ createRuntime });
    const onLog = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);

    const result = await execute({
        runId: "run-no-command-no-local-fallback",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "custom",
          stateDir: path.join(root, "state"),
          cwd: localCwd,
        },
        context: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "custom-provider",
          remoteCwd: "/workspace",
          runner: {
            supportsConfidentialStdin: true,
            supportsProcessTreeCustody: true,
            reconcileProcessTreeCustody: async () => true,
            execute: runnerExecute,
          },
        },
        onLog,
        onMeta: async () => {},
        onEvent,
      } as never);

    expect(result).toMatchObject({
      errorCode: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
      errorMeta: { retryable: false, needsHuman: true },
      resultJson: { phase: "preflight" },
    });

    expect(onLog).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(runnerExecute).not.toHaveBeenCalled();
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "runner-less sandbox",
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "runnerless-provider",
        remoteCwd: "/workspace",
      },
    },
    {
      label: "non-sandbox SSH",
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/workspace",
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "fixture",
          remoteCwd: "/workspace",
          remoteWorkspacePath: "/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
      },
    },
  ])("rejects explicit ACP on a $label target before local fallback", async ({ executionTarget }) => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "must-not-materialize");
    const createRuntime = vi.fn(() => buildRuntime() as never);
    const onEvent = vi.fn(async () => {});
    const execute = createAcpxEngineExecutorImpl({ createRuntime });

    const onLog = vi.fn(async () => {});
    const result = await execute({
        runId: "run-remote-no-local-fallback",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          cwd: localCwd,
        },
        context: {},
        executionTarget,
        onLog,
        onMeta: async () => {},
        onEvent,
      } as never);

    expect(result).toMatchObject({
      errorCode: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
      errorMeta: { retryable: false, needsHuman: true },
      resultJson: { phase: "preflight" },
    });

    expect(onLog).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    await expect(fs.stat(localCwd)).rejects.toThrow();
  });

  it.each([
    {
      label: "malformed direct remote target",
      targetFields: {
        executionTarget: { kind: "remote", transport: "sandbox" },
      },
    },
    {
      label: "malformed legacy remote transport",
      targetFields: {
        executionTransport: { remoteExecution: {} },
      },
    },
    {
      label: "invalid direct target with a valid legacy fallback",
      targetFields: {
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "" },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 22,
            username: "fixture",
            remoteCwd: "/workspace",
          },
        },
      },
    },
  ])("rejects a $label before local ACP fallback", async ({ targetFields }) => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "must-not-materialize-invalid-remote");
    const createRuntime = vi.fn(() => buildRuntime() as never);
    const execute = createAcpxEngineExecutorImpl({ createRuntime });

    await expect(
      execute({
        runId: "run-invalid-remote-no-local-fallback",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          cwd: localCwd,
        },
        context: {},
        ...targetFields,
        onLog: async () => {},
        onMeta: async () => {},
        onEvent: async () => {},
      } as never),
    ).rejects.toMatchObject({
      code: PAPERCLIP_EXECUTION_TARGET_INVALID,
      retryable: false,
      needsHuman: true,
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
    await expect(fs.stat(localCwd)).rejects.toThrow();
  });

  itPosixSandboxLifecycle("test_remote_buildRuntime_crosses_staging_seam", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs, events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // Crossing the staging seam emits a per-step timing event for the sync.
    const stageEvent = events.find(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "stage.sync",
    );
    expect(stageEvent).toBeTruthy();
    expect(typeof stageEvent!.payload?.durationMs).toBe("number");

    // Staging seam crossed exactly once, shipping the HOST worktree.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.workspaceLocalDir).toBe(localCwd);
    expect(stageArgs.target).toMatchObject({ kind: "remote", transport: "sandbox" });
    // No credential/home asset staged in PR 1 (that is PR 2's per-adapter seed).
    expect(stageArgs.assets ?? []).toEqual([]);
    expect(stageArgs.installCommand ?? null).toBeNull();

    // Both bridges receive the real (non-null) runtimeRootDir from staging.
    const paperclipArgs = vi.mocked(startAdapterExecutionTargetPaperclipBridge).mock.calls[0]![0];
    const processArgs = vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls[0]![0];
    expect(paperclipArgs.runtimeRootDir).toBeTruthy();
    expect(processArgs.runtimeRootDir).toBeTruthy();
    expect(String(paperclipArgs.runtimeRootDir)).toContain(".paperclip-runtime");
    expect(processArgs.runtimeRootDir).toBe(paperclipArgs.runtimeRootDir);

    // The workspace really landed in the sandbox workspace dir.
    await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    // And session/new is created on the in-sandbox workspace cwd.
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });

  itPosixSandboxLifecycle("hands the merged paperclip env to the process-session launch when the setups overlap", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    // Decode the stdin-fed private launch request. The in-sandbox process env
    // is carried in request.config, never in provider command/argv/env.
    let launchPayload: Record<string, unknown> | null = null;
    (executionTarget as { runner: unknown }).runner = createLocalSandboxRunner((input) => {
      if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") {
        const script = input.args?.[1] ?? "";
        if (script.includes("PAPERCLIP_PROCESS_SESSION_REQUEST_PATH=") && input.stdin) {
          launchPayload = (JSON.parse(input.stdin) as { config: Record<string, unknown> }).config;
        }
      }
    });

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // The process-session bridge receives its launch env as a DEFERRED thunk —
    // the seam that lets its env-independent setup overlap the paperclip bridge
    // start instead of running strictly after it.
    const processArgs = vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls[0]![0];
    expect(typeof processArgs.env).toBe("function");

    // ...and despite the overlap the launch still observes the MERGED paperclip
    // env: the paperclip-`env` → process-session-launch hand-off stays sequenced
    // under concurrency (bridge base URL + minted bridge token both present, and
    // the token is NOT the host run JWT).
    const payloadEnv = ((launchPayload as Record<string, unknown> | null)?.env ?? {}) as Record<
      string,
      unknown
    >;
    expect(payloadEnv).toMatchObject({ PAPERCLIP_API_BRIDGE_MODE: "queue_v1" });
    expect(String(payloadEnv.PAPERCLIP_API_URL ?? "")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
    expect(payloadEnv.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
  });

  it("does not dispatch the process-session provider mutation before Paperclip bridge success", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    // This row injects the process-session bridge and never dispatches the
    // Git-Bash lifecycle fixture. Advertise custody only for the exact mock.
    executionTarget.runner.supportsProcessTreeCustody = true;
    const paperclipStop = vi.fn(async () => {});
    let resolvePaperclip!: (value: AdapterExecutionTargetPaperclipBridgeHandle) => void;
    const paperclipGate = new Promise<AdapterExecutionTargetPaperclipBridgeHandle>(
      (resolve) => {
        resolvePaperclip = resolve;
      },
    );
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(
      async () => paperclipGate,
    );
    const providerDispatch = vi.fn();
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
      async (input) => {
        if (typeof input.env !== "function") throw new Error("expected deferred launch env");
        await input.env();
        providerDispatch();
        return null;
      },
    );

    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
    });
    const resultPromise = execute({
      runId: "run-bridge-dependency",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    try {
      await expect.poll(
        () => vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls.length,
      ).toBe(1);
      expect(providerDispatch).not.toHaveBeenCalled();
    } finally {
      // Always release the controlled bridge, even when an assertion above
      // fails, so this test cannot retain an in-flight executor fixture.
      resolvePaperclip(paperclipBridgeHandleFixture({
        runId: "run-bridge-dependency",
        remoteCwd,
        env: { PAPERCLIP_API_KEY: "bridge-token" },
        stop: paperclipStop,
      }));
      await Promise.allSettled([resultPromise]);
    }
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(providerDispatch).toHaveBeenCalledTimes(1);
    expect(paperclipStop).toHaveBeenCalledTimes(1);
  });

  it("denies ACPX before staging or either concurrent bridge/provider launch without the exact test capability", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const originalExecute = executionTarget.runner.execute.bind(executionTarget.runner);
    executionTarget.runner.execute = vi.fn(originalExecute);
    const stagedRuntimes = new Map();
    const stagingLocks = new Map<string, Promise<unknown>>();
    const createRuntime = vi.fn(() => buildRuntime() as never);
    const resolveBillingIdentity = vi.fn(async () => ({ provider: "fixture" }));
    const onLog = vi.fn(async () => undefined);
    const onMeta = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);
    const blockedStateDir = path.join(path.dirname(stateDir), "must-not-materialize-disabled");
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockClear();
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockClear();
    const execute = createAcpxEngineExecutorImpl({
      createRuntime,
      resolveBillingIdentity,
      testOnlyEnableRemoteProcessSessionReleaseProtocol: true,
      stagedRuntimes,
      stagingLocks,
    });

    const result = await execute({
      runId: "run-callback-disabled-acpx",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: blockedStateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog,
      onMeta,
      onEvent,
    } as never);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
      errorMeta: { category: "configuration", retryable: false, needsHuman: true },
      resultJson: {
        phase: "preflight",
        paperclipBridgeLaunch: { status: "disabled", retryable: false, needsHuman: true },
      },
    });
    expect(executionTarget.runner.execute).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
    expect(onMeta).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(resolveBillingIdentity).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetProcessSessionBridge).not.toHaveBeenCalled();
    expect(stagedRuntimes.size).toBe(0);
    expect(stagingLocks.size).toBe(0);
    await expect(fs.stat(blockedStateDir)).rejects.toThrow();
  });

  it("returns a dedicated result and retains remote resources when launch acceptance needs reconciliation", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    executionTarget.runner.supportsProcessTreeCustody = true;
    executionTarget.runner.reconcileProcessTreeCustody = async () => false;
    const paperclipStop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("injected callback bridge stop failure"))
      .mockResolvedValue(undefined);
    const managedHomeTeardown = vi.fn(async () => {});
    const stagedRuntimeDispose = vi.fn(async () => {});
    const stagingLocks = new Map<string, Promise<unknown>>();
    const reconcileTerminal = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockResolvedValueOnce(
      paperclipBridgeHandleFixture({
        runId: "run-launch-ambiguous",
        remoteCwd,
        stop: paperclipStop,
      }),
    );
    const launchIdentity = {
      launchId: "launch-ambiguous-1",
      sessionId: "session-ambiguous-1",
      runId: "run-launch-ambiguous",
      adapterKey: "custom_local",
      transport: "sandbox" as const,
      providerKey: "local-test",
      environmentId: "environment-1",
      leaseId: "lease-1",
      remoteCwd,
      sessionDir: path.posix.join(remoteCwd, ".paperclip-runtime", "acpx", "process-sessions", "session-ambiguous-1"),
      eventsDir: path.posix.join(remoteCwd, "events"),
      launchIdentityPath: path.posix.join(remoteCwd, "launch.identity.json"),
      launcherPidPath: path.posix.join(remoteCwd, "launcher.pid"),
      wrapperPidPath: path.posix.join(remoteCwd, "wrapper.pid"),
      launchAcceptedPath: path.posix.join(remoteCwd, "launch.accepted.json"),
      terminalReceiptPath: path.posix.join(remoteCwd, "terminal.receipt.json"),
      childClosedPath: path.posix.join(remoteCwd, "child.closed"),
      wrapperDonePath: path.posix.join(remoteCwd, "wrapper.done"),
    };
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockRejectedValueOnce(
      new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
        launchIdentity,
        "The reconciliation transport was unavailable.",
        { reconcileTerminal },
      ),
    );
    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
      stagedRuntimes: new Map(),
      stagingLocks,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        teardown: managedHomeTeardown,
        disposeStaged: stagedRuntimeDispose,
      }),
    });
    const logs: string[] = [];

    const result = await execute({
      runId: "run-launch-ambiguous",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async (_stream: "stdout" | "stderr", chunk: string) => logs.push(chunk),
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      errorCode: ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS,
      clearSession: true,
      errorMeta: {
        category: "protocol",
        acpCode: ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS,
        retryable: false,
        needsHuman: true,
        acceptedStart: "unknown",
        launchIdentity,
        phase: "setup",
      },
      resultJson: {
        phase: "setup",
        processSessionLaunch: {
          status: "needs_human",
          acceptedStart: "unknown",
          retryable: false,
          ...launchIdentity,
        },
      },
    });
    expect(result.errorMessage).toContain("do not retry");
    expect(logs.join("")).toContain("automatic replay is disabled");
    expect(logs.join("")).toContain("Preserving remote ACP runtime resources");
    expect(paperclipStop).toHaveBeenCalledTimes(1);
    expect(managedHomeTeardown).not.toHaveBeenCalled();
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    expect(stagingLocks.size).toBe(1);

    await expect(reconcileAndReleaseAcpxProcessSessionLaunchResources({
      runId: launchIdentity.runId,
      launchId: launchIdentity.launchId,
    })).resolves.toEqual({
      found: true,
      terminal: false,
      treeCustodyVerified: false,
      cleanupComplete: false,
      released: false,
    });
    expect(paperclipStop).toHaveBeenCalledTimes(2);
    expect(managedHomeTeardown).not.toHaveBeenCalled();
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    expect(stagingLocks.size).toBe(1);

    await expect(reconcileAndReleaseAcpxProcessSessionLaunchResources({
      runId: launchIdentity.runId,
      launchId: launchIdentity.launchId,
    })).resolves.toEqual({
      found: true,
      terminal: true,
      treeCustodyVerified: false,
      cleanupComplete: false,
      released: false,
    });
    expect(paperclipStop).toHaveBeenCalledTimes(2);
    expect(managedHomeTeardown).not.toHaveBeenCalled();
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    expect(stagingLocks.size).toBe(1);

    await expect(reconcileAndReleaseAcpxProcessSessionLaunchResources({
      runId: launchIdentity.runId,
      launchId: launchIdentity.launchId,
    })).resolves.toMatchObject({
      found: true,
      terminal: true,
      treeCustodyVerified: false,
      cleanupComplete: false,
      released: false,
    });
    expect(stagingLocks.size).toBe(1);
  });

  it("retries accepted host-capability cleanup before releasing retained resources", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    executionTarget.runner.supportsProcessTreeCustody = true;
    const stagingLocks = new Map<string, Promise<unknown>>();
    const managedHomeTeardown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient managed-home copy-back failure"))
      .mockResolvedValue(undefined);
    const stagedRuntimeDispose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient private staging cleanup failure"))
      .mockResolvedValue(undefined);
    const acceptedHostCleanup = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient private proxy cleanup failure"))
      .mockResolvedValue(undefined);
    const acceptedProcessStop = vi.fn(async () => {});
    const paperclipStop = vi.fn(async () => {});
    const sessionId = "session-host-cleanup-retry";
    const launchId = "launch-host-cleanup-retry";
    const runId = "run-host-cleanup-retry";
    const sessionDir = path.posix.join(remoteCwd, ".paperclip-runtime", "acpx", "process-sessions", sessionId);
    const deadPid = 2_147_483_646;
    expect(localTestProcessIsAlive(deadPid)).toBe(false);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "launcher.pid"), `${deadPid}\n`, "utf8");
    await fs.writeFile(path.join(sessionDir, "wrapper.pid"), `${deadPid}\n`, "utf8");
    await fs.writeFile(
      path.join(sessionDir, "launch.accepted.json"),
      JSON.stringify({ childPid: deadPid }) + "\n",
      "utf8",
    );
    const launchIdentity = {
      launchId,
      sessionId,
      runId,
      adapterKey: "custom_local",
      transport: "sandbox" as const,
      providerKey: "fake-plugin",
      environmentId: null,
      leaseId: null,
      remoteCwd,
      sessionDir,
      eventsDir: path.posix.join(sessionDir, "events"),
      launchIdentityPath: path.posix.join(sessionDir, "launch.identity.json"),
      launcherPidPath: path.posix.join(sessionDir, "launcher.pid"),
      wrapperPidPath: path.posix.join(sessionDir, "wrapper.pid"),
      launchAcceptedPath: path.posix.join(sessionDir, "launch.accepted.json"),
      terminalReceiptPath: path.posix.join(sessionDir, "terminal.receipt.json"),
      childClosedPath: path.posix.join(sessionDir, "child.closed"),
      wrapperDonePath: path.posix.join(sessionDir, "wrapper.done"),
    };
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockResolvedValueOnce(
      paperclipBridgeHandleFixture({ runId, remoteCwd, stop: paperclipStop }),
    );
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockRejectedValueOnce(
      new AdapterExecutionTargetProcessSessionLaunchAmbiguousError(
        launchIdentity,
        "Host proxy setup failed after acceptance.",
        {
          acceptedStart: "accepted",
          reconcileTerminal: async () => true,
          acceptedProcessSessionController: {
            launchIdentity,
            reconcileTerminal: async () => true,
            stop: acceptedProcessStop,
          },
          cleanupAcceptedHostResources: acceptedHostCleanup,
        },
      ),
    );
    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
      stagedRuntimes: new Map(),
      stagingLocks,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        teardown: managedHomeTeardown,
        disposeStaged: stagedRuntimeDispose,
      }),
    });

    const result = await execute({
      runId,
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    expect(result.errorCode).toBe(ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS);
    await expect(
      reconcileAndReleaseAcpxProcessSessionLaunchResources({ runId, launchId }),
    ).rejects.toThrow("Failed to stop all ACP launch resources");
    expect(acceptedHostCleanup).toHaveBeenCalledTimes(1);
    expect(acceptedProcessStop).toHaveBeenCalledTimes(1);
    expect(managedHomeTeardown).not.toHaveBeenCalled();
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    expect(stagingLocks.size).toBe(1);

    await expect(
      reconcileAndReleaseAcpxProcessSessionLaunchResources({ runId, launchId }),
    ).rejects.toThrow("Failed to complete retained ACP cleanup");
    expect(acceptedHostCleanup).toHaveBeenCalledTimes(2);
    expect(acceptedProcessStop).toHaveBeenCalledTimes(1);
    expect(managedHomeTeardown).toHaveBeenCalledTimes(1);
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    expect(stagingLocks.size).toBe(1);

    await expect(
      reconcileAndReleaseAcpxProcessSessionLaunchResources({ runId, launchId }),
    ).rejects.toThrow("Failed to complete retained ACP cleanup");
    expect(acceptedHostCleanup).toHaveBeenCalledTimes(2);
    expect(acceptedProcessStop).toHaveBeenCalledTimes(1);
    expect(managedHomeTeardown).toHaveBeenCalledTimes(2);
    expect(stagedRuntimeDispose).toHaveBeenCalledTimes(1);
    expect(stagingLocks.size).toBe(1);

    await expect(
      reconcileAndReleaseAcpxProcessSessionLaunchResources({ runId, launchId }),
    ).resolves.toEqual({
      found: true,
      terminal: true,
      treeCustodyVerified: true,
      cleanupComplete: true,
      released: true,
    });
    expect(acceptedHostCleanup).toHaveBeenCalledTimes(2);
    expect(acceptedProcessStop).toHaveBeenCalledTimes(1);
    expect(managedHomeTeardown).toHaveBeenCalledTimes(2);
    expect(stagedRuntimeDispose).toHaveBeenCalledTimes(2);
    expect(stagingLocks.size).toBe(0);
    await Promise.all([
      fs.writeFile(path.join(sessionDir, "terminal.receipt.json"), "{}\n", "utf8"),
      fs.writeFile(path.join(sessionDir, "child.closed"), "closed\n", "utf8"),
      fs.writeFile(path.join(sessionDir, "wrapper.done"), "done\n", "utf8"),
    ]);
  });

  it("uses the registered active controller and keeps cleanup fenced while terminal proof is pending", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    executionTarget.runner.supportsProcessTreeCustody = true;
    executionTarget.runner.reconcileProcessTreeCustody = async () => false;
    const stagingLocks = new Map<string, Promise<unknown>>();
    const managedHomeTeardown = vi.fn(async () => {});
    const stagedRuntimeDispose = vi.fn(async () => {});
    const processStop = vi.fn(async () => {});
    const paperclipStop = vi.fn(async () => {});
    let resolveTerminal!: (value: boolean) => void;
    const terminalGate = new Promise<boolean>((resolve) => {
      resolveTerminal = resolve;
    });
    const reconcileTerminal = vi.fn(() => terminalGate);
    const sessionId = "session-active-controller-1";
    const launchId = "launch-active-controller-1";
    const runId = "run-active-controller-1";
    const sessionDir = path.posix.join(remoteCwd, ".paperclip-runtime", "acpx", "process-sessions", sessionId);
    const launchIdentity = {
      launchId,
      sessionId,
      runId,
      adapterKey: "custom_local",
      transport: "sandbox" as const,
      providerKey: "local-test",
      environmentId: "environment-1",
      leaseId: "lease-1",
      remoteCwd,
      sessionDir,
      eventsDir: path.posix.join(sessionDir, "events"),
      launchIdentityPath: path.posix.join(sessionDir, "launch.identity.json"),
      launcherPidPath: path.posix.join(sessionDir, "launcher.pid"),
      wrapperPidPath: path.posix.join(sessionDir, "wrapper.pid"),
      launchAcceptedPath: path.posix.join(sessionDir, "launch.accepted.json"),
      terminalReceiptPath: path.posix.join(sessionDir, "terminal.receipt.json"),
      childClosedPath: path.posix.join(sessionDir, "child.closed"),
      wrapperDonePath: path.posix.join(sessionDir, "wrapper.done"),
    };
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockResolvedValueOnce(
      paperclipBridgeHandleFixture({ runId, remoteCwd, stop: paperclipStop }),
    );
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockResolvedValueOnce({
      agentCommand: "paperclip-process-session-proxy.mjs",
      launchIdentity,
      reconcileTerminal,
      treeCustody: "unverified",
      stop: processStop,
    });
    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
      stagedRuntimes: new Map(),
      stagingLocks,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        teardown: managedHomeTeardown,
        disposeStaged: stagedRuntimeDispose,
      }),
    });

    const resultPromise = execute({
      runId,
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    try {
      await expect.poll(() => processStop.mock.calls.length).toBe(1);
      expect(paperclipStop).toHaveBeenCalledTimes(1);
      expect(reconcileTerminal).toHaveBeenCalledTimes(1);
      expect(stagingLocks.size).toBe(1);
      expect(managedHomeTeardown).not.toHaveBeenCalled();
      expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    } finally {
      // Always settle the terminal-proof gate and executor so a failed
      // assertion cannot retain the active controller or its staging lease.
      resolveTerminal(true);
      await Promise.allSettled([resultPromise]);
    }
    await expect(resultPromise).rejects.toMatchObject({
      code: ACP_PROCESS_SESSION_LAUNCH_AMBIGUOUS,
      retryable: false,
      needsHuman: true,
      acceptedStart: "accepted",
      launchIdentity: expect.objectContaining({ launchId }),
    });
    expect(stagingLocks.size).toBe(1);
    expect(managedHomeTeardown).not.toHaveBeenCalled();
    expect(stagedRuntimeDispose).not.toHaveBeenCalled();
    await expect(requestStopAndWaitAcpxProcessSessionLaunch({ runId, launchId })).resolves.toMatchObject({
      found: true,
      terminal: true,
      treeCustodyVerified: false,
      cleanupComplete: false,
      released: false,
    });
    expect(processStop).toHaveBeenCalledTimes(1);
  });

  itPosixSandboxLifecycle("test_remote_session_new_uses_in_sandbox_cwd", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // The ACP runtime + session/new both bind to the in-sandbox workspace dir,
    // not the HOST worktree path.
    expect(runtimeOptions[0]?.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]?.cwd).not.toBe(localCwd);
  });

  itPosixSandboxLifecycle("test_remote_warm_handle_reused_after_cwd_change", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: () => buildRuntime(undefined, (input) => ensureInputs.push(input)) as never,
    });
    const base = {
      agent: { id: "agent-1", companyId: "company-1" },
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        mode: "persistent",
        warmHandleIdleMs: 60_000,
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    };

    const first = await execute({ runId: "run-remote-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-remote-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Both runs resolve session/new to the in-sandbox cwd...
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // ...and the second run RESUMES the first session: fingerprint/compat/persist
    // all read the same in-sandbox `sessionCwd`, so a handle created with the
    // in-sandbox cwd is reused, not invalidated, after the HOST→sandbox cwd swap.
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  it("test_local_foundation_unchanged", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const { sessionInputs, runtimeOptions } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
      cwd: localCwd,
    });

    // A local (non-remote) run never crosses the staging seam or starts a
    // bridge, and session/new stays on the HOST cwd — byte-identical to today.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).not.toHaveBeenCalled();
    expect(vi.mocked(startAdapterExecutionTargetPaperclipBridge)).not.toHaveBeenCalled();
    expect(vi.mocked(startAdapterExecutionTargetProcessSessionBridge)).not.toHaveBeenCalled();
    expect(sessionInputs[0]?.cwd).toBe(localCwd);
    expect(runtimeOptions[0]?.cwd).toBe(localCwd);
  });
});

describePosixSandboxLifecycle("ACPX engine remote managed-home seam (PR 2: per-adapter home seed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupRemoteSandbox() {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  it("test_remote_seam_receives_adapter_agnostic_context", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    let captured: Record<string, unknown> | null = null;
    const { sessionInputs, events } = await runExecutor(
      {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        // A user/adapter-config env value proves the seam sees the resolved run env.
        env: { SEAM_MARKER: "seam-marker-value" },
      },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          captured = input as unknown as Record<string, unknown>;
          const stagedRuntime = await input.stage([]);
          return { stagedRuntime };
        },
      },
    );

    // The managed-home seam runs inside the timed stage.sync boundary, so a
    // per-step timing event is emitted for it.
    const stageEvent = events.find(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "stage.sync",
    );
    expect(stageEvent).toBeTruthy();
    expect(typeof stageEvent!.payload?.durationMs).toBe("number");

    // The engine invoked the seam and used the runtime it staged (session/new
    // binds to the in-sandbox workspace dir the seam returned).
    expect(captured).not.toBeNull();
    const context = captured as unknown as Record<string, unknown>;
    // Only generic, adapter-agnostic inputs cross the boundary...
    expect(context.acpxAgent).toBe("custom");
    expect(context.companyId).toBe("company-1");
    expect(context.runId).toBe("run-1");
    expect(context.workspaceLocalDir).toBe(localCwd);
    expect(context.executionTarget).toMatchObject({ kind: "remote", transport: "sandbox" });
    expect(typeof context.stage).toBe("function");
    expect(typeof context.timeoutSec).toBe("number");
    // ...including the resolved run env (adapter config env folded in).
    expect((context.env as Record<string, string>).SEAM_MARKER).toBe("seam-marker-value");
    // ...and NOTHING scoped to a single adapter leaks across the seam. This locks
    // the boundary: the engine must not hand a Gemini/Claude/Codex-specific field
    // (e.g. the former `geminiSkillsHome`) to the generic seam context.
    expect(context).not.toHaveProperty("geminiSkillsHome");
    expect(Object.keys(context).some((key) => /gemini|claude|codex/i.test(key))).toBe(false);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });

  it("test_remote_seam_stages_assets_and_env_remap_reaches_process", async () => {
    const { root, stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    // A managed-home dir the seam ships as an asset (mirrors a per-adapter home).
    const managedHomeDir = path.join(root, "managed-home");
    await fs.mkdir(managedHomeDir, { recursive: true });
    await fs.writeFile(path.join(managedHomeDir, "config.json"), "{}", "utf8");

    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          const stagedRuntime = await input.stage([
            { key: "home", localDir: managedHomeDir, followSymlinks: true },
          ]);
          // Repoint an adapter home env var onto the in-sandbox asset dir; the
          // engine must forward this mutated run env to the spawned process.
          input.env.MANAGED_HOME = stagedRuntime.assetDirs.home ?? "";
          return { stagedRuntime };
        },
      },
    );

    // The seam's asset was threaded through the shared staging seam...
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.assets).toEqual([
      { key: "home", localDir: managedHomeDir, followSymlinks: true },
    ]);
    // ...it really landed in the sandbox (local runner extracts to the asset dir)...
    const remoteAssetDir = String((meta[0]?.env as Record<string, string>).MANAGED_HOME);
    expect(remoteAssetDir).toBeTruthy();
    await expect(fs.readFile(path.join(remoteAssetDir, "config.json"), "utf8")).resolves.toBe("{}");
    // ...the staged asset dir resolves under the run's managed runtime root (an
    // in-sandbox path), not the host managed-home dir.
    expect(remoteAssetDir).toContain(".paperclip-runtime");
    expect(remoteAssetDir).not.toBe(managedHomeDir);
    expect(path.isAbsolute(remoteAssetDir)).toBe(true);
  });

  it("test_remote_seam_teardown_fires_once_on_exit", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    let teardownCalls = 0;
    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          const stagedRuntime = await input.stage([]);
          return {
            stagedRuntime,
            teardown: async () => {
              teardownCalls += 1;
            },
          };
        },
      },
    );

    // The engine fires the seam's teardown exactly once on the exit/cleanup path
    // (mirrors the codex auth copy-back + staged-temp cleanup finally).
    expect(teardownCalls).toBe(1);
  });

  it("test_remote_seam_absent_stages_workspace_only", async () => {
    // Without a seam (custom agents / adapters with no home seed), the remote lane
    // stages the workspace with no home asset — byte-identical to PR-1 behavior.
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.assets ?? []).toEqual([]);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });
});

describePosixSandboxLifecycle("ACPX engine remote session-lifecycle re-staging (PR 3: stage once / reuse on compatible resume)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupRemoteSandbox() {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  // A runtime double that records ensureSession inputs and can be told to make
  // the turn fail (to exercise the teardown/eviction path).
  function recordingRuntime(input: {
    ensureInputs: Array<Record<string, unknown>>;
    terminalStatus?: "completed" | "failed";
  }) {
    return {
      ensureSession: async (session: Record<string, unknown>) => {
        input.ensureInputs.push(session);
        return {
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        };
      },
      startTurn: () => ({
        events: (async function* () {
          yield { type: "done", stopReason: "end_turn" };
        })(),
        result:
          input.terminalStatus === "failed"
            ? Promise.resolve({ status: "failed", error: new Error("boom") })
            : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async () => {},
      }),
      setConfigOption: async () => {},
      close: async () => {},
    };
  }

  function baseExecuteArgs(input: {
    stateDir: string;
    localCwd: string;
    executionTarget: Record<string, unknown>;
    env?: Record<string, string>;
  }) {
    return {
      agent: { id: "agent-1", companyId: "company-1" },
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: input.stateDir,
        cwd: input.localCwd,
        mode: "persistent",
        warmHandleIdleMs: 60_000,
        ...(input.env ? { env: input.env } : {}),
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget: input.executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    };
  }

  it("test_acp_resume_after_launch_release_restages_before_resuming", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Exact launch-bound reconciliation releases the staged workspace/home with
    // each process session. A compatible ACP session may resume, but it must
    // restage a fresh runtime instead of reusing already-disposed resources.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    // Both runs bind session/new (and resume) to the in-sandbox workspace cwd...
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // ...and the second run RESUMES the first session rather than starting fresh.
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  it("test_acp_resume_incompatible_fingerprint_stages_fresh", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
    });

    const first = await execute({
      runId: "run-a",
      runtime: {},
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { FOO: "a" } }),
    } as never);
    // A changed adapter env value shifts the session fingerprint → a different
    // sessionKey → the cache slot does not match, so staging runs fresh.
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { FOO: "b" } }),
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Incompatible fingerprint → staged fresh, no stale reuse.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // The second run does NOT resume the first session (fingerprint differs).
    expect(ensureInputs[1]?.resumeSessionId).toBeUndefined();
  });

  it("test_warm_handle_scoped_per_fingerprint_no_cross_session_credential_reuse", async () => {
    const { root, stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    // Two managed homes, one per session, each carrying a distinct credential
    // marker. The seam seeds whichever home belongs to the current run.
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    await fs.mkdir(homeA, { recursive: true });
    await fs.mkdir(homeB, { recursive: true });
    await fs.writeFile(path.join(homeA, "auth.json"), JSON.stringify({ token: "SECRET-A" }), "utf8");
    await fs.writeFile(path.join(homeB, "auth.json"), JSON.stringify({ token: "SECRET-B" }), "utf8");

    const seededHomeEnv: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        const localHome = input.env.SESSION_MARKER === "b" ? homeB : homeA;
        const stagedRuntime = await input.stage([
          { key: "home", localDir: localHome, followSymlinks: true },
        ]);
        input.env.MANAGED_HOME = stagedRuntime.assetDirs.home ?? "";
        seededHomeEnv.push(input.env.MANAGED_HOME);
        return { stagedRuntime };
      },
    });

    const first = await execute({
      runId: "run-a",
      runtime: {},
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { SESSION_MARKER: "a" } }),
    } as never);
    // Different fingerprint (SESSION_MARKER changed) → different sessionKey. If the
    // cache were NOT fingerprint-scoped, this run could silently inherit session A's
    // staged auth.json without re-seeding. It must instead seed its own home.
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { SESSION_MARKER: "b" } }),
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Each session staged its OWN managed home — no cross-session reuse.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(seededHomeEnv).toHaveLength(2);
    // Session B's staged home holds session B's credential, never session A's.
    const bHome = seededHomeEnv[1]!;
    await expect(fs.readFile(path.join(bHome, "auth.json"), "utf8")).resolves.toContain("SECRET-B");
  });

  it("test_acp_failed_turn_evicts_staged_runtime_so_resume_restages", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      // The first turn fails; the second (compatible) run then completes.
      createRuntime: (() => {
        let call = 0;
        return () => {
          call += 1;
          return recordingRuntime({
            ensureInputs,
            terminalStatus: call === 1 ? "failed" : "completed",
          }) as never;
        };
      })(),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(0);
    // A failed turn discards the staged runtime, so the next run stages fresh
    // instead of reusing a torn-down session's staged credentials.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
  });

  // Greptile P1 "Cache Reuse Bypasses Session Compatibility": a fresh invocation
  // that shares company/agent/task/fingerprint (hence sessionKey) with a prior
  // run but carries NO sessionParams starts a new ACP session — it must NOT
  // inherit the prior session's staged workspace + managed home.
  it("test_acp_reuse_requires_compatible_resume_not_just_session_key", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let seamCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        seamCalls += 1;
        return { stagedRuntime: await input.stage([]) };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    // Same config (identical sessionKey) but sessionParams cleared → this is a
    // NEW session, not a resume of A. The old code reused A's staged runtime on a
    // bare sessionKey hit; the compatibility gate now forces a fresh stage.
    const second = await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Staged (and re-seeded the managed home) fresh for the new session — no
    // silent inheritance of the prior session's staged credentials.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(seamCalls).toBe(2);
    // B binds a fresh session/new (no resumeSessionId), it does not resume A.
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.resumeSessionId).toBeUndefined();
  });

  // Each accepted process-session launch owns one exact copy-back + staged-temp
  // cleanup bundle. Session resume metadata can survive between launches, but
  // launch-bound staging authority cannot remain cached after release.
  it("test_reused_resume_copies_back_and_disposes_each_launch_bound_staging_bundle", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let teardownCalls = 0;
    let disposeCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        const stagedRuntime = await input.stage([]);
        return {
          stagedRuntime,
          teardown: async () => {
            teardownCalls += 1;
          },
          disposeStaged: async () => {
            disposeCalls += 1;
          },
        };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Each accepted launch stages its own workspace/home bundle.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    // Per-run copy-back fired on BOTH runs — cadence unchanged.
    expect(teardownCalls).toBe(2);
    // Exact controller release disposes both launch-bound staging bundles.
    expect(disposeCalls).toBe(2);
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  // The one-time dispose DOES fire when the staged runtime is actually dropped
  // (here: a failed turn), releasing the host staged-temp — the copy-back also
  // still fires on the failure path.
  it("test_dropped_staged_runtime_disposes_host_temp", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let teardownCalls = 0;
    let disposeCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs, terminalStatus: "failed" }) as never,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        teardown: async () => {
          teardownCalls += 1;
        },
        disposeStaged: async () => {
          disposeCalls += 1;
        },
      }),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const result = await execute({ runId: "run-a", runtime: {}, ...base } as never);

    expect(result.exitCode).toBe(1);
    // Failed turn → staged runtime dropped → host staged-temp disposed once, and
    // the per-run copy-back still fired.
    expect(teardownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  it("test_launch_bound_staging_cleanup_waits_for_active_turn_release", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let currentNow = 0;
    let releaseTurn!: () => void;
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });
    const turnCompleted = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const execute = createAcpxEngineExecutor({
      now: () => currentNow,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: (() => {
        let call = 0;
        return () => {
          call += 1;
          return {
            ensureSession: async () => ({
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            }),
            startTurn: () => {
              if (call === 2) signalTurnStarted();
              return {
                events: (async function* () {
                  yield { type: "done", stopReason: "end_turn" };
                })(),
                result:
                  call === 2
                    ? turnCompleted.then(() => ({ status: "completed", stopReason: "end_turn" }))
                    : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
                cancel: async () => {},
              };
            },
            setConfigOption: async () => {},
            close: async () => {},
          } as never;
        };
      })(),
      prepareRemoteManagedHome: async (input) => {
        events.push(`stage:${input.runId}`);
        return {
          stagedRuntime: await input.stage([]),
          disposeStaged: async () => {
            events.push(`dispose:${input.runId}`);
          },
        };
      },
    });
    const base = baseExecuteArgs({
      stateDir,
      localCwd,
      executionTarget,
      env: { SESSION_MARKER: "idle-eviction" },
    });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    expect(first.exitCode).toBe(0);
    expect(events).toEqual(["stage:run-a", "dispose:run-a"]);

    let second: ReturnType<typeof execute> | null = null;
    let third: ReturnType<typeof execute> | null = null;
    try {
      second = execute({
        runId: "run-b",
        runtime: { sessionParams: first.sessionParams },
        ...base,
      } as never);
      await turnStarted;
      currentNow = 10_000;
      third = execute({ runId: "run-c", runtime: {}, ...base } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Run B owns the session staging lease while its turn is active. Run C
      // cannot stage until B's controller has disposed B's launch-bound bundle
      // and released that lease.
      expect(events).toEqual([
        "stage:run-a",
        "dispose:run-a",
        "stage:run-b",
      ]);
    } finally {
      // Always release the controlled turn, even when an assertion above fails,
      // so the test cannot strand a process-session fixture for later cases.
      releaseTurn();
      await Promise.allSettled([second, third].filter(
        (pending): pending is ReturnType<typeof execute> => pending !== null,
      ));
    }

    const [resultB, resultC] = await Promise.all([second!, third!]);

    expect(resultB.exitCode).toBe(0);
    expect(resultC.exitCode).toBe(0);
    expect(events).toEqual([
      "stage:run-a",
      "dispose:run-a",
      "stage:run-b",
      "dispose:run-b",
      "stage:run-c",
      "dispose:run-c",
    ]);
  }, process.platform === "win32" ? 60_000 : 30_000);

  // Superseding an incompatible session that collides on sessionKey re-stages
  // fresh AND releases the superseded entry's host staged-temp (no leak, no
  // reuse of the old session's staged credentials).
  it("test_incompatible_restage_disposes_superseded_staged_temp", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const disposedRunIds: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        disposeStaged: async () => {
          disposedRunIds.push(input.runId);
        },
      }),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    // Run A completes cleanly and caches its staged runtime.
    await execute({ runId: "run-a", runtime: {}, ...base } as never);
    // Run B: same sessionKey, no sessionParams → not a compatible resume. It must
    // drop + dispose A's superseded staged entry, then stage fresh.
    await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    // A's staged temp was disposed when B superseded it.
    expect(disposedRunIds).toContain("run-a");
  });

  // Greptile P1 "Concurrent Runs Corrupt Cache Ownership": two overlapping runs
  // of the same session key must not ship into the same remote workspace at once.
  // The per-key staging lock serializes the stage-or-reuse section, so their
  // staging windows never overlap.
  it("test_concurrent_same_session_staging_is_serialized", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        // Yield to the event loop so an unserialized second run would interleave
        // its own enter here before we finish staging.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return { stagedRuntime };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    // Both runs share the sessionKey (identical config) and start concurrently.
    const [a, b] = await Promise.all([
      execute({ runId: "run-a", runtime: {}, ...base } as never),
      execute({ runId: "run-b", runtime: {}, ...base } as never),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Each staging window is a matched enter/exit pair with no interleaving — the
    // lock serialized them (never enter,enter,...,exit,exit).
    expect(events).toHaveLength(4);
    expect(events[0]).toMatch(/^enter:/);
    expect(events[1]).toBe(`exit:${events[0]!.slice("enter:".length)}`);
    expect(events[2]).toMatch(/^enter:/);
    expect(events[3]).toBe(`exit:${events[2]!.slice("enter:".length)}`);
  });

  // Greptile P1 "Lock Ends Before Use": a same-session re-stage must wait for
  // the prior run's active turn and cleanup to finish before it can touch the
  // staged remote workspace again.
  it("test_concurrent_same_session_staging_waits_for_active_turn_cleanup", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let releaseTurn!: () => void;
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });
    const turnCompleted = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => {
          signalTurnStarted();
          return {
            events: (async function* () {
              yield { type: "done", stopReason: "end_turn" };
            })(),
            result: turnCompleted.then(() => ({ status: "completed", stopReason: "end_turn" })),
            cancel: async () => {},
          };
        },
        setConfigOption: async () => {},
        close: async () => {},
      }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return {
          stagedRuntime,
          disposeStaged: async () => {
            events.push(`dispose:${input.runId}`);
          },
        };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const runA = execute({ runId: "run-a", runtime: {}, ...base } as never);
    await turnStarted;
    let runB: ReturnType<typeof execute> | null = null;
    try {
      runB = execute({ runId: "run-b", runtime: {}, ...base } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).not.toContain("enter:run-b");
    } finally {
      releaseTurn();
      await Promise.allSettled([runA, runB].filter(
        (pending): pending is ReturnType<typeof execute> => pending !== null,
      ));
    }

    await Promise.all([runA, runB!]);

    expect(events).toContain("enter:run-b");
    expect(events).toContain("dispose:run-a");
    expect(events.indexOf("enter:run-b")).toBeGreaterThan(events.indexOf("dispose:run-a"));
  });

  // The per-session lease must be released when a run is abandoned before it
  // reaches the executor's cleanup (e.g. staging or a bridge fails to start),
  // otherwise the next run of the same session waits on the lease forever. Here
  // the first run's staging throws; the second run of the same session must
  // still acquire the lease and stage instead of deadlocking.
  it("test_failed_staging_releases_lease_so_next_same_session_run_proceeds", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let failNextStaging = true;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        setConfigOption: async () => {},
        close: async () => {},
      }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        if (failNextStaging) {
          failNextStaging = false;
          throw new Error("staging boom");
        }
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return { stagedRuntime };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    await expect(execute({ runId: "run-a", runtime: {}, ...base } as never)).rejects.toThrow(
      "staging boom",
    );
    // If the failed run had stranded its lease, this second same-session run
    // would hang on it and the test would time out.
    const resultB = await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(resultB.exitCode).toBe(0);
    expect(events).toContain("enter:run-b");
    expect(events).toContain("exit:run-b");
  });
});

describe("ACPX engine per-step startup timing (run.startup.step events)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stepEvents(events: Array<{ eventType: string; payload?: Record<string, unknown> }>) {
    return events.filter((event) => event.eventType === "run.startup.step");
  }

  itPosixSandboxLifecycle("emits a run.startup.step event for each of the 7 bring-up boundaries with numeric durationMs", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    // A configured CODEX_HOME keeps the codex-home seed deterministic (skips the
    // managed-home copy from the host ~/.codex) so steps 2 and 3 run cleanly.
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      { authToken: "real-run-jwt", executionTarget },
    );

    const steps = stepEvents(events);
    const seen = new Map(steps.map((event) => [String(event.payload?.step), event]));
    // A codex bring-up over the remote sandbox lane crosses all 7 boundaries.
    for (const step of [
      "workspace.resolve",
      "codex-home.seed",
      "skills.reconcile",
      "stage.sync",
      "bridge.paperclip",
      "bridge.process-session",
      "acp.handshake",
    ]) {
      const event = seen.get(step);
      expect(event, `expected a run.startup.step event for "${step}"`).toBeTruthy();
      expect(typeof event!.payload?.durationMs).toBe("number");
      expect(event!.payload?.durationMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  itPosixSandboxLifecycle("emits the 5 non-codex boundaries for a custom-agent sandbox bring-up (no codex steps)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const emitted = new Set(stepEvents(events).map((event) => String(event.payload?.step)));
    // The custom-agent lane skips the codex-only skill prep entirely...
    expect(emitted.has("codex-home.seed")).toBe(false);
    expect(emitted.has("skills.reconcile")).toBe(false);
    // ...but still times the shared workspace/stage/bridge/handshake boundaries.
    for (const step of [
      "workspace.resolve",
      "stage.sync",
      "bridge.paperclip",
      "bridge.process-session",
      "acp.handshake",
    ]) {
      expect(emitted.has(step), `expected a run.startup.step event for "${step}"`).toBe(true);
    }
  });

  itPosixSandboxLifecycle("carries roundTrips + provider durations for sequential startup steps and keeps concurrent bridge steps duration-only", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const steps = stepEvents(events);
    const seen = new Map(steps.map((event) => [String(event.payload?.step), event]));

    // Every timed boundary still records duration.
    for (const event of steps) {
      expect(typeof event.payload?.durationMs).toBe("number");
    }
    // Sequential boundaries retain runner-counter attribution.
    for (const step of ["workspace.resolve", "stage.sync", "acp.handshake"]) {
      expect(typeof seen.get(step)?.payload?.roundTrips).toBe("number");
    }
    // workspace.resolve is host-only → zero host→sandbox execs.
    expect(seen.get("workspace.resolve")?.payload?.roundTrips).toBe(0);
    // stage.sync ships the workspace over the exec seam → at least one round-trip,
    // and the accumulated provider durations scale with it.
    const stageSync = seen.get("stage.sync");
    expect(stageSync?.payload?.roundTrips as number).toBeGreaterThan(0);
    expect(stageSync?.payload?.providerExecMs).toBe(
      (stageSync?.payload?.roundTrips as number) * 600,
    );
    expect(stageSync?.payload?.providerGetMs).toBe(
      (stageSync?.payload?.roundTrips as number) * 15,
    );
    // Concurrent bridge steps are duration-only so they do not double-count
    // shared runner counters while their lifecycles overlap.
    for (const step of ["bridge.paperclip", "bridge.process-session"]) {
      expect(seen.get(step)?.payload?.roundTrips).toBeUndefined();
      expect(seen.get(step)?.payload?.providerExecMs).toBeUndefined();
      expect(seen.get(step)?.payload?.providerGetMs).toBeUndefined();
    }
    // The external ACP client crosses no host exec seam.
    expect(seen.get("acp.handshake")?.payload?.roundTrips).toBe(0);
  });

  itPosixSandboxLifecycle("splits acp.handshake into createRuntimeMs and ensureSessionMs sub-phases", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const handshake = stepEvents(events).find((event) => event.payload?.step === "acp.handshake");
    expect(handshake).toBeTruthy();
    expect(typeof handshake!.payload?.createRuntimeMs).toBe("number");
    expect(handshake!.payload?.createRuntimeMs as number).toBeGreaterThanOrEqual(0);
    expect(typeof handshake!.payload?.ensureSessionMs).toBe("number");
    expect(handshake!.payload?.ensureSessionMs as number).toBeGreaterThanOrEqual(0);
  });

  it("emits no acp.handshake event when a warm-handle hit skips the handshake", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const warmHandles = new Map();
    const secondEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => buildRuntime() as never,
    });
    const config = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      mode: "persistent",
      warmHandleIdleMs: 60_000,
    };
    const first = await execute({
      runId: "run-warm-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    // The second run reuses the warm handle, so the whole handshake block is
    // skipped — it must emit NO acp.handshake event (not a zero-duration one).
    await execute({
      runId: "run-warm-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: (first as { sessionParams?: unknown }).sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        secondEvents.push(event);
      },
    } as never);

    const handshakeEmitted = secondEvents.some(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "acp.handshake",
    );
    expect(handshakeEmitted).toBe(false);
  });

  it("does not emit startup-step events on a local (non-sandbox) run except workspace.resolve", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });

    const { events } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
      cwd: localCwd,
    });

    const emitted = new Set(stepEvents(events).map((event) => String(event.payload?.step)));
    // A local run never crosses the staging seam or starts a bridge, so only the
    // always-run workspace resolution and the ACP handshake are timed.
    expect(emitted.has("workspace.resolve")).toBe(true);
    expect(emitted.has("acp.handshake")).toBe(true);
    expect(emitted.has("stage.sync")).toBe(false);
    expect(emitted.has("bridge.paperclip")).toBe(false);
    expect(emitted.has("bridge.process-session")).toBe(false);
  });
});
