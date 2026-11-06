// Fork safety regressions preserved from 79648a3 workspace-runtime.test.ts.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellQuotePath } from "@paperclipai/adapter-utils/shell-path";
import * as localServiceSupervisor from "../services/local-service-supervisor.ts";
import {
  resolveShell,
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  findLocalServiceRegistryRecordByRuntimeServiceId,
  isPidAlive,
  isProcessGroupAlive,
  listLocalServiceRegistryRecords,
  normalizeLocalServicePid,
  readLocalServiceProcessGroupId,
  readLocalServicePortOwner,
  readLocalServiceRegistryRecord,
  removeLocalServiceRegistryRecord,
  terminateLocalService,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";

const execFileAsync = promisify(execFile);

describe("fork local-service identity and registry safety", () => {
  const originalHome = process.env.PAPERCLIP_HOME;
  const originalInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const originalShell = process.env.SHELL;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (originalInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstance;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    vi.restoreAllMocks();
  });

  it.skipIf(process.platform !== "win32")(
    "prefers an installed Git POSIX shell on Windows when SHELL is unset",
    () => {
      delete process.env.SHELL;
      const expected = [
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      ].find((candidate) => existsSync(candidate)) ?? "sh";
      expect(resolveShell()).toBe(expected);
    },
  );

  it("accepts only strict positive safe-integer process ids", () => {
    expect(normalizeLocalServicePid(42)).toBe(42);
    expect(normalizeLocalServicePid("42")).toBe(42);
    for (const invalid of [
      -1,
      0,
      Number.MAX_SAFE_INTEGER + 1,
      "-1",
      "0",
      "042",
      "42junk",
      " 42",
      "42 ",
      "9007199254740992",
      null,
      undefined,
    ]) {
      expect(normalizeLocalServicePid(invalid)).toBeNull();
    }
  });

  it("refuses an unverified positive pid without a process-group identity", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => undefined, 1_000);",
    ], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.pid).toBeTypeOf("number");
    try {
      await expect
        .poll(() => isPidAlive(child.pid!), { timeout: 5_000 })
        .toBe(true);
      const refused = await terminateLocalService(
        { pid: child.pid!, processGroupId: null },
        { forceAfterMs: 0 },
      );
      expect(refused).toMatchObject({
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
      });
      expect(isPidAlive(child.pid!)).toBe(true);
    } finally {
      await terminateLocalService(
        { pid: child.pid!, processGroupId: null },
        { forceAfterMs: 2_000, trustedPid: true },
      );
      if (isPidAlive(child.pid!)) child.kill("SIGKILL");
    }
  });

  it.skipIf(process.platform !== "win32")(
    "binds persisted Windows termination to the recorded process creation time",
    async () => {
      const expectedStartedAt = new Date();
      const child = spawn(process.execPath, [
        "-e",
        "setInterval(() => undefined, 1_000);",
      ], {
        stdio: "ignore",
      windowsHide: true,
      });
      expect(child.pid).toBeTypeOf("number");
      try {
        await expect
          .poll(() => isPidAlive(child.pid!), { timeout: 5_000 })
          .toBe(true);
        const staleIdentity = await terminateLocalService(
          { pid: child.pid!, processGroupId: child.pid! },
          { expectedStartedAt: new Date(0), forceAfterMs: 100 },
        );
        expect(staleIdentity).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          outcome: "untrusted_identity",
        });
        expect(isPidAlive(child.pid!)).toBe(true);

        const verified = await terminateLocalService(
          { pid: child.pid!, processGroupId: child.pid! },
          { expectedStartedAt, forceAfterMs: 2_000 },
        );
        expect(verified).toMatchObject({
          attempted: true,
          confirmedStopped: true,
          outcome: "terminated",
        });
        expect(isPidAlive(child.pid!)).toBe(false);
      } finally {
        if (isPidAlive(child.pid!)) child.kill("SIGKILL");
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "does not trust or terminate a reused Windows registry pid without a fresh port owner",
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "setInterval(() => undefined, 1_000);",
      ], {
        stdio: "ignore",
      windowsHide: true,
      });
      expect(child.pid).toBeTypeOf("number");
      const serviceKey = `workspace-runtime-reused-windows-pid-${randomUUID()}`;
      const runtimeServiceId = randomUUID();
      try {
        await expect
          .poll(() => isPidAlive(child.pid!), { timeout: 5_000 })
          .toBe(true);
        await writeLocalServiceRegistryRecord({
          version: 1,
          serviceKey,
          profileKind: "workspace-runtime",
          serviceName: "stale-service",
          command: "node stale-service.cjs",
          cwd: process.cwd(),
          envFingerprint: "stale-windows-pid",
          port: null,
          url: null,
          pid: child.pid!,
          processGroupId: child.pid!,
          provider: "local_process",
          runtimeServiceId,
          reuseKey: null,
          startedAt: new Date(0).toISOString(),
          lastSeenAt: new Date(0).toISOString(),
          metadata: null,
        });

        await expect(
          findLocalServiceRegistryRecordByRuntimeServiceId({
            runtimeServiceId,
            profileKind: "workspace-runtime",
          }),
        ).resolves.toBeNull();
        expect(isPidAlive(child.pid!)).toBe(true);
      } finally {
        await removeLocalServiceRegistryRecord(serviceKey);
        await terminateLocalService(
          { pid: child.pid!, processGroupId: null },
          { forceAfterMs: 2_000, trustedPid: true },
        );
        if (isPidAlive(child.pid!)) child.kill("SIGKILL");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not signal a process for an invalid local-service pid",
    async () => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      try {
        await terminateLocalService(
          { pid: -1, processGroupId: null },
          { forceAfterMs: 0 },
        );
        // `terminateLocalService` may probe liveness with signal 0; the safety
        // boundary is that no terminating signal is sent when our own PGID
        // cannot be resolved.
        const signalCalls = kill.mock.calls.filter(([, signal]) => signal !== 0);
        expect(signalCalls).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "never signals Paperclip's own process group",
    async () => {
      const ownProcessGroupId = await readLocalServiceProcessGroupId(process.pid);
      expect(ownProcessGroupId).not.toBeNull();
      const targetPid = process.pid + 100_000;
      const kill = vi.spyOn(process, "kill").mockReturnValue(false);
      try {
        await terminateLocalService(
          { pid: targetPid, processGroupId: ownProcessGroupId },
          { forceAfterMs: 0, trustedProcessGroup: true },
        );
        expect(kill).not.toHaveBeenCalledWith(-ownProcessGroupId!, expect.anything());
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when Paperclip's own process group cannot be resolved",
    async () => {
      const ownProcessGroupId = await readLocalServiceProcessGroupId(process.pid);
      expect(ownProcessGroupId).not.toBeNull();
      const originalPath = process.env.PATH;
      const kill = vi.spyOn(process, "kill").mockReturnValue(false);
      try {
        process.env.PATH = "";
        await terminateLocalService(
          {
            pid: process.pid + 100_000,
            processGroupId: ownProcessGroupId,
          },
          { forceAfterMs: 0, trustedProcessGroup: true },
        );
        // `terminateLocalService` may probe liveness with signal 0; the safety
        // invariant is that no terminating signal is sent when the own process
        // group cannot be resolved.
        const signalCalls = kill.mock.calls.filter(([, signal]) => signal !== 0);
        expect(signalCalls).toEqual([]);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a historical orphaned process group after its leader identity is gone",
    async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-orphan-no-port-"));
      const serviceScriptPath = path.join(workspaceRoot, "orphan-no-port.cjs");
      await fs.writeFile(
        serviceScriptPath,
        "setInterval(() => undefined, 1_000);",
        "utf8",
      );
      const command = `${shellQuotePath(process.execPath)} ${shellQuotePath(serviceScriptPath)}`;
      const shell = spawn(resolveShell(), [
        "-lc",
        `${command} >/dev/null 2>&1 &`,
      ], {
        cwd: workspaceRoot,
        detached: true,
        stdio: "ignore",
      windowsHide: true,
      });
      const processGroupId = shell.pid;
      expect(processGroupId).toBeTypeOf("number");
      try {
        await new Promise<void>((resolve, reject) => {
          shell.once("error", reject);
          shell.once("exit", () => resolve());
        });
        await expect
          .poll(() => isProcessGroupAlive(processGroupId), { timeout: 5_000 })
          .toBe(true);
        await expect(readLocalServiceProcessGroupId(processGroupId!)).resolves.toBeNull();

        const refused = await terminateLocalService(
          { pid: processGroupId!, processGroupId: processGroupId! },
          { forceAfterMs: 2_000, trustedProcessGroup: true },
        );
        expect(refused).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          outcome: "untrusted_identity",
        });
        expect(isProcessGroupAlive(processGroupId)).toBe(true);
      } finally {
        if (isProcessGroupAlive(processGroupId)) {
          try {
            process.kill(-processGroupId!, "SIGKILL");
          } catch {
            // Ignore cleanup races for the process group created by this test.
          }
        }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("writes registry records atomically and leaves no temporary replacement files", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-atomic-registry-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `atomic-${randomUUID()}`;
    const serviceKey = `workspace-runtime-atomic-${randomUUID()}`;
    const record = {
      version: 1 as const,
      serviceKey,
      profileKind: "workspace-runtime",
      serviceName: "atomic-service",
      command: "node atomic-service.cjs",
      cwd: process.cwd(),
      envFingerprint: "atomic",
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: null,
      provider: "local_process" as const,
      runtimeServiceId: randomUUID(),
      reuseKey: null,
      startedAt: new Date(0).toISOString(),
      lastSeenAt: new Date(0).toISOString(),
      metadata: null,
    };
    try {
      await writeLocalServiceRegistryRecord(record);
      const nextSeenAt = new Date().toISOString();
      await writeLocalServiceRegistryRecord({ ...record, lastSeenAt: nextSeenAt });
      await expect(readLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
        serviceKey,
        lastSeenAt: nextSeenAt,
      });
      const files = await fs.readdir(paperclipHome, { recursive: true });
      expect(files.filter((entry) => String(entry).endsWith(".tmp"))).toEqual([]);
    } finally {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("rejects path-traversing registry keys before creating a file", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-unsafe-registry-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `unsafe-${randomUUID()}`;
    try {
      await expect(writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey: "../escape",
        profileKind: "workspace-runtime",
        serviceName: "unsafe-service",
        command: "node unsafe.cjs",
        cwd: process.cwd(),
        envFingerprint: "unsafe",
        port: null,
        url: null,
        pid: process.pid,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      })).rejects.toThrow("Invalid local service registry key");
      const files = await fs.readdir(paperclipHome, { recursive: true });
      expect(files.filter((entry) => String(entry).endsWith(".json"))).toEqual([]);
    } finally {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("ignores registry JSON whose embedded service key does not match its filename", async () => {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-mismatched-registry-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `mismatch-${randomUUID()}`;
    const serviceKey = `workspace-runtime-mismatch-${randomUUID()}`;
    try {
      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName: "mismatch-service",
        command: "node mismatch.cjs",
        cwd: process.cwd(),
        envFingerprint: "mismatch",
        port: null,
        url: null,
        pid: process.pid,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      });
      const jsonFiles = (await fs.readdir(paperclipHome, { recursive: true }))
        .map((entry) => path.join(paperclipHome, String(entry)))
        .filter((entry) => entry.endsWith(`${serviceKey}.json`));
      expect(jsonFiles).toHaveLength(1);
      const raw = JSON.parse(await fs.readFile(jsonFiles[0]!, "utf8")) as Record<string, unknown>;
      await fs.writeFile(jsonFiles[0]!, JSON.stringify({ ...raw, serviceKey: "different-safe-key" }), "utf8");
      await expect(listLocalServiceRegistryRecords({ profileKind: "workspace-runtime" })).resolves.toEqual([]);
    } finally {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });


  it.skipIf(process.platform !== "win32")(
    "stops the verified Windows process tree including its live child",
    async () => {
      const expectedStartedAt = new Date();
      const child = spawn(process.execPath, ["-e", [
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],",
        "{stdio:'ignore',windowsHide:true});",
        "process.stdout.write(String(child.pid)+'\\n');",
        "setInterval(()=>{},1000);",
      ].join("")], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let descendantPid: number | null = null;
      try {
        descendantPid = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Missing descendant PID")), 5_000);
          child.once("error", (error) => { clearTimeout(timer); reject(error); });
          child.stdout!.once("data", (data) => {
            clearTimeout(timer);
            const pid = normalizeLocalServicePid(String(data).trim());
            if (pid === null) reject(new Error("Invalid descendant PID"));
            else resolve(pid);
          });
        });
        expect(isPidAlive(descendantPid)).toBe(true);
        const result = await terminateLocalService(
          { pid: child.pid!, processGroupId: child.pid! },
          { expectedStartedAt, forceAfterMs: 2_000 },
        );
        expect(result).toMatchObject({ attempted: true, confirmedStopped: true, outcome: "terminated" });
        expect(isPidAlive(child.pid!)).toBe(false);
        await expect.poll(() => isPidAlive(descendantPid!), { timeout: 5_000 }).toBe(false);
      } finally {
        if (isPidAlive(child.pid!)) {
          await terminateLocalService(
            { pid: child.pid!, processGroupId: null },
            { trustedPid: true, forceAfterMs: 2_000 },
          );
        }
        if (descendantPid !== null && isPidAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
      }
    },
    20_000,
  );

  it.each(["owned", "untrusted"])(
    "keeps runtime stop authority for %s services", async (mode) => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-reset-fork-"));
    process.env.PAPERCLIP_HOME = path.join(workspaceRoot, "home");
    process.env.PAPERCLIP_INSTANCE_ID = randomUUID();
    const serviceScript = path.join(workspaceRoot, "service.cjs");
    await fs.writeFile(serviceScript,
      "require('node:http').createServer((req,res)=>res.end('ok'))" +
      ".listen(Number(process.env.PORT), '127.0.0.1');", "utf8");
    let ownedPid: number | null = null;
    try {
      const input = {
        invocationId: randomUUID(),
        actor: { id: null, name: "Board", companyId: randomUUID() },
        issue: null,
        workspace: {
          baseCwd: workspaceRoot, source: "agent_home", projectId: null, workspaceId: null,
          repoUrl: null, repoRef: null, strategy: "project_primary", cwd: workspaceRoot,
          branchName: null, worktreePath: null, warnings: [], created: false,
        },
        config: { workspaceRuntime: { services: [{
          name: "web", command: `${shellQuotePath(process.execPath)} ${shellQuotePath(serviceScript)}`,
          port: { type: "auto" }, lifecycle: "shared", stopPolicy: { type: "manual" },
          readiness: {
            type: "http", urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 10, intervalMs: 100,
          },
        }] } },
        adapterEnv: {},
      } satisfies Parameters<typeof startRuntimeServicesForWorkspaceControl>[0];
      const services = await startRuntimeServicesForWorkspaceControl(input);
      expect(services).toHaveLength(1);
      const service = services[0]!;
      await expect(fetch(service.url!)).resolves.toMatchObject({ ok: true });
      ownedPid = await readLocalServicePortOwner(service.port!);
      expect(ownedPid).not.toBeNull();
      if (mode === "untrusted") {
        const registry = (await listLocalServiceRegistryRecords({ profileKind: "workspace-runtime" }))
          .find((record) => record.runtimeServiceId === service.id);
        expect(registry).toBeDefined();
        // Exercise the caller's refusal path independently of OS identity discovery.
        vi.spyOn(localServiceSupervisor, "terminateLocalService").mockResolvedValueOnce({
          pid: ownedPid!, attempted: false, confirmedStopped: false, outcome: "untrusted_identity",
        });
        await expect(stopRuntimeServicesForExecutionWorkspace({
          executionWorkspaceId: randomUUID(), workspaceCwd: workspaceRoot,
        })).rejects.toThrow("Runtime service termination unconfirmed: untrusted_identity");
        // Refusal must preserve both the live process and its durable ownership record.
        expect(isPidAlive(ownedPid!)).toBe(true);
        await expect(fetch(service.url!)).resolves.toMatchObject({ ok: true });
        await expect(readLocalServiceRegistryRecord(registry!.serviceKey)).resolves.toMatchObject({
          runtimeServiceId: service.id,
        });
        return;
      }
      // Upstream intentionally changed reset to preserve processes by default.
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      await expect.poll(async () => {
        try { await fetch(service.url!); return true; } catch { return false; }
      }, { timeout: 5_000 }).toBe(false);
      expect(await readLocalServicePortOwner(service.port!)).toBeNull();
    } finally {
      vi.restoreAllMocks();
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      if (ownedPid !== null && isPidAlive(ownedPid)) {
        await terminateLocalService(
          { pid: ownedPid, processGroupId: null },
          { trustedPid: true, forceAfterMs: 2_000 },
        );
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);

  it.skipIf(process.platform === "win32")(
    "preserves an orphaned listener's POSIX process group during registry repair",
    async () => {
      try {
        await execFileAsync("lsof", ["-v"]);
      } catch {
        return;
      }

      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-orphan-group-"));
      process.env.PAPERCLIP_HOME = path.join(workspaceRoot, "home");
      process.env.PAPERCLIP_INSTANCE_ID = randomUUID();
      const serviceScriptPath = path.join(workspaceRoot, "orphan-listener.cjs");
      const portProbe = net.createServer();
      await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
      const address = portProbe.address();
      const port = typeof address === "object" && address ? address.port : null;
      await new Promise<void>((resolve, reject) => {
        portProbe.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      expect(port).toBeTypeOf("number");
      await fs.writeFile(
        serviceScriptPath,
        `require("node:http").createServer((_req, res) => res.end("ok")).listen(${port}, "127.0.0.1");`,
        "utf8",
      );

      const command = `${shellQuotePath(process.execPath)} ${shellQuotePath(serviceScriptPath)}`;
      const shell = spawn(resolveShell(), ["-lc", `${command} >/dev/null 2>&1 &`], {
        cwd: workspaceRoot,
        detached: true,
        stdio: "ignore",
      });
      const shellPid = shell.pid;
      expect(shellPid).toBeTypeOf("number");
      await new Promise<void>((resolve, reject) => {
        shell.once("error", reject);
        shell.once("exit", () => resolve());
      });

      const serviceKey = `workspace-runtime-orphan-group-${randomUUID()}`;
      const runtimeServiceId = randomUUID();
      try {
        await expect
          .poll(() => readLocalServicePortOwner(port!), { timeout: 5_000 })
          .not.toBeNull();
        const ownProcessGroupId = await readLocalServiceProcessGroupId(process.pid);
        expect(ownProcessGroupId).not.toBeNull();
        expect(ownProcessGroupId).not.toBe(shellPid);
        await writeLocalServiceRegistryRecord({
          version: 1,
          serviceKey,
          profileKind: "workspace-runtime",
          serviceName: "orphan-listener",
          command,
          cwd: workspaceRoot,
          envFingerprint: "orphan-group",
          port,
          url: `http://127.0.0.1:${port}`,
          pid: shellPid!,
          processGroupId: ownProcessGroupId,
          provider: "local_process",
          runtimeServiceId,
          reuseKey: null,
          startedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          metadata: null,
        });

        const repaired = await findLocalServiceRegistryRecordByRuntimeServiceId({
          runtimeServiceId,
          profileKind: "workspace-runtime",
        });
        expect(repaired?.pid).not.toBe(shellPid);
        expect(repaired?.processGroupId).toBe(shellPid);

        await terminateLocalService(repaired!);
        await expect
          .poll(() => readLocalServicePortOwner(port!), { timeout: 5_000 })
          .toBeNull();
      } finally {
        const ownerPid = await readLocalServicePortOwner(port!);
        if (ownerPid) {
          await terminateLocalService(
            { pid: ownerPid, processGroupId: null },
            { trustedPid: true },
          );
        }
        await removeLocalServiceRegistryRecord(serviceKey);
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );

});
