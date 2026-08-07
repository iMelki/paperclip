import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { shouldExcludePath } from "./exclude-patterns.js";

type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry>;
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkDirectory(
  root: string,
  exclude: readonly string[],
  relative = "",
  out: Map<string, SnapshotEntry> = new Map(),
): Promise<Map<string, SnapshotEntry>> {
  const current = relative ? path.join(root, relative) : root;
  // Snapshot enumeration is an authority boundary. Missing/unreadable/IO-raced
  // directories must fail loud: treating them as empty would turn a source read
  // failure into host-side deletion of every unchanged baseline entry.
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExcludePath(nextRelative, exclude)) continue;

    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath);
    if (!stats.isDirectory() && !stats.isSymbolicLink() && !stats.isFile()) {
      continue;
    }

    if (stats.isDirectory()) {
      out.set(nextRelative, { kind: "dir" });
      await walkDirectory(root, exclude, nextRelative, out);
      continue;
    }

    if (stats.isSymbolicLink()) {
      out.set(nextRelative, {
        kind: "symlink",
        target: await fs.readlink(fullPath),
      });
      continue;
    }

    out.set(nextRelative, {
      kind: "file",
      mode: stats.mode,
      hash: await hashFile(fullPath),
    });
  }

  return out;
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

interface LockFileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryMergeLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
}

type DirectoryMergeLockInspection =
  | { state: "missing" }
  | { state: "unproven"; reason: string }
  | { state: "valid"; identity: LockFileIdentity; owner: DirectoryMergeLockOwner };

function sameLockIdentity(left: LockFileIdentity, right: LockFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseDirectoryMergeLockOwner(raw: string): DirectoryMergeLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DirectoryMergeLockOwner>;
    if (
      parsed.version !== 1 ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 16 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return parsed as DirectoryMergeLockOwner;
  } catch {
    return null;
  }
}

