import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  assertPaperclipCallbackBridgeEnabled,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-1", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "gemini-session-1",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: gemini"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  assertPaperclipCallbackBridgeEnabled: vi.fn(() => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    assertPaperclipCallbackBridgeEnabled,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute as executeAdapter } from "./execute.js";
import {
  PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
  PAPERCLIP_EXECUTION_TARGET_INVALID,
} from "@paperclipai/adapter-utils/execution-target";

async function execute(ctx: Parameters<typeof executeAdapter>[0]) {
  return await executeAdapter({
    ...ctx,
    onEvent: ctx.onEvent ?? (async () => undefined),
  });
}

describe("gemini remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each(["ssh", "sandbox"] as const)(
    "fails closed for a valid %s callback target before any adapter side effect",
    async (transport) => {
      const onLog = vi.fn(async () => undefined);
      const onMeta = vi.fn(async () => undefined);
      const onEvent = vi.fn(async () => undefined);
      const onSpawn = vi.fn(async () => undefined);
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-denial-"));
      cleanupDirs.push(rootDir);
      const sideEffectPath = path.join(rootDir, "must-not-exist");
      const runnerExecute = vi.fn();
      const executionTarget = transport === "ssh"
        ? {
            kind: "remote", transport: "ssh", remoteCwd: "/remote/workspace",
            spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote/workspace" },
          }
        : {
            kind: "remote", transport: "sandbox", providerKey: "fixture",
            remoteCwd: "/remote/workspace", runner: { execute: runnerExecute },
          };
      assertPaperclipCallbackBridgeEnabled.mockImplementationOnce(() => {
        throw Object.assign(new Error("callback bridge disabled"), {
          code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED, retryable: false, needsHuman: true,
        });
      });

      await expect(execute({
        executionTarget,
        config: { cwd: sideEffectPath },
        context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
        onLog, onMeta, onEvent, onSpawn,
      } as never)).rejects.toMatchObject({
        code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED, retryable: false, needsHuman: true,
      });

      expect(onLog).not.toHaveBeenCalled();
      expect(onMeta).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onSpawn).not.toHaveBeenCalled();
      await expect(access(sideEffectPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runnerExecute).not.toHaveBeenCalled();
      expect(ensureCommandResolvable).not.toHaveBeenCalled();
      expect(resolveCommandForLogs).not.toHaveBeenCalled();
      expect(runChildProcess).not.toHaveBeenCalled();
      expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
      expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
      expect(runSshCommand).not.toHaveBeenCalled();
      expect(syncDirectoryToSsh).not.toHaveBeenCalled();
      expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["non-object direct", { executionTarget: "remote" }],
    ["empty sandbox cwd", { executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "" } }],
    ["malformed legacy", { executionTransport: { remoteExecution: { host: "127.0.0.1", port: 0 } } }],
    ["invalid direct cannot hide behind valid legacy", {
      executionTarget: { kind: "remtoe", transport: "sandbox", remoteCwd: "/remote/workspace" },
      executionTransport: { remoteExecution: {
        host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote/workspace",
      } },
    }],
  ] as const)("rejects %s target input without local fallback", async (_label, targetInput) => {
    const onLog = vi.fn(async () => undefined);
    const onMeta = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);
    const onSpawn = vi.fn(async () => undefined);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-invalid-"));
    cleanupDirs.push(rootDir);
    const sideEffectPath = path.join(rootDir, "must-not-exist");

    await expect(execute({
      ...targetInput,
      config: { cwd: sideEffectPath },
      context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
      onLog, onMeta, onEvent, onSpawn,
    } as never)).rejects.toMatchObject({
      code: PAPERCLIP_EXECUTION_TARGET_INVALID, retryable: false, needsHuman: true,
    });

    expect(assertPaperclipCallbackBridgeEnabled).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
    expect(onMeta).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onSpawn).not.toHaveBeenCalled();
    await expect(access(sideEffectPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(ensureCommandResolvable).not.toHaveBeenCalled();
    expect(resolveCommandForLogs).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).not.toHaveBeenCalled();
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
  });

  it("leaves explicit local execution unaffected by the remote callback gate", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-local-gate-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    assertPaperclipCallbackBridgeEnabled.mockImplementation(() => {
      throw Object.assign(new Error("unexpected remote gate"), { code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED });
    });
    try {
      await expect(execute({
        runId: "run-local-gate",
        agent: { id: "agent-1", companyId: "company-1", name: "Gemini", adapterType: "gemini_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "gemini", env: { GEMINI_API_KEY: "test-key" } },
        context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
        executionTarget: { kind: "local" },
        onLog: async () => undefined,
      } as never)).resolves.toHaveProperty("exitCode");
      expect(assertPaperclipCallbackBridgeEnabled).not.toHaveBeenCalled();
      expect(runChildProcess).toHaveBeenCalled();
    } finally {
      assertPaperclipCallbackBridgeEnabled.mockImplementation(() => undefined);
    }
  });

  it("prepares the workspace, syncs Gemini skills, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "gemini",
        env: {
          GEMINI_API_KEY: "test-key",
          NO_COLOR: "1",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "gemini-session-1",
      cwd: managedRemoteWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: managedRemoteWorkspace,
      },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/gemini/skills`,
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".gemini/skills"),
      expect.anything(),
    );
    // The headless-auth settings.json write is scoped to managed HOMEs (sandbox
    // transport). SSH targets keep the user's real home, where existing settings
    // stay visible and the adapter must not create files.
    expect(runSshCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".gemini/settings.json"),
      expect.anything(),
    );
    expect(runSshCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("gemini-api-key"),
      expect.anything(),
    );
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
    expect(call?.[3].env.TERM).toBe("xterm-256color");
    expect(call?.[3].env.COLORTERM).toBe("truecolor");
    expect(call?.[3].env.NO_BROWSER).toBe("1");
    expect(call?.[3].env).not.toHaveProperty("NO_COLOR");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("pre-selects gemini-api-key auth in the managed HOME for sandbox execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-sandbox-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const geminiOutput = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "gemini-session-2", model: "gemini-2.5-pro" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      JSON.stringify({
        type: "result",
        status: "success",
        session_id: "gemini-session-2",
        stats: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n");
    const runnerExecute = vi.fn(async (input: { command: string; args?: string[] }) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: input.command === "gemini" ? geminiOutput : "",
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    }));
    const syncIn = vi.fn(async () => ({ operations: [] }));
    const syncOut = vi.fn(async (operations: Array<{ files: Array<{ targetPath: string }> }>) => {
      for (const operation of operations) {
        for (const file of operation.files) {
          await mkdir(file.targetPath, { recursive: true });
        }
      }
      return { operations: [] };
    });

    await execute({
      runId: "run-sandbox-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        // Pin the CLI lane: sandbox targets with a runner now default to ACP,
        // and this test covers the CLI lane's managed-HOME auth flow.
        engine: "cli",
        command: "gemini",
        env: { GEMINI_API_KEY: "test-key" },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "kubernetes",
        remoteCwd: "/remote/workspace",
        runner: { execute: runnerExecute, syncIn, syncOut },
      },
      onLog: async () => {},
    });

    const runnerScripts = runnerExecute.mock.calls.map(
      (call) => `${call[0].command} ${(call[0].args ?? []).join(" ")}`,
    );
    const settingsWrite = runnerScripts.find((script) => script.includes(".gemini/settings.json"));
    expect(settingsWrite).toBeDefined();
    expect(settingsWrite).toContain("gemini-api-key");
    // The managed HOME lives under the per-run runtime root, never a real home.
    expect(settingsWrite).toContain(".paperclip-runtime");
  });

  it("resumes saved Gemini sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "gemini",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("session-123");
  });

  it("restores the remote workspace if skills sync fails after workspace prep", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-gemini-remote-sync-fail-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    syncDirectoryToSsh.mockRejectedValueOnce(new Error("sync failed"));

    await expect(execute({
      runId: "run-sync-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Gemini Builder",
        adapterType: "gemini_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "gemini",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    })).rejects.toThrow("sync failed");

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});
