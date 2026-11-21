import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALL_MANIFEST_VERSION,
  MANAGED_SHIM_MARKER,
  addManagedPathBlock,
  buildNextManifest,
  FlipCurrentError,
  flipCurrent,
  isManagedExecutable,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallManifest,
  type InstallRecord,
} from "../install-store.js";

function record(payloadPath: string, version: string): InstallRecord {
  return {
    source: "npm",
    version,
    channel: "latest",
    payloadPath,
    installedAt: `2026-07-${version.padStart(2, "0")}T00:00:00.000Z`,
  };
}

// POSIX permission bits are not enforced on Windows: fs.chmod there only
// toggles the read-only attribute, so a private 0o600 file still reports
// 0o666. These mode assertions therefore run on POSIX only (paperclip CI is
// Linux); every other assertion in these tests still runs on Windows.
function expectPosixMode(filePath: string, mode: number): void {
  if (process.platform === "win32") return;
  expect(fs.statSync(filePath).mode & 0o777).toBe(mode);
}

describe("managed install store", () => {
  let root: string;
  let paths: ReturnType<typeof resolveInstallStorePaths>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-store-"));
    paths = resolveInstallStorePaths({
      homeDir: path.join(root, "home"),
      paperclipHome: path.join(root, "home", ".paperclip"),
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the documented npm and git payload layout", () => {
    expect(payloadPathFor(paths, "npm", "2026.720.0")).toBe(
      path.join(paths.cliRoot, "installs", "npm", "2026.720.0"),
    );
    expect(payloadPathFor(paths, "git", "ab12cd34ef56")).toBe(
      path.join(paths.cliRoot, "installs", "git", "ab12cd34ef56"),
    );
  });

  it("writes and reads the manifest atomically with private permissions", () => {
    const payloadPath = payloadPathFor(paths, "npm", "1.2.3");
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloadPath, "1.2.3"),
      previous: [],
    };
    writeInstallManifestAtomic(manifest, paths);
    expect(readInstallManifest(paths)).toEqual(manifest);
    expectPosixMode(paths.manifestPath, 0o600);
  });

  it("leaves the old current payload working when interrupted before rename", () => {
    const oldPayload = payloadPathFor(paths, "npm", "1.0.0");
    const newPayload = payloadPathFor(paths, "npm", "2.0.0");
    fs.mkdirSync(oldPayload, { recursive: true });
    fs.mkdirSync(newPayload, { recursive: true });
    flipCurrent(oldPayload, paths);

    expect(() =>
      flipCurrent(newPayload, paths, {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");

    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
    expect(fs.readdirSync(paths.cliRoot).filter((entry) => entry.startsWith(".current-"))).toEqual([]);
  });

  it("retains current plus two previous payloads and prunes older entries", () => {
    const payloads = ["1", "2", "3", "4"].map((version) => payloadPathFor(paths, "npm", version));
    for (const payload of payloads) fs.mkdirSync(payload, { recursive: true });
    const previousManifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloads[2], "3"),
      previous: [record(payloads[1], "2"), record(payloads[0], "1")],
    };
    const next = buildNextManifest(record(payloads[3], "4"), previousManifest);

    expect(next.previous.map((entry) => entry.version)).toEqual(["3", "2"]);
    expect(pruneInstallPayloads(next, paths)).toEqual([payloads[0]]);
    expect(fs.existsSync(payloads[0])).toBe(false);
    expect(payloads.slice(1).every((payload) => fs.existsSync(payload))).toBe(true);
  });

  it("writes a stable shim with the validated runtime and custom store path", () => {
    writeManagedShim(paths);
    const shim = fs.readFileSync(paths.shimPath, "utf8");
    expect(shim).toContain(process.execPath);
    expect(shim).toContain(paths.currentPath);
    expect(shim).not.toContain("PAPERCLIP_HOME");
    expectPosixMode(paths.shimPath, 0o755);

    const rcPath = path.join(root, "home", ".bashrc");
    expect(addManagedPathBlock(rcPath)).toBe(true);
    expect(addManagedPathBlock(rcPath)).toBe(false);
    fs.chmodSync(rcPath, 0o640);
    expect(removeManagedPathBlock(rcPath)).toBe(true);
    expect(fs.readFileSync(rcPath, "utf8")).not.toContain("paperclipai managed PATH");
    expectPosixMode(rcPath, 0o640);
  });

  it("rejects marker substrings that are not the exact managed shim format", () => {
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, `#!/bin/sh\necho '${MANAGED_SHIM_MARKER}'\n`);

    expect(removeManagedShim(paths)).toBe(false);
    expect(fs.existsSync(paths.shimPath)).toBe(true);
    expect(() => writeManagedShim(paths)).toThrow("non-managed command");
  });

  it("serializes install-store mutations with an exclusive lock", async () => {
    await expect(
      withInstallStoreLock(
        () => withInstallStoreLock(async () => undefined, paths),
        paths,
      ),
    ).rejects.toThrow("already running");
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("recovers a lock owned by a process that no longer exists", async () => {
    const staleToken = "2147483647:stale";
    await withInstallStoreLock(async () => undefined, paths);
    fs.writeFileSync(paths.lockPath, `${staleToken}\n`, { mode: 0o600 });

    await expect(withInstallStoreLock(async () => undefined, paths)).resolves.toBeUndefined();
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("reports managed provenance only for the payload selected by current", () => {
    const manifestPayload = payloadPathFor(paths, "npm", "1.0.0");
    const currentPayload = payloadPathFor(paths, "npm", "2.0.0");
    const executable = path.join(manifestPayload, "node_modules", "paperclipai", "dist", "index.js");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "");
    fs.mkdirSync(currentPayload, { recursive: true });
    flipCurrent(currentPayload, paths);
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(manifestPayload, "1.0.0"),
      previous: [],
    };

    expect(isManagedExecutable(executable, manifest, paths)).toBe(false);
  });

  it("refuses symlinked payload roots and pre-existing non-managed shims", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(paths.installsRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(paths.installsRoot, "npm"), "dir");
    const escapedPayload = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(outside, "1.2.3"));
    expect(() => flipCurrent(escapedPayload, paths)).toThrow("resolves outside");

    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho other-command\n");
    expect(() => writeManagedShim(paths)).toThrow("non-managed command");
  });

  it("refuses symlinked rc files, unsafe shim parents, and multiply linked shims", () => {
    const outsideRc = path.join(root, "outside-rc");
    fs.writeFileSync(outsideRc, "keep\n");
    const rcPath = path.join(root, "home", ".bashrc");
    fs.mkdirSync(path.dirname(rcPath), { recursive: true });
    fs.symlinkSync(outsideRc, rcPath);
    expect(() => addManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(() => removeManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(fs.readFileSync(outsideRc, "utf8")).toBe("keep\n");

    fs.rmSync(rcPath);
    const localDir = path.join(root, "home", ".local");
    const outsideBin = path.join(root, "outside-bin");
    fs.mkdirSync(outsideBin);
    fs.symlinkSync(outsideBin, localDir, "dir");
    expect(() => writeManagedShim(paths)).toThrow("unsafe shim directory");

    fs.rmSync(localDir);
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, `# ${MANAGED_SHIM_MARKER}\n`);
    fs.linkSync(paths.shimPath, path.join(root, "linked-shim"));
    expect(() => writeManagedShim(paths)).toThrow("multiply linked shim");
  });

  // --- flipCurrent: atomic on POSIX, rename-aside with a brief gap on win32 --
  // Tests that pass `platform: "win32"` exercise the rename-aside strategy on
  // every OS (so Linux CI covers its logic); the native test proves the win32
  // path really runs on Windows.

  function payloadWithFiles(version: string): string {
    const payload = payloadPathFor(paths, "npm", version);
    fs.mkdirSync(path.join(payload, "nested", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(payload, "index.js"), `// payload ${version}\n`);
    fs.writeFileSync(
      path.join(payload, "nested", "deeper", "data.bin"),
      Buffer.from([0, 1, 2, 3, 254, 255, ...Buffer.from(version)]),
    );
    return payload;
  }

  function treeBytes(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.set(path.relative(dir, full), fs.readFileSync(full).toString("base64"));
      }
    };
    walk(dir);
    return out;
  }

  function strayEntries(): string[] {
    return fs.readdirSync(paths.cliRoot).filter(
      (entry) => entry.startsWith("current.prev-") || entry.startsWith(".current-"),
    );
  }

  function errnoError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`simulated ${code}`), { code });
  }

  function expectFlipError(fn: () => unknown, code: string): FlipCurrentError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(FlipCurrentError);
      expect((error as FlipCurrentError).code).toBe(code);
      return error as FlipCurrentError;
    }
    throw new Error(`expected FlipCurrentError ${code}, but nothing was thrown`);
  }

  it("runs the platform's own strategy natively and leaves current a directory symlink", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths);
    const result = flipCurrent(newPayload, paths);

    expect(result.strategy).toBe(process.platform === "win32" ? "rename-aside" : "atomic-rename");
    expect(result.leftoverPrevPath).toBeNull();
    // managed-install-check requires this: lstat(current).isSymbolicLink().
    expect(fs.lstatSync(paths.currentPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
    expect(strayEntries()).toEqual([]);
  });

  it("has no gap on POSIX and the documented gap on win32", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths);
    let currentPresentDuringRename: boolean | null = null;
    flipCurrent(newPayload, paths, {
      beforeRename: () => {
        currentPresentDuringRename = fs.existsSync(paths.currentPath);
      },
    });
    expect(currentPresentDuringRename).toBe(process.platform !== "win32");
  });

  it.each([
    { label: "native", platform: undefined },
    { label: "rename-aside", platform: "win32" as const },
  ])("never traverses: the old payload and every file in it survive byte-identical ($label)", ({ platform }) => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    const oldBefore = treeBytes(oldPayload);
    const newBefore = treeBytes(newPayload);
    expect(oldBefore.size).toBe(2);

    flipCurrent(oldPayload, paths, { platform });
    flipCurrent(newPayload, paths, { platform });

    expect(fs.statSync(oldPayload).isDirectory()).toBe(true);
    expect(treeBytes(oldPayload)).toEqual(oldBefore);
    expect(treeBytes(newPayload)).toEqual(newBefore);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
    expect(strayEntries()).toEqual([]);
  });

  it("refuses to remove a previous entry that is no longer a symlink, and leaves it intact", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    let planted = "";
    const error = expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRemovePrev: (prevPath) => {
        // Something replaced the link with a real directory: it must survive.
        fs.unlinkSync(prevPath);
        fs.mkdirSync(path.join(prevPath, "inner"), { recursive: true });
        fs.writeFileSync(path.join(prevPath, "inner", "keep.txt"), "not ours");
        planted = prevPath;
      },
    }), "current-flip-unsafe-prev");

    expect(error.step).toBe("remove-prev");
    expect(fs.readFileSync(path.join(planted, "inner", "keep.txt"), "utf8")).toBe("not ours");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
  });

  it("names both paths and the manual recovery when rename-in AND rollback fail", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });

    const error = expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRename: () => { throw new Error("rename-in boom"); },
      beforeRollback: () => { throw new Error("rollback boom"); },
    }), "current-flip-double-fault");

    const prevLinks = strayEntries().filter((entry) => entry.startsWith("current.prev-"));
    expect(prevLinks).toHaveLength(1);
    const prevPath = path.join(paths.cliRoot, prevLinks[0]!);
    expect(error.message).toContain(paths.currentPath);
    expect(error.message).toContain(prevPath);
    expect(error.message).toContain("rename-in boom");
    expect(error.message).toContain("rollback boom");
    expect(error.message).toMatch(/Rename-Item|mv /);
    expect(fs.existsSync(paths.currentPath)).toBe(false);
    // The last good payload is untouched and still reachable through the link.
    expect(fs.realpathSync(prevPath)).toBe(fs.realpathSync(oldPayload));
  });

  it("restores the single stranded previous link before the next flip", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRename: () => { throw new Error("crash between steps 2 and 3"); },
      beforeRollback: () => { throw new Error("rollback also lost"); },
    }), "current-flip-double-fault");
    expect(fs.existsSync(paths.currentPath)).toBe(false);

    const result = flipCurrent(newPayload, paths, { platform: "win32" });

    expect(result.leftoverPrevPath).toBeNull();
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
    expect(strayEntries()).toEqual([]);
    expect(treeBytes(oldPayload).size).toBe(2);
  });

  it("refuses to guess when current is missing and more than one previous link exists", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    const prevA = path.join(paths.cliRoot, "current.prev-a");
    const prevB = path.join(paths.cliRoot, "current.prev-b");
    fs.symlinkSync(path.relative(paths.cliRoot, oldPayload), prevA, "dir");
    fs.symlinkSync(path.relative(paths.cliRoot, newPayload), prevB, "dir");

    expectFlipError(
      () => flipCurrent(newPayload, paths, { platform: "win32" }),
      "current-flip-ambiguous-recovery",
    );
    expect(fs.lstatSync(prevA).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(prevB).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(paths.currentPath)).toBe(false);
  });

  it("stops on a concurrent flip without rolling back or touching the other prev link", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    const foreignPrev = path.join(paths.cliRoot, "current.prev-other-process");

    const error = expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeMoveAside: () => {
        // Another process moved current aside first.
        if (fs.existsSync(paths.currentPath)) fs.renameSync(paths.currentPath, foreignPrev);
      },
    }), "current-flip-concurrent");

    expect(error.step).toBe("move-aside");
    expect(fs.lstatSync(foreignPrev).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(foreignPrev)).toBe(fs.realpathSync(oldPayload));
    expect(fs.existsSync(paths.currentPath)).toBe(false);
  });

  it("retries transient EPERM/EBUSY/EACCES and then succeeds", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    const transient = ["EPERM", "EBUSY", "EACCES"];
    let attempts = 0;
    flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRename: () => {
        attempts += 1;
        const code = transient[attempts - 1];
        if (code) throw errnoError(code);
      },
    });
    expect(attempts).toBe(4);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
  });

  it("gives up within about one second, names the step, and rolls back", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    let attempts = 0;
    const started = Date.now();
    const error = expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRename: () => {
        attempts += 1;
        throw errnoError("EBUSY");
      },
    }), "current-flip-step-failed");
    const elapsed = Date.now() - started;

    expect(error.step).toBe("rename-in");
    expect(error.message).toContain("step rename-in");
    expect(attempts).toBe(6);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
    expect(strayEntries()).toEqual([]);
  });

  it("does not retry an error that is not transient", () => {
    const oldPayload = payloadWithFiles("1.0.0");
    const newPayload = payloadWithFiles("2.0.0");
    flipCurrent(oldPayload, paths, { platform: "win32" });
    let attempts = 0;
    expectFlipError(() => flipCurrent(newPayload, paths, {
      platform: "win32",
      beforeRename: () => {
        attempts += 1;
        throw errnoError("ENOTDIR");
      },
    }), "current-flip-step-failed");
    expect(attempts).toBe(1);
  });
});
