import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimDevRunnerGeneration,
  claimDevRunnerLaunchOrAdopt,
} from "../services/dev-runner-registry.ts";
import {
  inspectLocalServiceRegistryRecord,
  listLocalServiceRegistryInspections,
  removeLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";

const cleanupRoots = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;

afterEach(async () => {
  if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  for (const root of cleanupRoots) {
    await fs.rm(root, { recursive: true, force: true });
    cleanupRoots.delete(root);
  }
});

async function useIsolatedPaperclipHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-dev-runner-registry-"));
  cleanupRoots.add(root);
  process.env.PAPERCLIP_HOME = root;
  return root;
}

describe("dev-runner registry custody gate", () => {
  it("does not erase durable registry evidence on unverified runner exit paths", async () => {
    const runnerSource = await fs.readFile(
      new URL("../../../scripts/dev-runner.ts", import.meta.url),
      "utf8",
    );
    expect(runnerSource).not.toContain("removeLocalServiceRegistryRecord");
    expect(runnerSource).not.toContain("touchLocalServiceRegistryRecord");
    expect(runnerSource).toContain("launchClaim.recordSpawn");
    expect(runnerSource).toContain('processTreeStatus: "termination_unverified_needs_human"');
    expect(runnerSource).toContain('processTreeStatus: "signal_requested_tree_unverified"');
    expect(runnerSource).toContain("await persistChildGenerationExit");
    expect(runnerSource).toContain("await claimDevRunnerGeneration");
    expect(runnerSource).toContain('reason: "os_backed_whole_tree_exit_unavailable"');
    expect(runnerSource.indexOf("await persistChildGenerationExit")).toBeLessThan(
      runnerSource.indexOf("return { code: outcome.code, signal: outcome.signal }"),
    );
    expect(runnerSource.indexOf("transitionClaim = await claimDevRunnerGeneration")).toBeLessThan(
      runnerSource.indexOf("await stopChildForRestart()"),
    );
    expect(runnerSource.indexOf("const observedChildOutcome")).toBeLessThan(
      runnerSource.indexOf("launchClaim.recordSpawn(spawnIdentity)"),
    );
    expect(runnerSource).toContain('if (process.platform === "win32")');
    expect(runnerSource).toContain('signalDisposition = "not_attempted_posix_pid_identity_unfenced"');
    expect(runnerSource).toContain("live/unproven child PID");
    expect(runnerSource).toContain("The exact launch claim was retained.");
  });

  it("replays deferred child exits and bounds claim-retaining shutdown failure", async () => {
    const runnerSource = await fs.readFile(
      new URL("../../../scripts/dev-runner.ts", import.meta.url),
      "utf8",
    );
    const restartStart = runnerSource.indexOf("async function maybeAutoRestartChild");
    const restartEnd = runnerSource.indexOf("function installDevIntervals", restartStart);
    const restartSource = runnerSource.slice(restartStart, restartEnd);
    const restartFinally = restartSource.lastIndexOf("} finally {");
    const restartFinish = restartSource.indexOf("finishRestartAttempt();", restartFinally);
    const finishStart = runnerSource.indexOf("function finishRestartAttempt");
    const finishEnd = runnerSource.indexOf("function collectWatchedSnapshot", finishStart);
    const finishSource = runnerSource.slice(finishStart, finishEnd);

    expect(runnerSource).toContain("pendingWrapperExitAfterRestart = {");
    expect(restartFinally).toBeGreaterThan(0);
    expect(restartFinish).toBeGreaterThan(restartFinally);
    expect(restartSource.match(/finishRestartAttempt\(\);/g)).toHaveLength(5);
    expect(finishSource.indexOf("restartInFlight = false;")).toBeLessThan(
      finishSource.indexOf("flushPendingWrapperExitAfterRestart();"),
    );

    const shutdownStart = runnerSource.indexOf("async function shutdown");
    const shutdownEnd = runnerSource.indexOf('process.on("SIGINT"', shutdownStart);
    const shutdownSource = runnerSource.slice(shutdownStart, shutdownEnd);
    expect(shutdownSource).toContain("if (shuttingDown) {");
    expect(shutdownSource).toContain("shutdown is already in progress");
    expect(shutdownSource).toContain("const signalAccepted = child.kill(signal);");
    expect(shutdownSource).toContain("if (!signalAccepted) {");
    expect(shutdownSource).toContain("exit = await waitForChildExitBounded();");
    expect(shutdownSource.indexOf("exit = await waitForChildExitBounded();")).toBeLessThan(
      shutdownSource.indexOf("await shutdownClaim.release();"),
    );
    expect(runnerSource).toContain("child exit was not observed within ${timeoutMs}ms");
    expect(runnerSource).toContain("generation claim and process evidence were retained");
  });

  it("holds an exclusive claim until the absent registry is durably published", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-absent-${randomUUID()}`;

    const firstGate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-absent",
      port: null,
    });
    expect(firstGate.adopted).toBeNull();
    expect(firstGate.launchClaim).not.toBeNull();
    const beforeIdentity = await fs.lstat(firstGate.launchClaim!.filePath);
    expect(beforeIdentity).toMatchObject({
      isFile: expect.any(Function),
    });
    const initialPayload = JSON.parse(
      await fs.readFile(firstGate.launchClaim!.filePath, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(initialPayload).sort()).toEqual([
      "createdAt",
      "expectedGenerationId",
      "nonce",
      "ownerPid",
      "purpose",
      "serviceKey",
      "spawn",
      "version",
    ]);
    expect(initialPayload).toMatchObject({
      version: 1,
      serviceKey,
      purpose: "generation_launch",
      ownerPid: process.pid,
      expectedGenerationId: null,
      spawn: null,
    });
    expect(firstGate.launchClaim!.generationId).toBe(initialPayload.nonce);

    const spawnIdentity = {
      pid: 4242,
      processGroupId: 4242,
      startedAt: "2026-08-03T18:00:00.000Z",
    };
    firstGate.launchClaim!.recordSpawn(spawnIdentity);
    firstGate.launchClaim!.recordSpawn(spawnIdentity);
    const afterIdentity = await fs.lstat(firstGate.launchClaim!.filePath);
    expect({ dev: afterIdentity.dev, ino: afterIdentity.ino }).toEqual({
      dev: beforeIdentity.dev,
      ino: beforeIdentity.ino,
    });
    const recordedLines = (await fs.readFile(firstGate.launchClaim!.filePath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(recordedLines).toHaveLength(2);
    expect(recordedLines[0]).toMatchObject({
      nonce: firstGate.launchClaim!.generationId,
      spawn: null,
    });
    expect(recordedLines[1]).toMatchObject({
      nonce: firstGate.launchClaim!.generationId,
      spawn: spawnIdentity,
    });
    expect(JSON.stringify(recordedLines)).not.toMatch(/command|cwd|env|metadata/i);
    expect(() => firstGate.launchClaim!.recordSpawn({
      ...spawnIdentity,
      pid: 4243,
    })).toThrow(/different spawn identity/i);
    await expect(claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-absent",
      port: null,
    })).rejects.toThrow(/launch claim already exists.*retained for human review/i);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "absent",
    });
    await expect(firstGate.launchClaim!.release()).rejects.toThrow(
      /spawn evidence without a verified registry publication.*retained/i,
    );
    await expect(fs.readFile(firstGate.launchClaim!.filePath, "utf8")).resolves.toContain(
      `"nonce":"${firstGate.launchClaim!.generationId}"`,
    );
  });

  it("rejects spawn recording as soon as a pre-spawn release is requested", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-release-race-${randomUUID()}`;
    const gate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-release-race",
      port: null,
    });
    const claim = gate.launchClaim!;
    const pendingRelease = claim.release();
    expect(() => claim.recordSpawn({
      pid: 4242,
      processGroupId: null,
      startedAt: "2026-08-03T18:00:00.000Z",
    })).toThrow(/release is already pending/i);
    await pendingRelease;
    await expect(claim.release()).resolves.toBeUndefined();
    await expect(fs.lstat(claim.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects raw registry writes and removals beneath an active launch claim", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-raw-mutation-${randomUUID()}`;
    const gate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-raw-mutation",
      port: null,
    });
    const claim = gate.launchClaim!;
    const now = "2026-08-03T18:00:00.000Z";
    await expect(writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey,
      profileKind: "paperclip-dev",
      serviceName: "Paperclip dev server",
      command: "dev-runner.ts",
      cwd: process.cwd(),
      envFingerprint: "test-raw-mutation",
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: null,
      provider: "local_process",
      runtimeServiceId: null,
      reuseKey: null,
      startedAt: now,
      lastSeenAt: now,
      metadata: null,
    }, { state: "absent" })).rejects.toThrow(
      /active local service launch-claim.*matching claim coordination identity/i,
    );
    await expect(removeLocalServiceRegistryRecord(serviceKey)).rejects.toThrow(
      /active local service launch-claim.*matching claim coordination identity/i,
    );
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "absent",
    });
    await claim.release();
  });

  it("preserves the immutable claim header when spawn-journal evidence is partial", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-partial-spawn-${randomUUID()}`;
    const gate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-partial-spawn",
      port: null,
    });
    const claim = gate.launchClaim!;
    const headerBytes = await fs.readFile(claim.filePath, "utf8");
    await fs.appendFile(claim.filePath, '{"version":1,"serviceKey":', "utf8");

    expect(() => claim.recordSpawn({
      pid: 4242,
      processGroupId: null,
      startedAt: "2026-08-03T18:00:00.000Z",
    })).toThrow(/journal length changed.*retained/i);
    await expect(fs.readFile(claim.filePath, "utf8")).resolves.toMatch(
      new RegExp(`^${headerBytes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await expect(listLocalServiceRegistryInspections()).resolves.toContainEqual(
      expect.objectContaining({
        state: "invalid",
        reason: "retained_launch_claim",
        launchClaim: expect.objectContaining({
          nonce: claim.generationId,
          spawn: null,
          spawnJournalState: "partial_or_corrupt",
        }),
      }),
    );
  });

  it("surfaces a retained release artifact and retries exact release after restoration", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-release-retry-${randomUUID()}`;
    const gate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-release-retry",
      port: null,
    });
    const claim = gate.launchClaim!;
    const releasedPath = `${claim.filePath}.released-${claim.generationId}`;
    await fs.rename(claim.filePath, releasedPath);

    await expect(claim.release()).rejects.toThrow();
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "invalid",
      reason: "retained_launch_claim",
      entryKind: "launch_claim",
      launchClaim: {
        nonce: claim.generationId,
        spawnJournalState: "not_recorded_or_write_failed",
      },
    });
    await expect(claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-release-retry",
      port: null,
    })).rejects.toThrow(/retained_launch_claim.*retained/i);

    await fs.rename(releasedPath, claim.filePath);
    await expect(claim.release()).resolves.toBeUndefined();
    await expect(fs.lstat(claim.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains same-inode claim tampering and retries release only after exact restoration", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-release-content-${randomUUID()}`;
    const gate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-release-content",
      port: null,
    });
    const claim = gate.launchClaim!;
    const originalBytes = await fs.readFile(claim.filePath, "utf8");
    const tamperedServiceKey = `${serviceKey.slice(0, -1)}x`;
    const tamperedBytes = originalBytes.replace(serviceKey, tamperedServiceKey);
    expect(tamperedBytes).toHaveLength(originalBytes.length);
    await fs.writeFile(claim.filePath, tamperedBytes, "utf8");

    await expect(claim.release()).rejects.toThrow(/exact content changed.*retained/i);
    await expect(fs.readFile(claim.filePath, "utf8")).resolves.toBe(tamperedBytes);

    await fs.writeFile(claim.filePath, originalBytes, "utf8");
    await expect(claim.release()).resolves.toBeUndefined();
    await expect(fs.lstat(claim.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generation-CAS fences stale exits and durably publishes spawn identity first", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-generation-${randomUUID()}`;
    const firstGate = await claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-generation",
      port: 3100,
    });
    const firstClaim = firstGate.launchClaim!;
    const firstSpawn = {
      pid: 4242,
      processGroupId: null,
      startedAt: "2026-08-03T18:00:00.000Z",
    };
    firstClaim.recordSpawn(firstSpawn);
    const firstRecord = {
      version: 1 as const,
      serviceKey,
      profileKind: "paperclip-dev",
      serviceName: "Paperclip dev server",
      command: "dev-runner.ts",
      cwd: process.cwd(),
      envFingerprint: "test-generation",
      port: 3100,
      url: "http://127.0.0.1:3100",
      pid: process.pid,
      processGroupId: null,
      provider: "local_process" as const,
      runtimeServiceId: null,
      reuseKey: null,
      startedAt: firstSpawn.startedAt,
      lastSeenAt: firstSpawn.startedAt,
      metadata: {
        childPid: firstSpawn.pid,
        childGenerationId: firstClaim.generationId,
        childGenerationStartedAt: firstSpawn.startedAt,
        childProcessGroupId: firstSpawn.processGroupId,
        childGenerationStatus: "running",
      },
    };
    await expect(firstClaim.release()).rejects.toThrow(
      /spawn evidence without a verified registry publication.*retained/i,
    );
    await expect(firstClaim.publishNextGeneration({
      ...firstRecord,
      metadata: {
        ...firstRecord.metadata,
        childPid: firstSpawn.pid + 1,
      },
    })).rejects.toThrow(/does not match the fsynced spawn identity/i);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "absent",
    });
    await firstClaim.publishNextGeneration(firstRecord);
    await firstClaim.release();

    const transition = await claimDevRunnerGeneration({
      serviceKey,
      expectedGenerationId: firstClaim.generationId,
    });
    expect(transition.expectedGenerationId).toBe(firstClaim.generationId);
    await expect(claimDevRunnerGeneration({
      serviceKey,
      expectedGenerationId: firstClaim.generationId,
    })).rejects.toThrow(/launch claim already exists.*retained for human review/i);

    await Promise.all([
      transition.patchExpectedGeneration({
        metadata: {
          childPid: null,
          childGenerationStatus: "exited_unverified",
        },
      }),
      transition.patchExpectedGeneration({
        metadata: {
          restartDeferralReason: "os_backed_whole_tree_exit_unavailable",
          processTreeStatus: "restart_deferred_tree_exit_unproven",
        },
      }),
    ]);
    const patchedInspection = await inspectLocalServiceRegistryRecord(serviceKey);
    expect(patchedInspection).toMatchObject({ state: "valid" });
    if (patchedInspection.state !== "valid") throw new Error("Expected patched generation.");
    const exited = patchedInspection.record;
    expect(exited.metadata).toMatchObject({
      childPid: null,
      childGenerationId: firstClaim.generationId,
      childGenerationStatus: "exited_unverified",
      restartDeferralReason: "os_backed_whole_tree_exit_unavailable",
      processTreeStatus: "restart_deferred_tree_exit_unproven",
    });

    const replacementSpawn = {
      pid: 4343,
      processGroupId: null,
      startedAt: "2026-08-03T18:01:00.000Z",
    };
    transition.recordSpawn(replacementSpawn);
    await transition.publishNextGeneration({
      ...exited,
      startedAt: replacementSpawn.startedAt,
      lastSeenAt: replacementSpawn.startedAt,
      metadata: {
        ...(exited.metadata ?? {}),
        childPid: replacementSpawn.pid,
        childGenerationId: transition.generationId,
        childGenerationStartedAt: replacementSpawn.startedAt,
        childProcessGroupId: replacementSpawn.processGroupId,
        childGenerationStatus: "running",
      },
    });
    await transition.release();

    await expect(claimDevRunnerGeneration({
      serviceKey,
      expectedGenerationId: firstClaim.generationId,
    })).rejects.toThrow(/does not match.*stale evidence was not written/i);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: {
        pid: process.pid,
        metadata: {
          childPid: replacementSpawn.pid,
          childGenerationId: transition.generationId,
          childGenerationStartedAt: replacementSpawn.startedAt,
          childProcessGroupId: replacementSpawn.processGroupId,
          childGenerationStatus: "running",
        },
      },
    });
  });

  it("retains and rejects valid-but-unadoptable dead-root evidence before spawn", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-retained-${randomUUID()}`;
    const now = new Date("2026-08-03T15:00:00.000Z").toISOString();
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey,
      profileKind: "paperclip-dev",
      serviceName: "Paperclip dev server",
      command: "dev-runner.ts",
      cwd: process.cwd(),
      envFingerprint: "test-retained",
      port: null,
      url: null,
      pid: 999_999_999,
      processGroupId: null,
      provider: "local_process",
      runtimeServiceId: null,
      reuseKey: null,
      startedAt: now,
      lastSeenAt: now,
      metadata: null,
    }, { state: "absent" });

    await expect(claimDevRunnerLaunchOrAdopt({
      serviceKey,
      profileKind: "paperclip-dev",
      serviceName: "Paperclip dev server",
      command: "dev-runner.ts",
      cwd: process.cwd(),
      envFingerprint: "test-retained",
      port: null,
    })).rejects.toThrow(/unverified registry process evidence.*retained for human review/i);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { pid: 999_999_999, serviceKey },
    });
  });

  it.each(["tmp", "previous", "remove"])(
    "blocks launch while case-aliased retained .%s mutation evidence exists",
    async (suffix) => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-retained-mutation-${randomUUID()}`;
    const absent = await inspectLocalServiceRegistryRecord(serviceKey);
    const retainedPath = path.join(
      path.dirname(absent.filePath),
      `.${serviceKey.toUpperCase()}.5105.466b7244-ed25-4356-aec1-9e159bff57d4.${suffix.toUpperCase()}`,
    );
    await fs.mkdir(path.dirname(absent.filePath), { recursive: true });
    await fs.writeFile(retainedPath, "retained mutation evidence\n", "utf8");

    await expect(claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-retained-mutation",
      port: null,
    })).rejects.toThrow(
      /invalid pre-existing registry evidence \(retained_mutation_evidence\).*retained/i,
    );
    await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe(
      "retained mutation evidence\n",
    );
    await expect(fs.lstat(`${absent.filePath}.launch-claim`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    },
  );

  it("retains malformed registry bytes instead of treating them as absence", async () => {
    await useIsolatedPaperclipHome();
    const serviceKey = `dev-runner-invalid-${randomUUID()}`;
    const absent = await inspectLocalServiceRegistryRecord(serviceKey);
    const malformed = "{\"version\":1,\n";
    await fs.mkdir(path.dirname(absent.filePath), { recursive: true });
    await fs.writeFile(absent.filePath, malformed, "utf8");

    await expect(claimDevRunnerLaunchOrAdopt({
      serviceKey,
      cwd: process.cwd(),
      envFingerprint: "test-invalid",
      port: null,
    })).rejects.toThrow(/invalid pre-existing registry evidence.*retained for human review/i);
    await expect(fs.readFile(absent.filePath, "utf8")).resolves.toBe(malformed);
    await expect(fs.lstat(`${absent.filePath}.launch-claim`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