async function inspectDirectoryMergeLock(
  lockPath: string,
): Promise<DirectoryMergeLockInspection> {
  let handle;
  try {
    handle = await fs.open(lockPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unproven", reason: "lock file could not be opened" };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { state: "unproven", reason: "lock path is not a regular file" };
    const raw = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    const beforeIdentity = { dev: before.dev, ino: before.ino };
    const afterIdentity = { dev: after.dev, ino: after.ino };
    if (!sameLockIdentity(beforeIdentity, afterIdentity)) {
      return { state: "unproven", reason: "lock identity changed while reading" };
    }
    const owner = parseDirectoryMergeLockOwner(raw);
    if (!owner) {
      // This includes the intentional open('wx') -> write+fsync publication
      // window. Incomplete/unreadable evidence is never proof of staleness.
      return { state: "unproven", reason: "lock owner publication is incomplete or malformed" };
    }
    return { state: "valid", identity: beforeIdentity, owner };
  } catch {
    return { state: "unproven", reason: "lock owner evidence could not be read" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function holderIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and every unknown probe failure mean live/unproven. Only ESRCH is
    // affirmative absence authority.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function restoreUnexpectedQuarantine(
  quarantinePath: string,
  lockPath: string,
): Promise<void> {
  try {
    // link() is exclusive at the canonical name. It cannot overwrite a newer
    // claimant; on success unlinking the quarantine preserves the exact inode.
    await fs.link(quarantinePath, lockPath);
    await fs.unlink(quarantinePath);
  } catch {
    // Leave the unexpected inode at its unique quarantine path for diagnosis;
    // never delete an identity we did not authorize.
  }
}

async function reclaimDeadDirectoryMergeLock(
  lockPath: string,
  observed: Extract<DirectoryMergeLockInspection, { state: "valid" }>,
): Promise<boolean> {
  const quarantinePath = `${lockPath}.stale-${observed.owner.token}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const moved = await inspectDirectoryMergeLock(quarantinePath);
  if (
    moved.state !== "valid" ||
    !sameLockIdentity(moved.identity, observed.identity) ||
    moved.owner.token !== observed.owner.token
  ) {
    await restoreUnexpectedQuarantine(quarantinePath, lockPath);
    throw new Error(
      `Workspace restore lock identity changed during stale reclaim; preserved at ${quarantinePath}`,
    );
  }
  await fs.unlink(quarantinePath);
  return true;
}

function buildDirectoryMergeLockRelease(input: {
  lockPath: string;
  identity: LockFileIdentity;
  owner: DirectoryMergeLockOwner;
}): () => Promise<void> {
  let state:
    | { status: "active" }
    | { status: "moved"; quarantinePath: string }
    | { status: "removed" } = { status: "active" };
  return async () => {
    if (state.status === "removed") return;
    if (state.status === "active") {
      const current = await inspectDirectoryMergeLock(input.lockPath);
      if (
        current.state !== "valid" ||
        !sameLockIdentity(current.identity, input.identity) ||
        current.owner.token !== input.owner.token
      ) {
        throw new Error(
          "Workspace restore lock identity changed before release; refusing to delete a replacement claim.",
        );
      }
      const quarantinePath = `${input.lockPath}.release-${input.owner.token}-${randomUUID()}`;
      await fs.rename(input.lockPath, quarantinePath);
      state = { status: "moved", quarantinePath };
    }

    const { quarantinePath } = state;
    const moved = await inspectDirectoryMergeLock(quarantinePath);
    if (moved.state === "missing") {
      state = { status: "removed" };
      return;
    }
    if (
      moved.state !== "valid" ||
      !sameLockIdentity(moved.identity, input.identity) ||
      moved.owner.token !== input.owner.token
    ) {
      throw new Error(
        "Workspace restore lock identity changed after release rename; refusing deletion.",
      );
    }
    await fs.unlink(quarantinePath);
    state = { status: "removed" };
  };
}

async function acquireDirectoryMergeLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const owner: DirectoryMergeLockOwner = {
      version: 1,
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw error;
      const observed = await inspectDirectoryMergeLock(lockPath);
      if (
        observed.state === "valid" &&
        holderIsDefinitelyDead(observed.owner.pid) &&
        await reclaimDeadDirectoryMergeLock(lockPath, observed)
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        const reason = observed.state === "unproven" ? ` (${observed.reason})` : "";
        throw new Error(`Timed out waiting for workspace restore lock at ${lockPath}${reason}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }

    const stat = await handle.stat({ bigint: true });
    const identity = { dev: stat.dev, ino: stat.ino };
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      const observed = await inspectDirectoryMergeLock(lockPath);
      if (observed.state === "valid" && sameLockIdentity(observed.identity, identity)) {
        await reclaimDeadDirectoryMergeLock(lockPath, observed).catch(() => undefined);
      }
      throw error;
    }
    await handle.close();
    return buildDirectoryMergeLockRelease({ lockPath, identity, owner });
  }
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireDirectoryMergeLock(`${targetDir}.paperclip-restore.lock`);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

type TargetRootIdentity = {
  dev: bigint;
  ino: bigint;
  realpath: string;
};

async function captureSafeTargetRootIdentity(targetDir: string): Promise<TargetRootIdentity> {
  const root = await fs.lstat(targetDir, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Workspace restore target root must remain a real directory.");
  }
  return {
    dev: root.dev,
    ino: root.ino,
    realpath: await fs.realpath(targetDir),
  };
}

async function assertSafeTargetRootIdentity(
  targetDir: string,
  expected: TargetRootIdentity,
): Promise<void> {
  const observed = await captureSafeTargetRootIdentity(targetDir);
  if (
    observed.dev !== expected.dev
    || observed.ino !== expected.ino
    || observed.realpath !== expected.realpath
  ) {
    throw new Error("Workspace restore target root identity changed during merge.");
  }
}

async function ensureSafeTargetParentDirectories(
  targetDir: string,
  relative: string,
): Promise<void> {
  const root = await fs.lstat(targetDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Workspace restore target root must remain a real directory.");
  }
  const segments = relative.split("/").filter(Boolean).slice(0, -1);
  let current = targetDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    let entry = await fs.lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entry) {
      await fs.mkdir(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      entry = await fs.lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Workspace restore refuses nested mutation through non-directory or symlink ancestor: ${current}`,
      );
    }
  }
}

async function assertSafeExistingTargetAncestors(
  targetDir: string,
  relative: string,
): Promise<boolean> {
  const root = await fs.lstat(targetDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Workspace restore target root must remain a real directory.");
  }
  const segments = relative.split("/").filter(Boolean).slice(0, -1);
  let current = targetDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await fs.lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entry) return false;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Workspace restore refuses nested deletion through non-directory or symlink ancestor: ${current}`,
      );
    }
  }
  return true;
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const targetPath = path.join(targetDir, relative);
  await ensureSafeTargetParentDirectories(targetDir, relative);

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (entry.kind === "symlink") {
    await fs.symlink(entry.target, targetPath);
    return;
  }

  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, entry.mode);
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[] } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  return {
    exclude,
    entries: await walkDirectory(rootDir, exclude),
  };
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}): Promise<void> {
  const source = await captureDirectorySnapshot(input.sourceDir, { exclude: input.baseline.exclude });
  await withDirectoryMergeLock(input.targetDir, async () => {
    const targetRootIdentity = await captureSafeTargetRootIdentity(input.targetDir);
    await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
    await input.beforeApply?.();
    await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
    const current = await captureDirectorySnapshot(input.targetDir, { exclude: input.baseline.exclude });
    const deletedLeafEntries = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind !== "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedLeafEntries) {
      await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      if (!(await assertSafeExistingTargetAncestors(input.targetDir, relative))) continue;
      await fs.rm(path.join(input.targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }

    const deletedDirs = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind === "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedDirs) {
      await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      if (!(await assertSafeExistingTargetAncestors(input.targetDir, relative))) continue;
      await fs.rmdir(path.join(input.targetDir, relative)).catch(() => undefined);
    }

    const changedSourceEntries = [...source.entries.entries()]
      .filter(([relative, entry]) => !entriesMatch(input.baseline.entries.get(relative), entry))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [relative, entry] of changedSourceEntries) {
      await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
      await copySnapshotEntry(input.sourceDir, input.targetDir, relative, entry);
    }

    await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
    await input.afterApply?.();
    await assertSafeTargetRootIdentity(input.targetDir, targetRootIdentity);
  });
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
