import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: Buffer.from("{}").toString("base64"), stderr: "" })),
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

describe("codex remote execution", () => {
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
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-denial-"));
      cleanupDirs.push(rootDir);
      const sideEffectPath = path.join(rootDir, "must-not-exist");
      const runnerExecute = vi.fn();
      const executionTarget = transport === "ssh"
        ? {
            kind: "remote",
            transport: "ssh",
            remoteCwd: "/remote/workspace",
            spec: {
              host: "127.0.0.1",
              port: 2222,
              username: "fixture",
              remoteCwd: "/remote/workspace",
            },
          }
        : {
            kind: "remote",
            transport: "sandbox",
            providerKey: "fixture",
            remoteCwd: "/remote/workspace",
            runner: { execute: runnerExecute },
          };
      assertPaperclipCallbackBridgeEnabled.mockImplementationOnce(() => {
        throw Object.assign(new Error("callback bridge disabled"), {
          code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
          retryable: false,
          needsHuman: true,
        });
      });

      await expect(execute({
        executionTarget,
        config: { cwd: sideEffectPath },
        context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
        onLog,
        onMeta,
        onEvent,
        onSpawn,
      } as never)).rejects.toMatchObject({
        code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
        retryable: false,
        needsHuman: true,
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
    ["misspelled direct kind", { executionTarget: { kind: "remtoe" } }],
    ["malformed legacy", { executionTransport: { remoteExecution: { host: "127.0.0.1" } } }],
    [
      "invalid direct cannot hide behind valid legacy",
      {
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "" },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: "/remote/workspace",
          },
        },
      },
    ],
  ] as const)("rejects %s target input without local fallback", async (_label, targetInput) => {
    const onLog = vi.fn(async () => undefined);
    const onMeta = vi.fn(async () => undefined);
    const onEvent = vi.fn(async () => undefined);
    const onSpawn = vi.fn(async () => undefined);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-invalid-"));
    cleanupDirs.push(rootDir);
    const sideEffectPath = path.join(rootDir, "must-not-exist");

    await expect(execute({
      ...targetInput,
      config: { cwd: sideEffectPath },
      context: { paperclipWorkspace: { cwd: sideEffectPath, source: "project_primary" } },
      onLog,
      onMeta,
      onEvent,
      onSpawn,
    } as never)).rejects.toMatchObject({
      code: PAPERCLIP_EXECUTION_TARGET_INVALID,
      retryable: false,
      needsHuman: true,
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
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-local-gate-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    assertPaperclipCallbackBridgeEnabled.mockImplementation(() => {
      throw Object.assign(new Error("unexpected remote gate"), {
        code: PAPERCLIP_CALLBACK_BRIDGE_DISABLED,
      });
    });
    try {
      await expect(execute({
        runId: "run-local-gate",
        agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "codex" },
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

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
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

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    // The home asset now syncs a curated *staged* allowlist dir, not the raw
    // managed CODEX_HOME, and carries no `exclude` denylist.
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
      followSymlinks?: boolean;
      exclude?: string[];
    };
    expect(homeSyncArgs.localDir).not.toBe(codexHomeDir);
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(homeSyncArgs.followSymlinks).toBe(true);
    expect(homeSyncArgs.exclude).toBeUndefined();

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
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
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("stages only the allowlist into the home asset: keeps config.toml/skills/auth, drops session+sqlite state, no exclude", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-allowlist-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

    // Seed the managed home with the files Codex needs (config.toml carries a
    // provider-routing block; skills injected) plus large runtime decoys the
    // old 4-name denylist missed.
    await writeFile(path.join(codexHomeDir, "auth.json"), '{"tokens":{"account_id":"a","refresh_token":"r"}}', "utf8");
    await writeFile(
      path.join(codexHomeDir, "config.toml"),
      'model_provider = "bifrost"\n\n[model_providers.bifrost]\nname = "bifrost"\n',
      "utf8",
    );
    await writeFile(path.join(codexHomeDir, "instructions.md"), "hi\n", "utf8");
    await mkdir(path.join(codexHomeDir, "skills", "demo"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "skills", "demo", "SKILL.md"), "# demo\n", "utf8");
    // Decoys:
    await writeFile(path.join(codexHomeDir, "logs_2.sqlite"), "x", "utf8");
    await writeFile(path.join(codexHomeDir, "state_5.sqlite"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "sessions"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "sessions", "rollout.jsonl"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "tmp"), { recursive: true });
    await symlink("/usr/bin/env", path.join(codexHomeDir, "tmp", "arg0"));

    // Snapshot the staged dir contents at sync time — execute() removes the
    // staged temp dir on teardown, so we cannot read it after execute returns.
    let stagedSnapshot:
      | { localDir: string; entries: string[]; skillEntries: string[]; configToml: string; authJson: string }
      | null = null;
    (syncDirectoryToSsh as unknown as {
      mockImplementationOnce: (fn: (args: { localDir: string }) => Promise<void>) => void;
    }).mockImplementationOnce(async (args: { localDir: string }) => {
      const entries = (await readdir(args.localDir)).sort();
      const skillEntries = entries.includes("skills")
        ? (await readdir(path.join(args.localDir, "skills"))).sort()
        : [];
      const configToml = entries.includes("config.toml")
        ? await readFile(path.join(args.localDir, "config.toml"), "utf8")
        : "";
      const authJson = entries.includes("auth.json")
        ? await readFile(path.join(args.localDir, "auth.json"), "utf8")
        : "";
      stagedSnapshot = { localDir: args.localDir, entries, skillEntries, configToml, authJson };
    });

    await execute({
      runId: "run-allowlist",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
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

    expect(stagedSnapshot).not.toBeNull();
    const snap = stagedSnapshot as unknown as {
      localDir: string;
      entries: string[];
      skillEntries: string[];
      configToml: string;
      authJson: string;
    };
    // Allowlist present; decoys gone.
    expect(snap.entries).toEqual(
      ["auth.json", "config.json", "config.toml", "instructions.md", "skills"]
        .filter((e) => e !== "config.json") // no config.json was seeded
        .sort(),
    );
    for (const decoy of ["logs_2.sqlite", "state_5.sqlite", "sessions", "tmp", "plugins"]) {
      expect(snap.entries).not.toContain(decoy);
    }
    // Phase-3 behavioral invariants: provider routing + skills + auth survive staging.
    expect(snap.configToml).toContain("[model_providers.bifrost]");
    expect(snap.configToml).toContain("model_provider");
    expect(snap.skillEntries).toContain("demo");
    expect(snap.authJson).toContain("refresh_token");

    // The staged temp dir is removed after execute completes (cleanup on teardown).
    await expect(readdir(snap.localDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
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

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
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
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
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

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
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
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
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

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("runs in place at the authoritative root without archive prepare or restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-in-place-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-in-place",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "codex", env: { CODEX_HOME: codexHomeDir } },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "task_session",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/copied/workspace",
        workspaceRealization: {
          mode: "in_place",
          authoritativeRoot: "/app",
          pathAliases: [],
          outboundRestorePaths: [],
        },
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
    };
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe("/app/.paperclip-runtime/codex/home");
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe("/app");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_REALIZATION_MODE).toBe("in_place");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT).toBe("/app");
    expect(call?.[3].env.CODEX_HOME).toBe("/app/.paperclip-runtime/codex/home");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe("/app");
  });
});
