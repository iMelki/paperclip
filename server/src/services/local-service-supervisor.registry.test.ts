import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectLocalServiceRegistryRecord,
  listLocalServiceRegistryInspections,
  listLocalServiceRegistryRecords,
  removeLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "./local-service-supervisor.js";

const execFileAsync = promisify(execFile);
const cleanupRoots = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  for (const root of cleanupRoots) {
    await fs.rm(root, { recursive: true, force: true });
    cleanupRoots.delete(root);
  }
});

async function useIsolatedRegistry() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-registry-read-"));
  cleanupRoots.add(root);
  const instanceId = `registry-read-${process.pid}-${Date.now()}`;
  process.env.PAPERCLIP_HOME = root;
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  const runtimeDir = path.join(root, "instances", instanceId, "runtime-services");
  await fs.mkdir(runtimeDir, { recursive: true });
  return { root, runtimeDir };
}

function buildRecord(serviceKey: string): LocalServiceRegistryRecord {
  return {
    version: 1,
    serviceKey,
    profileKind: "paperclip-dev",
    serviceName: "Paperclip dev server",
    command: "node scripts/dev-runner.ts",
    cwd: process.cwd(),
    envFingerprint: "focused-registry-test",
    port: null,
    url: null,
    pid: process.pid,
    processGroupId: null,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: null,
    startedAt: "2026-08-03T18:00:00.000Z",
    lastSeenAt: "2026-08-03T18:00:01.000Z",
    metadata: null,
  };
}

function interceptRegistryDirectorySync(
  runtimeDir: string,
  implementation: (input: { call: number; sync: () => Promise<void> }) => Promise<void>,
) {
  const originalOpen = fs.open.bind(fs);
  let calls = 0;
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    const handle = await originalOpen(target, flags, mode);
    if (path.resolve(String(target)) !== path.resolve(runtimeDir)) return handle;
    const originalSync = handle.sync.bind(handle);
    Object.defineProperty(handle, "sync", {
      configurable: true,
      value: async () => {
        calls += 1;
        await implementation({ call: calls, sync: originalSync });
      },
    });
    return handle;
  });
  return () => calls;
}

