import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { stopRegisteredDevServices } from "../services/dev-service-control.ts";
import type { LocalServiceRegistryRecord } from "../services/local-service-supervisor.ts";

const execFileAsync = promisify(execFile);
const devServiceScriptPath = fileURLToPath(new URL("../../../scripts/dev-service.ts", import.meta.url));
const tsxLoaderUrl = pathToFileURL(
  fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
).href;

function buildRecord(
  overrides: Partial<LocalServiceRegistryRecord> = {},
): LocalServiceRegistryRecord {
  return {
    version: 1,
    serviceKey: "paperclip-dev-test",
    profileKind: "paperclip-dev",
    serviceName: "paperclip-dev",
    command: "pnpm dev",
    cwd: "C:\\workspace\\paperclip",
    envFingerprint: "test",
    port: 3100,
    url: "http://127.0.0.1:3100",
    pid: 4242,
    processGroupId: 4242,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: "2026-08-03T04:00:00.000Z",
    lastSeenAt: "2026-08-03T04:01:00.000Z",
    metadata: null,
    ...overrides,
  };
}

describe("dev-service control", () => {
  it("derives records and invalid evidence from one registry inspection snapshot", async () => {
    const source = await fs.readFile(devServiceScriptPath, "utf8");
    expect(source.match(/await listLocalServiceRegistryInspections\(\)/g)).toHaveLength(1);
    expect(source).not.toContain("listLocalServiceRegistryRecords");
  });

  it.each(["list", "stop"])("%s reports malformed registry evidence and exits needs-human", async (command) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-service-invalid-"));
    const paperclipHome = path.join(tempRoot, "paperclip-home");
    const instanceId = "dev-service-invalid-test";
    const runtimeDir = path.join(paperclipHome, "instances", instanceId, "runtime-services");
    const registryPath = path.join(runtimeDir, "paperclip-dev-invalid.json");
    const malformedBytes = "{\"version\":1,\n";
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(registryPath, malformedBytes, "utf8");

    try {
      let failure: { code?: string | number; stdout?: string; stderr?: string } | null = null;
      try {
        await execFileAsync(
          process.execPath,
          ["--import", tsxLoaderUrl, devServiceScriptPath, command],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: instanceId,
            },
          },
        );
      } catch (error) {
        failure = error as { code?: string | number; stdout?: string; stderr?: string };
      }

      expect({
        code: Number(failure?.code),
        output: `${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`,
      }).toMatchObject({
        code: 2,
        output: expect.stringMatching(
          /Needs human review[\s\S]*invalid local-service registry[\s\S]*malformed_json/i,
        ),
      });
      await expect(fs.readFile(registryPath, "utf8")).resolves.toBe(malformedBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["list", "stop"])("%s reports retained launch-claim spawn identity and exits needs-human", async (command) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-service-claim-"));
    const paperclipHome = path.join(tempRoot, "paperclip-home");
    const instanceId = "dev-service-claim-test";
    const runtimeDir = path.join(paperclipHome, "instances", instanceId, "runtime-services");
    const claimPath = path.join(runtimeDir, "paperclip-dev-retained.json.launch-claim");
    const claim = {
      version: 1,
      serviceKey: "paperclip-dev-retained",
      ownerPid: 4101,
      createdAt: "2026-08-03T18:00:00.000Z",
      nonce: "retained-claim-test",
      expectedGenerationId: "generation-42",
      spawn: {
        pid: 4102,
        processGroupId: 4103,
        startedAt: "2026-08-03T18:00:01.000Z",
      },
    };
    const claimBytes = `${JSON.stringify(claim, null, 2)}\n`;
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(claimPath, claimBytes, "utf8");

    try {
      let failure: { code?: string | number; stdout?: string; stderr?: string } | null = null;
      try {
        await execFileAsync(
          process.execPath,
          ["--import", tsxLoaderUrl, devServiceScriptPath, command],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: instanceId,
            },
          },
        );
      } catch (error) {
        failure = error as { code?: string | number; stdout?: string; stderr?: string };
      }

      expect({
        code: Number(failure?.code),
        output: `${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`,
      }).toMatchObject({
        code: 2,
        output: expect.stringMatching(
          /retained_launch_claim[\s\S]*nonce=retained-claim-test[\s\S]*expectedGenerationId=generation-42[\s\S]*ownerPid=4101[\s\S]*spawnPid=4102[\s\S]*processGroupId=4103[\s\S]*startedAt=2026-08-03T18:00:01\.000Z/i,
        ),
      });
      await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(claimBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["list", "stop"])("%s reports a partial spawn journal without claiming no spawn", async (command) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-service-partial-claim-"));
    const paperclipHome = path.join(tempRoot, "paperclip-home");
    const instanceId = "dev-service-partial-claim-test";
    const runtimeDir = path.join(paperclipHome, "instances", instanceId, "runtime-services");
    const claimPath = path.join(runtimeDir, "paperclip-dev-partial.json.launch-claim");
    const header = {
      version: 1,
      serviceKey: "paperclip-dev-partial",
      ownerPid: 4201,
      createdAt: "2026-08-03T18:00:00.000Z",
      nonce: "partial-claim-test",
      expectedGenerationId: null,
      spawn: null,
    };
    const claimBytes = `${JSON.stringify(header)}\n{"version":1,"serviceKey":"paperclip-dev-partial","nonce":`;
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(claimPath, claimBytes, "utf8");

    try {
      let failure: { code?: string | number; stdout?: string; stderr?: string } | null = null;
      try {
        await execFileAsync(
          process.execPath,
          ["--import", tsxLoaderUrl, devServiceScriptPath, command],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: instanceId,
            },
          },
        );
      } catch (error) {
        failure = error as { code?: string | number; stdout?: string; stderr?: string };
      }

      const output = `${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`;
      expect(Number(failure?.code)).toBe(2);
      expect(output).toMatch(
        /retained_launch_claim[\s\S]*nonce=partial-claim-test[\s\S]*ownerPid=4201[\s\S]*spawn=partial-or-corrupt-needs-human/i,
      );
      expect(output).not.toMatch(/spawn=not-recorded-or-write-failed/i);
      await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(claimBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports a retained registry mutation guard without implying a child spawn", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-service-mutation-guard-"));
    const paperclipHome = path.join(tempRoot, "paperclip-home");
    const instanceId = "dev-service-mutation-guard-test";
    const runtimeDir = path.join(paperclipHome, "instances", instanceId, "runtime-services");
    const claimPath = path.join(runtimeDir, "paperclip-dev-guard.json.launch-claim");
    const claimBytes = `${JSON.stringify({
      version: 1,
      serviceKey: "paperclip-dev-guard",
      purpose: "registry_mutation_guard",
      ownerPid: 4301,
      createdAt: "2026-08-03T18:00:00.000Z",
      nonce: "mutation-guard-test",
      expectedGenerationId: null,
      spawn: null,
    })}\n`;
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(claimPath, claimBytes, "utf8");

    try {
      let failure: { code?: string | number; stdout?: string; stderr?: string } | null = null;
      try {
        await execFileAsync(
          process.execPath,
          ["--import", tsxLoaderUrl, devServiceScriptPath, "list"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: instanceId,
            },
          },
        );
      } catch (error) {
        failure = error as { code?: string | number; stdout?: string; stderr?: string };
      }

      const output = `${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`;
      expect(Number(failure?.code)).toBe(2);
      expect(output).toMatch(
        /purpose=registry_mutation_guard[\s\S]*nonce=mutation-guard-test[\s\S]*ownerPid=4301[\s\S]*mutationGuard=active-or-release-incomplete/i,
      );
      expect(output).not.toMatch(/spawn=/i);
      await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(claimBytes);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retains registry evidence and fails nonzero for a persisted-only live process", async () => {
    const removeRegistryRecord = vi.fn(async () => undefined);
    const error = vi.fn();

    const result = await stopRegisteredDevServices([buildRecord()], {
      platform: "linux",
      isPidAlive: () => true,
      isProcessGroupAlive: () => true,
      removeRegistryRecord,
      log: vi.fn(),
      error,
    });

    expect(result).toEqual({
      staleRegistrationsRemoved: 0,
      needsHuman: 1,
      exitCode: 2,
    });
    expect(removeRegistryRecord).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no signal was sent.*retained/i));
  });

  it("retains unprobeable Windows process-group evidence when the wrapper pid is dead", async () => {
    const removeRegistryRecord = vi.fn(async () => undefined);
    const error = vi.fn();

    const result = await stopRegisteredDevServices([buildRecord()], {
      platform: "win32",
      isPidAlive: () => false,
      isProcessGroupAlive: () => false,
      removeRegistryRecord,
      log: vi.fn(),
      error,
    });

    expect(result).toEqual({
      staleRegistrationsRemoved: 0,
      needsHuman: 1,
      exitCode: 2,
    });
    expect(removeRegistryRecord).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/unproven.*retained/i));
  });

  it("retains the production Windows null-group shape when wrapper and recorded child pids are dead", async () => {
    const removeRegistryRecord = vi.fn(async () => undefined);
    const error = vi.fn();

    const result = await stopRegisteredDevServices([
      buildRecord({ processGroupId: null, metadata: { childPid: 4343 } }),
    ], {
      platform: "win32",
      isPidAlive: () => false,
      isProcessGroupAlive: () => false,
      removeRegistryRecord,
      log: vi.fn(),
      error,
    });

    expect(result).toEqual({
      staleRegistrationsRemoved: 0,
      needsHuman: 1,
      exitCode: 2,
    });
    expect(removeRegistryRecord).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/tree evidence.*retained/i));
  });

  it.each([null, 4242])(
    "retains POSIX registration when PID and process-group probes are absent (pgid %s)",
    async (processGroupId) => {
    const removeRegistryRecord = vi.fn(async () => undefined);
    const error = vi.fn();

    const result = await stopRegisteredDevServices([buildRecord({ processGroupId })], {
      platform: "linux",
      isPidAlive: () => false,
      isProcessGroupAlive: () => false,
      removeRegistryRecord,
      log: vi.fn(),
      error,
    });

    expect(result).toEqual({
      staleRegistrationsRemoved: 0,
      needsHuman: 1,
      exitCode: 2,
    });
    expect(removeRegistryRecord).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/pidfd.*retained/i));
    },
  );
});
