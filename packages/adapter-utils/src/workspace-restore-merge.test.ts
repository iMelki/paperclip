import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureDirectorySnapshot,
  mergeDirectoryWithBaseline,
  withDirectoryMergeLock,
} from "./workspace-restore-merge.js";

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it.each([
    ["empty", ""],
    ["partial", '{"version":1'],
  ])("treats an %s lock publication as live/unproven", async (_label, contents) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-lock-publication-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const lockPath = `${targetDir}.paperclip-restore.lock`;
    await mkdir(targetDir);
    await writeFile(lockPath, contents, { mode: 0o600 });
    const entered = vi.fn();

    vi.useFakeTimers();
    try {
      const outcome = withDirectoryMergeLock(targetDir, async () => entered())
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(31_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Timed out waiting for workspace restore lock");
      expect(entered).not.toHaveBeenCalled();
      await expect(readFile(lockPath, "utf8")).resolves.toBe(contents);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent merge-lock holders", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-lock-concurrent-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    await mkdir(targetDir);
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let active = 0;
    let maxActive = 0;
    let secondEntered = false;

    const first = withDirectoryMergeLock(targetDir, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      firstEntered();
      await firstGate;
      active -= 1;
    });
    await firstStarted;
    const second = withDirectoryMergeLock(targetDir, async () => {
      secondEntered = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  it("reclaims only an exact valid dead-owner lock", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-lock-dead-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const lockPath = `${targetDir}.paperclip-restore.lock`;
    await mkdir(targetDir);
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      token: "dead-owner-token-0001",
      pid: 999_999_999,
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    let entered = false;

    await withDirectoryMergeLock(targetDir, async () => { entered = true; });

    expect(entered).toBe(true);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete a successor claim when the holder path is swapped", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-lock-successor-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const lockPath = `${targetDir}.paperclip-restore.lock`;
    const displacedPath = `${lockPath}.displaced`;
    await mkdir(targetDir);
    const successor = `${JSON.stringify({
      version: 1,
      token: "successor-owner-token-0001",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`;

    await expect(withDirectoryMergeLock(targetDir, async () => {
      await rename(lockPath, displacedPath);
      await writeFile(lockPath, successor, { mode: 0o600 });
    })).rejects.toThrow(/identity changed before release/i);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(successor);
  });

  it("fails loud when source enumeration disappears without mutating target bytes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-source-missing-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const sourceDir = path.join(rootDir, "missing-source");
    await mkdir(targetDir);
    const targetFile = path.join(targetDir, "auth.json");
    await writeFile(targetFile, "host-original\n", "utf8");
    const baseline = await captureDirectorySnapshot(targetDir);

    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir }))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(targetFile, "utf8")).resolves.toBe("host-original\n");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a replaced target-root symlink before invoking merge callbacks",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-root-symlink-"));
      cleanupDirs.push(rootDir);
      const targetDir = path.join(rootDir, "target");
      const sourceDir = path.join(rootDir, "source");
      const outsideDir = path.join(rootDir, "outside");
      await mkdir(targetDir);
      await mkdir(sourceDir);
      await mkdir(outsideDir);
      await writeFile(path.join(outsideDir, "sentinel.txt"), "outside-safe\n", "utf8");
      const baseline = await captureDirectorySnapshot(targetDir);
      await rm(targetDir, { recursive: true, force: true });
      await symlink(outsideDir, targetDir, "dir");
      const beforeApply = vi.fn(async () => undefined);
      const afterApply = vi.fn(async () => undefined);

      await expect(mergeDirectoryWithBaseline({
        baseline,
        sourceDir,
        targetDir,
        beforeApply,
        afterApply,
      })).rejects.toThrow(/target root must remain a real directory/i);

      expect(beforeApply).not.toHaveBeenCalled();
      expect(afterApply).not.toHaveBeenCalled();
      await expect(readFile(path.join(outsideDir, "sentinel.txt"), "utf8"))
        .resolves.toBe("outside-safe\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops before afterApply when beforeApply replaces the target-root identity",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-root-swap-"));
      cleanupDirs.push(rootDir);
      const targetDir = path.join(rootDir, "target");
      const sourceDir = path.join(rootDir, "source");
      const outsideDir = path.join(rootDir, "outside");
      await mkdir(targetDir);
      await mkdir(sourceDir);
      await mkdir(outsideDir);
      await writeFile(path.join(outsideDir, "sentinel.txt"), "outside-safe\n", "utf8");
      const baseline = await captureDirectorySnapshot(targetDir);
      const afterApply = vi.fn(async () => undefined);

      await expect(mergeDirectoryWithBaseline({
        baseline,
        sourceDir,
        targetDir,
        beforeApply: async () => {
          await rm(targetDir, { recursive: true, force: true });
          await symlink(outsideDir, targetDir, "dir");
        },
        afterApply,
      })).rejects.toThrow(/target root must remain a real directory/i);

      expect(afterApply).not.toHaveBeenCalled();
      await expect(readFile(path.join(outsideDir, "sentinel.txt"), "utf8"))
        .resolves.toBe("outside-safe\n");
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses nested writes through a host symlink ancestor",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-symlink-"));
      cleanupDirs.push(rootDir);
      const targetDir = path.join(rootDir, "target");
      const sourceDir = path.join(rootDir, "source");
      const outsideDir = path.join(rootDir, "outside");
      await mkdir(path.join(targetDir, "a"), { recursive: true });
      await mkdir(path.join(sourceDir, "a"), { recursive: true });
      await mkdir(outsideDir);
      await writeFile(path.join(targetDir, "a", "base.txt"), "base\n", "utf8");
      await writeFile(path.join(sourceDir, "a", "base.txt"), "base\n", "utf8");
      await writeFile(path.join(outsideDir, "sentinel.txt"), "outside-safe\n", "utf8");
      const baseline = await captureDirectorySnapshot(targetDir);
      await writeFile(path.join(sourceDir, "a", "new.txt"), "sandbox-change\n", "utf8");
      await rm(path.join(targetDir, "a"), { recursive: true, force: true });
      await symlink(outsideDir, path.join(targetDir, "a"), "dir");

      await expect(mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir }))
        .rejects.toThrow(/symlink ancestor/i);
      await expect(readFile(path.join(outsideDir, "sentinel.txt"), "utf8"))
        .resolves.toBe("outside-safe\n");
      await expect(readFile(path.join(outsideDir, "new.txt"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not delete an outside directory through a host symlink ancestor",
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-delete-symlink-"));
      cleanupDirs.push(rootDir);
      const targetDir = path.join(rootDir, "target");
      const sourceDir = path.join(rootDir, "source");
      const outsideDir = path.join(rootDir, "outside");
      await mkdir(path.join(targetDir, "a", "b"), { recursive: true });
      await mkdir(path.join(sourceDir, "a"), { recursive: true });
      await mkdir(path.join(outsideDir, "b"), { recursive: true });
      const baseline = await captureDirectorySnapshot(targetDir);
      await rm(path.join(targetDir, "a"), { recursive: true, force: true });
      await symlink(outsideDir, path.join(targetDir, "a"), "dir");

      await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });

      await expect(readFile(path.join(targetDir, "a", "missing"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(mkdir(path.join(outsideDir, "b", "still-present")))
        .resolves.toBeUndefined();
    },
  );

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