describe.sequential("local-service registry evidence reads", () => {
  it("returns a validated regular registry record through the pinned directory", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-valid";
    await fs.writeFile(
      path.join(runtimeDir, `${serviceKey}.json`),
      `${JSON.stringify(buildRecord(serviceKey), null, 2)}\n`,
      "utf8",
    );

    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { serviceKey, pid: process.pid },
    });
  });

  it("publishes and removes a valid record only through the trusted real directory", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-write-remove";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);

    await writeLocalServiceRegistryRecord(buildRecord(serviceKey), { state: "absent" });
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { serviceKey },
    });
    await removeLocalServiceRegistryRecord(serviceKey);
    await expect(fs.lstat(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains blocking evidence when published bytes differ from the serialized record", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-publication-content-race";
    const altered = {
      ...buildRecord(serviceKey),
      lastSeenAt: "2026-08-03T18:00:02.000Z",
      metadata: { owner: "same-inode-tamper" },
    };
    const alteredBytes = `${JSON.stringify(altered, null, 2)}\n`;
    const originalLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementationOnce(async (source, destination) => {
      // Mutate the same inode after the pre-link digest and at the publication
      // boundary. Canonical and temp names then expose the altered bytes.
      await fs.writeFile(source, alteredBytes, "utf8");
      await originalLink(source, destination);
    });

    await expect(writeLocalServiceRegistryRecord(
      buildRecord(serviceKey),
      { state: "absent" },
    )).rejects.toThrow(/publication exact content could not be verified.*retained/i);

    const entries = await fs.readdir(runtimeDir);
    const retainedName = entries.find((entry) => (
      entry.startsWith(`.${serviceKey}.`) && entry.endsWith(".tmp")
    ));
    expect(retainedName).toBeDefined();
    await expect(fs.readFile(path.join(runtimeDir, retainedName!), "utf8")).resolves.toBe(
      alteredBytes,
    );
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "invalid",
      reason: "retained_mutation_evidence",
      entryKind: "mutation_evidence",
    });
  });

  it.skipIf(process.platform === "win32")(
    "fsyncs the parent directory after publication and removal namespace transitions",
    async () => {
      const { runtimeDir } = await useIsolatedRegistry();
      const serviceKey = "paperclip-dev-parent-fsync";
      const syncCalls = interceptRegistryDirectorySync(
        runtimeDir,
        async ({ sync }) => await sync(),
      );

      await writeLocalServiceRegistryRecord(buildRecord(serviceKey), { state: "absent" });
      await removeLocalServiceRegistryRecord(serviceKey);

      // Publication link, temp unlink, removal rename, and quarantine unlink.
      expect(syncCalls()).toBeGreaterThanOrEqual(4);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed and retains evidence on a real parent-directory fsync error",
    async () => {
      const { runtimeDir } = await useIsolatedRegistry();
      const serviceKey = "paperclip-dev-parent-fsync-error";
      let injected = false;
      interceptRegistryDirectorySync(runtimeDir, async ({ sync }) => {
        const entries = await fs.readdir(runtimeDir);
        if (injected || !entries.some((entry) => entry.endsWith(".tmp"))) {
          await sync();
          return;
        }
        injected = true;
        throw Object.assign(new Error("simulated directory I/O failure"), { code: "EIO" });
      });

      await expect(writeLocalServiceRegistryRecord(
        buildRecord(serviceKey),
        { state: "absent" },
      )).rejects.toThrow(/parent-directory fsync failed after registry publication \(EIO\)/i);
      await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
        state: "invalid",
        reason: "retained_mutation_evidence",
        entryKind: "mutation_evidence",
      });
      expect((await fs.readdir(runtimeDir)).some((entry) => (
        entry.startsWith(`.${serviceKey}.`) && entry.endsWith(".tmp")
      ))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts only an explicitly unsupported directory-fsync result",
    async () => {
      await useIsolatedRegistry().then(async ({ runtimeDir }) => {
        const serviceKey = "paperclip-dev-parent-fsync-unsupported";
        const syncCalls = interceptRegistryDirectorySync(runtimeDir, async () => {
          throw Object.assign(new Error("directory fsync unsupported"), { code: "EINVAL" });
        });

        await writeLocalServiceRegistryRecord(buildRecord(serviceKey), { state: "absent" });
        await removeLocalServiceRegistryRecord(serviceKey);
        expect(syncCalls()).toBeGreaterThanOrEqual(4);
        await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
          state: "absent",
        });
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "resumes mutation-guard release after one transient post-rename fsync failure",
    async () => {
      const { runtimeDir } = await useIsolatedRegistry();
      const serviceKey = "paperclip-dev-guard-release-retry";
      let injected = false;
      interceptRegistryDirectorySync(runtimeDir, async ({ sync }) => {
        const entries = await fs.readdir(runtimeDir);
        if (
          !injected
          && entries.some((entry) => entry.startsWith(
            `${serviceKey}.json.launch-claim.released-`,
          ))
        ) {
          injected = true;
          throw Object.assign(new Error("transient guard-directory sync failure"), {
            code: "EIO",
          });
        }
        await sync();
      });

      await expect(writeLocalServiceRegistryRecord(
        buildRecord(serviceKey),
        { state: "absent" },
      )).resolves.toBeUndefined();
      expect(injected).toBe(true);
      await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
        state: "valid",
      });
      expect((await fs.readdir(runtimeDir)).some((entry) => (
        entry.includes(".launch-claim")
      ))).toBe(false);
    },
  );

  it("rejects a stale logical writer after a newer record is published", async () => {
    await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-logical-cas";
    const original = buildRecord(serviceKey);
    const newer = {
      ...original,
      lastSeenAt: "2026-08-03T18:00:02.000Z",
      metadata: { writer: "newer" },
    };
    const stale = {
      ...original,
      lastSeenAt: "2026-08-03T18:00:03.000Z",
      metadata: { writer: "stale" },
    };
    await writeLocalServiceRegistryRecord(original, { state: "absent" });
    await writeLocalServiceRegistryRecord(newer, { state: "matches", record: original });

    await expect(writeLocalServiceRegistryRecord(
      stale,
      { state: "matches", record: original },
    )).rejects.toThrow(/logical compare-and-swap expectation changed/i);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { metadata: { writer: "newer" } },
    });
  });

  it("does not overwrite an in-place replacement during registry publication", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-write-cas-race";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    const original = buildRecord(serviceKey);
    const replacement = {
      ...original,
      lastSeenAt: "2026-08-03T18:00:02.000Z",
      metadata: { owner: "concurrent-replacement" },
    };
    const intended = {
      ...original,
      lastSeenAt: "2026-08-03T18:00:03.000Z",
      metadata: { owner: "intended-writer" },
    };
    const replacementBytes = `${JSON.stringify(replacement, null, 2)}\n`;
    await fs.writeFile(registryPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
      // Preserve the inode while changing the exact evidence bytes after the
      // writer's trusted read and before its rename linearization point.
      await fs.writeFile(registryPath, replacementBytes, "utf8");
      return await originalRename(source, destination);
    });

    await expect(writeLocalServiceRegistryRecord(
      intended,
      { state: "matches", record: original },
    )).rejects.toThrow(
      /compare-and-swap target changed.*replacement evidence was restored/i,
    );
    await expect(fs.readFile(registryPath, "utf8")).resolves.toBe(replacementBytes);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { metadata: { owner: "concurrent-replacement" } },
    });
  });

  it("does not hide an in-place replacement during registry removal", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-remove-cas-race";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    const original = buildRecord(serviceKey);
    const replacement = {
      ...original,
      lastSeenAt: "2026-08-03T18:00:02.000Z",
      metadata: { owner: "concurrent-replacement" },
    };
    const replacementBytes = `${JSON.stringify(replacement, null, 2)}\n`;
    await fs.writeFile(registryPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
      await fs.writeFile(registryPath, replacementBytes, "utf8");
      return await originalRename(source, destination);
    });

    await expect(removeLocalServiceRegistryRecord(serviceKey)).rejects.toThrow(
      /removal compare-and-swap identity changed.*replacement evidence was restored/i,
    );
    await expect(fs.readFile(registryPath, "utf8")).resolves.toBe(replacementBytes);
    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "valid",
      record: { metadata: { owner: "concurrent-replacement" } },
    });
  });

  it("refuses to write through a runtime-services directory junction or symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-registry-write-dir-link-"));
    cleanupRoots.add(root);
    const instanceId = `registry-write-dir-link-${process.pid}-${Date.now()}`;
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    const instanceRoot = path.join(root, "instances", instanceId);
    const runtimeDir = path.join(instanceRoot, "runtime-services");
    const outsideDir = path.join(root, "outside-runtime-services");
    const serviceKey = "paperclip-dev-junction-write";
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(
      outsideDir,
      runtimeDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(writeLocalServiceRegistryRecord(
      buildRecord(serviceKey),
      { state: "absent" },
    )).rejects.toThrow(
      /not a trusted regular directory/i,
    );
    await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
  });

  it("refuses to replace or remove final-component symlink evidence", async () => {
    const { root, runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-symlink-mutation";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    const outsidePath = path.join(root, "outside-mutation.json");
    const outsideBytes = `${JSON.stringify(buildRecord(serviceKey))}\n`;
    await fs.writeFile(outsidePath, outsideBytes, "utf8");
    await fs.symlink(outsidePath, registryPath, "file");

    await expect(writeLocalServiceRegistryRecord(
      buildRecord(serviceKey),
      { state: "absent" },
    )).rejects.toThrow(
      /invalid \(unsafe_entry_type\).*retained/i,
    );
    await expect(removeLocalServiceRegistryRecord(serviceKey)).rejects.toThrow(
      /invalid \(unsafe_entry_type\).*retained/i,
    );
    await expect(fs.lstat(registryPath)).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
    expect((await fs.lstat(registryPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe(outsideBytes);
  });

  it("surfaces a retained launch claim with its privacy-safe spawn identity", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-claim";
    const claimPath = path.join(runtimeDir, `${serviceKey}.json.launch-claim`);
    const claimBytes = `${JSON.stringify({
      version: 1,
      serviceKey,
      ownerPid: 5101,
      createdAt: "2026-08-03T18:00:00.000Z",
      nonce: "focused-claim",
      expectedGenerationId: "generation-focused",
      spawn: {
        pid: 5102,
        processGroupId: 5103,
        startedAt: "2026-08-03T18:00:01.000Z",
      },
      ignoredPrivateField: "not projected",
    }, null, 2)}\n`;
    await fs.writeFile(claimPath, claimBytes, "utf8");

    await expect(listLocalServiceRegistryInspections()).resolves.toEqual([
      expect.objectContaining({
        state: "invalid",
        reason: "retained_launch_claim",
        entryKind: "launch_claim",
        launchClaim: {
          version: 1,
          serviceKey,
          purpose: "generation_launch",
          ownerPid: 5101,
          createdAt: "2026-08-03T18:00:00.000Z",
          nonce: "focused-claim",
          expectedGenerationId: "generation-focused",
          spawnJournalState: "recorded",
          spawn: {
            pid: 5102,
            processGroupId: 5103,
            startedAt: "2026-08-03T18:00:01.000Z",
          },
        },
      }),
    ]);
    await expect(listLocalServiceRegistryRecords()).resolves.toEqual([]);
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe(claimBytes);
  });

  it("surfaces retained mutation evidence and blocks canonical write/remove", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-retained-mutation";
    const retainedPath = path.join(
      runtimeDir,
      `.${serviceKey}.5104.3d594650-3438-4fe9-93bb-efafc28f42ce.previous`,
    );
    const retainedBytes = `${JSON.stringify(buildRecord(serviceKey), null, 2)}\n`;
    await fs.writeFile(retainedPath, retainedBytes, "utf8");

    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "invalid",
      reason: "retained_mutation_evidence",
      entryKind: "mutation_evidence",
      filePath: retainedPath,
    });
    await expect(listLocalServiceRegistryInspections()).resolves.toEqual([
      expect.objectContaining({
        state: "invalid",
        reason: "retained_mutation_evidence",
        entryKind: "mutation_evidence",
        filePath: retainedPath,
      }),
    ]);
    await expect(writeLocalServiceRegistryRecord(
      buildRecord(serviceKey),
      { state: "absent" },
    )).rejects.toThrow(
      /retained local service mutation evidence requires human review/i,
    );
    await expect(removeLocalServiceRegistryRecord(serviceKey)).rejects.toThrow(
      /retained local service mutation evidence requires human review/i,
    );
    await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe(retainedBytes);
  });

  it("rejects oversized evidence without reading or removing it", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-oversized";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    const bytes = Buffer.alloc(64 * 1024 + 1, 0x61);
    await fs.writeFile(registryPath, bytes);

    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "invalid",
      reason: "file_too_large",
      entryKind: "registry",
    });
    await expect(fs.stat(registryPath)).resolves.toMatchObject({ size: bytes.length });
  });

  it("surfaces a directory masquerading as a registry JSON file", async () => {
    const { runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-directory";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    await fs.mkdir(registryPath);

    await expect(listLocalServiceRegistryInspections()).resolves.toEqual([
      expect.objectContaining({
        state: "invalid",
        reason: "unsafe_entry_type",
        entryKind: "registry",
        filePath: registryPath,
      }),
    ]);
  });

  it("rejects a final-component symlink instead of following it", async () => {
    const { root, runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-symlink";
    const outsidePath = path.join(root, "outside-registry.json");
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    await fs.writeFile(outsidePath, `${JSON.stringify(buildRecord(serviceKey))}\n`, "utf8");
    await fs.symlink(outsidePath, registryPath, "file");

    await expect(inspectLocalServiceRegistryRecord(serviceKey)).resolves.toMatchObject({
      state: "invalid",
      reason: "unsafe_entry_type",
      entryKind: "registry",
    });
  });

  it("rejects a runtime-services directory symlink instead of trusting its target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-registry-dir-link-"));
    cleanupRoots.add(root);
    const instanceId = `registry-dir-link-${process.pid}-${Date.now()}`;
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    const instanceRoot = path.join(root, "instances", instanceId);
    const runtimeDir = path.join(instanceRoot, "runtime-services");
    const outsideDir = path.join(root, "outside-runtime-services");
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(
      outsideDir,
      runtimeDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(listLocalServiceRegistryInspections()).resolves.toEqual([
      expect.objectContaining({
        state: "invalid",
        reason: "untrusted_registry_directory",
        entryKind: "registry_directory",
        filePath: runtimeDir,
      }),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO candidate without blocking on a read",
    async () => {
      const { runtimeDir } = await useIsolatedRegistry();
      const fifoPath = path.join(runtimeDir, "paperclip-dev-fifo.json");
      await execFileAsync("mkfifo", [fifoPath]);

      await expect(Promise.race([
        listLocalServiceRegistryInspections(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("registry FIFO inspection blocked")),
          2_000,
        )),
      ])).resolves.toEqual([
        expect.objectContaining({
          state: "invalid",
          reason: "unsafe_entry_type",
          entryKind: "registry",
        }),
      ]);
    },
  );

  it("fails closed when the final path identity changes between lstat and open", async () => {
    const { root, runtimeDir } = await useIsolatedRegistry();
    const serviceKey = "paperclip-dev-race";
    const registryPath = path.join(runtimeDir, `${serviceKey}.json`);
    const parkedPath = `${registryPath}.parked`;
    const outsidePath = path.join(root, "outside-race.json");
    await fs.writeFile(registryPath, `${JSON.stringify(buildRecord(serviceKey))}\n`, "utf8");
    await fs.writeFile(outsidePath, `${JSON.stringify(buildRecord(serviceKey))}\n`, "utf8");

    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (target, flags, mode) => {
      await fs.rename(registryPath, parkedPath);
      await fs.symlink(outsidePath, registryPath, "file");
      return await originalOpen(target, flags, mode);
    });

    const inspection = await inspectLocalServiceRegistryRecord(serviceKey);
    expect(inspection).toMatchObject({
      state: "invalid",
      entryKind: "registry",
    });
    expect(["unsafe_entry_type", "path_identity_changed", "unreadable"]).toContain(
      inspection.reason,
    );
  });
});
