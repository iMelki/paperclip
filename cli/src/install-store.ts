import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./config/home.js";

export const INSTALL_MANIFEST_VERSION = 1;
export const MANAGED_SHIM_MARKER = "paperclipai managed install shim v1";
export const MANAGED_STORE_MARKER = "paperclipai managed install store v1\n";
export const PATH_BLOCK_START = "# >>> paperclipai managed PATH >>>";
export const PATH_BLOCK_END = "# <<< paperclipai managed PATH <<<";

export type InstallSource = "npm" | "git";
export type InstallChannel = "latest" | "canary" | "pinned";

export type InstallRecord = {
  source: InstallSource;
  version: string;
  channel: InstallChannel;
  payloadPath: string;
  repo?: string;
  ref?: string;
  sha?: string;
  installedAt: string;
};

export type InstallManifest = InstallRecord & {
  schemaVersion: typeof INSTALL_MANIFEST_VERSION;
  previous: InstallRecord[];
};

export type InstallStorePaths = {
  paperclipHome: string;
  cliRoot: string;
  installsRoot: string;
  manifestPath: string;
  markerPath: string;
  lockPath: string;
  currentPath: string;
  shimPath: string;
};

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory install-store path ${directoryPath}.`);
  }
  fs.chmodSync(directoryPath, 0o700);
}

function assertOwnedByCurrentUser(stat: fs.Stats, targetPath: string): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw new Error(`Refusing to modify path not owned by the current user: ${targetPath}.`);
  }
}

function writeFileAtomic(filePath: string, contents: string, mode: number): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { mode, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

export function resolveInstallStorePaths(options: {
  paperclipHome?: string;
  homeDir?: string;
} = {}): InstallStorePaths {
  const paperclipHome = path.resolve(options.paperclipHome ?? resolvePaperclipHomeDir());
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? path.dirname(paperclipHome));
  const cliRoot = path.join(paperclipHome, "cli");
  return {
    paperclipHome,
    cliRoot,
    installsRoot: path.join(cliRoot, "installs"),
    manifestPath: path.join(cliRoot, "install.json"),
    markerPath: path.join(cliRoot, ".managed-install"),
    lockPath: path.join(cliRoot, ".install.lock"),
    currentPath: path.join(cliRoot, "current"),
    shimPath: path.join(homeDir, ".local", "bin", "paperclipai"),
  };
}

export function initializeInstallStore(paths = resolveInstallStorePaths()): void {
  ensurePrivateDirectory(paths.cliRoot);
  ensurePrivateDirectory(paths.installsRoot);
  try {
    const markerStat = fs.lstatSync(paths.markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > 1) {
      throw new Error(`Refusing to use unsafe install-store marker ${paths.markerPath}.`);
    }
    assertOwnedByCurrentUser(markerStat, paths.markerPath);
    if (fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER) {
      throw new Error(`Refusing to use unrecognized install store ${paths.cliRoot}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if (
        (writeError as NodeJS.ErrnoException).code !== "EEXIST" ||
        fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER
      ) {
        throw writeError;
      }
    }
  }
}

export function assertManagedInstallStore(paths = resolveInstallStorePaths()): InstallManifest {
  const cliStat = fs.lstatSync(paths.cliRoot);
  if (!cliStat.isDirectory() || cliStat.isSymbolicLink()) {
    throw new Error(`Refusing to remove unsafe install-store path ${paths.cliRoot}.`);
  }
  assertOwnedByCurrentUser(cliStat, paths.cliRoot);
  let markerStat: fs.Stats;
  try {
    markerStat = fs.lstatSync(paths.markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
    }
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink > 1) {
    throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
  }
  assertOwnedByCurrentUser(markerStat, paths.markerPath);
  if (fs.readFileSync(paths.markerPath, "utf8") !== MANAGED_STORE_MARKER) {
    throw new Error(`Refusing to remove unverified install store ${paths.cliRoot}.`);
  }
  const manifest = readInstallManifest(paths);
  if (!manifest) throw new Error(`Refusing to remove install store without a manifest at ${paths.cliRoot}.`);
  const relativePayload = path.relative(paths.installsRoot, path.resolve(manifest.payloadPath));
  if (!relativePayload || relativePayload.startsWith("..") || path.isAbsolute(relativePayload)) {
    throw new Error(`Refusing to remove install store with an invalid manifest at ${paths.cliRoot}.`);
  }
  return manifest;
}

export async function withInstallStoreLock<T>(
  callback: () => Promise<T>,
  paths = resolveInstallStorePaths(),
  options: { initialize?: boolean } = {},
): Promise<T> {
  if (options.initialize !== false) initializeInstallStore(paths);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const processIsAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const acquire = (): void => {
    // The token stays colon-delimited: the stale-owner check below parses its
    // pid out of the lock file's contents. A colon is illegal in a Windows
    // filename (NTFS reads it as an alternate data stream), so the temp path
    // gets a path-safe rendering of the same token. See #136.
    const temporaryPath = `${paths.lockPath}.${token.replaceAll(":", "-")}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${token}\n`, { mode: 0o600, flag: "wx" });
      try {
        fs.linkSync(temporaryPath, paths.lockPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = fs.readFileSync(paths.lockPath, "utf8").trim();
      const ownerPid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && !processIsAlive(ownerPid)) {
        fs.rmSync(paths.lockPath);
        fs.rmSync(temporaryPath, { force: true });
        acquire();
        return;
      }
      const ownerLabel = Number.isInteger(ownerPid) && ownerPid > 0 ? ` (pid ${ownerPid})` : "";
      throw new Error(
        `Another managed install is already running${ownerLabel}. ` +
        `If no install process is active, remove the stale lock at ${paths.lockPath} and retry.`,
      );
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  };

  acquire();
  try {
    return await callback();
  } finally {
    try {
      if (fs.readFileSync(paths.lockPath, "utf8").trim() === token) {
        fs.rmSync(paths.lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function payloadPathFor(
  paths: InstallStorePaths,
  source: InstallSource,
  identifier: string,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) {
    throw new Error(`Invalid install payload identifier '${identifier}'.`);
  }
  return path.join(paths.installsRoot, source, identifier);
}

export function readInstallManifest(paths = resolveInstallStorePaths()): InstallManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")) as InstallManifest;
    if (
      value.schemaVersion !== INSTALL_MANIFEST_VERSION ||
      (value.source !== "npm" && value.source !== "git") ||
      !Array.isArray(value.previous) ||
      typeof value.payloadPath !== "string"
    ) {
      throw new Error("unsupported manifest shape");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read managed install manifest at ${paths.manifestPath}: ${String(error)}`);
  }
}

export function writeInstallManifestAtomic(
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): void {
  ensurePrivateDirectory(paths.cliRoot);
  const temporaryPath = `${paths.manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, paths.manifestPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function assertPayloadPath(payloadPath: string, paths: InstallStorePaths): void {
  const relative = path.relative(paths.installsRoot, path.resolve(payloadPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to activate payload outside ${paths.installsRoot}.`);
  }
  const stat = fs.lstatSync(payloadPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to activate non-directory payload ${payloadPath}.`);
  }
  const installsRealPath = fs.realpathSync(paths.installsRoot);
  const payloadRealPath = fs.realpathSync(payloadPath);
  if (!payloadRealPath.startsWith(`${installsRealPath}${path.sep}`)) {
    throw new Error(`Refusing to activate payload that resolves outside ${paths.installsRoot}.`);
  }
}

export type FlipCurrentErrorCode =
  | "current-flip-concurrent"
  | "current-flip-step-failed"
  | "current-flip-double-fault"
  | "current-flip-unsafe-prev"
  | "current-flip-ambiguous-recovery";

export type FlipCurrentStep = "recover-prev" | "move-aside" | "rename-in" | "rollback" | "remove-prev";

export class FlipCurrentError extends Error {
  constructor(
    readonly code: FlipCurrentErrorCode,
    message: string,
    readonly step: FlipCurrentStep | null = null,
    options?: { cause?: unknown },
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "FlipCurrentError";
  }
}

export type FlipCurrentHooks = {
  /** win32 only: runs before each attempt to move the old link aside. */
  beforeMoveAside?: () => void;
  /** Runs before each attempt to rename the new link onto `current`. */
  beforeRename?: () => void;
  /** Runs before each attempt to rename the previous link back (rollback). */
  beforeRollback?: () => void;
  /** Runs once, just before the previous link is checked and removed. */
  beforeRemovePrev?: (prevPath: string) => void;
  /** Test seam only: exercise the win32 strategy on another platform. */
  platform?: NodeJS.Platform;
};

export type FlipCurrentResult = {
  strategy: "atomic-rename" | "rename-aside";
  /** A previous link that could not be removed after a successful flip. */
  leftoverPrevPath: string | null;
};

const PREV_LINK_PREFIX = "current.prev-";
const RETRYABLE_FLIP_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
// About one second in total: Windows reports EPERM/EBUSY/EACCES transiently
// while another process (commonly an antivirus scanner) holds a handle.
const FLIP_RETRY_DELAYS_MS = [50, 100, 200, 300, 350];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Runs one flip step, retrying only transient Windows sharing errors. */
function runFlipStep(step: FlipCurrentStep, action: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      action();
      return;
    } catch (error) {
      const delay = FLIP_RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_FLIP_CODES.has(errorCode(error) ?? "") || delay === undefined) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          flipStep: step,
        });
      }
      sleepSync(delay);
    }
  }
}

function listPrevLinks(paths: InstallStorePaths): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.cliRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.startsWith(PREV_LINK_PREFIX))
    .map((entry) => path.join(paths.cliRoot, entry))
    .filter((entryPath) => {
      try {
        return fs.lstatSync(entryPath).isSymbolicLink();
      } catch {
        return false;
      }
    });
}

/** Exported so doctor reports exactly what the flip would recover. */
export function findStrandedPrevLinks(paths = resolveInstallStorePaths()): string[] {
  return listPrevLinks(paths);
}

export function manualCurrentRecoveryCommand(prevPath: string, paths: InstallStorePaths): string {
  return process.platform === "win32"
    ? `Rename-Item -LiteralPath '${prevPath}' -NewName 'current'`
    : `mv ${shellQuote(prevPath)} ${shellQuote(paths.currentPath)}`;
}

function currentExists(paths: InstallStorePaths): boolean {
  try {
    const stat = fs.lstatSync(paths.currentPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink ${paths.currentPath}.`);
    }
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * A crash between moving `current` aside and renaming the new link in leaves
 * no `current` at all, which also breaks the shim (it hard-codes
 * <cliRoot>/current/...). If exactly one previous link survives, it is the
 * last good `current`: restore it before doing anything else. More than one is
 * ambiguous, so refuse rather than guess.
 */
function recoverStrandedCurrent(paths: InstallStorePaths): void {
  if (currentExists(paths)) return;
  const prevLinks = listPrevLinks(paths);
  if (prevLinks.length === 0) return;
  if (prevLinks.length > 1) {
    throw new FlipCurrentError(
      "current-flip-ambiguous-recovery",
      `${paths.currentPath} is missing and ${prevLinks.length} previous links exist `
        + `(${prevLinks.join(", ")}); refusing to guess which to restore. Restore the right one `
        + `manually, e.g. ${manualCurrentRecoveryCommand(prevLinks[0]!, paths)}`,
    );
  }
  try {
    runFlipStep("recover-prev", () => fs.renameSync(prevLinks[0]!, paths.currentPath));
  } catch (error) {
    throw new FlipCurrentError(
      "current-flip-step-failed",
      `step recover-prev failed restoring ${prevLinks[0]} to ${paths.currentPath}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      "recover-prev",
      { cause: error },
    );
  }
}

/**
 * Point `current` at `payloadPath`.
 *
 * POSIX: atomic. A new symlink is renamed over `current` in one rename(2), so
 * `current` always exists and always names a complete payload.
 *
 * win32: rename-aside, with a brief gap. MoveFileEx cannot replace an existing
 * directory reparse point (the rename fails with EPERM), so the old link is
 * renamed aside to `current.prev-<nonce>`, the new link is renamed in, and the
 * old link is removed. Between the two renames `current` does not exist. The
 * on-disk contract is unchanged: `current` is still a directory symlink.
 *
 * The removal never traverses: the previous entry must still be a symlink
 * (lstat), and it is removed with unlink, never recursively. A failed
 * rename-in is rolled back; if the rollback also fails, the error names both
 * paths and the manual recovery. Transient EPERM/EBUSY/EACCES are retried for
 * about one second, and every failure names the step that failed.
 */
export function flipCurrent(
  payloadPath: string,
  paths = resolveInstallStorePaths(),
  hooks: FlipCurrentHooks = {},
): FlipCurrentResult {
  assertPayloadPath(payloadPath, paths);
  ensurePrivateDirectory(paths.cliRoot);
  const platform = hooks.platform ?? process.platform;
  if (platform === "win32") recoverStrandedCurrent(paths);
  const hadCurrent = currentExists(paths);

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryLink = path.join(paths.cliRoot, `.current-${nonce}`);
  const relativeTarget = path.relative(paths.cliRoot, payloadPath);
  try {
    fs.symlinkSync(relativeTarget, temporaryLink, "dir");
    if (platform !== "win32") {
      hooks.beforeRename?.();
      fs.renameSync(temporaryLink, paths.currentPath);
      return { strategy: "atomic-rename", leftoverPrevPath: null };
    }
    return renameAside(paths, temporaryLink, `${PREV_LINK_PREFIX}${nonce}`, hadCurrent, hooks);
  } finally {
    fs.rmSync(temporaryLink, { force: true });
  }
}

function renameAside(
  paths: InstallStorePaths,
  temporaryLink: string,
  prevName: string,
  hadCurrent: boolean,
  hooks: FlipCurrentHooks,
): FlipCurrentResult {
  const prevPath = hadCurrent ? path.join(paths.cliRoot, prevName) : null;

  // Step 2: move the old link aside. ENOENT means another process moved it
  // first: stop, never roll back, and never touch its previous link.
  if (prevPath) {
    try {
      runFlipStep("move-aside", () => {
        hooks.beforeMoveAside?.();
        fs.renameSync(paths.currentPath, prevPath);
      });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new FlipCurrentError(
          "current-flip-concurrent",
          `${paths.currentPath} disappeared before it could be moved aside; another flip is in `
            + "progress. Nothing was rolled back.",
          "move-aside",
          { cause: error },
        );
      }
      throw stepFailed("move-aside", error, `moving ${paths.currentPath} aside to ${prevPath}`);
    }
  }

  // Step 3: rename the new link in. On failure, step 5: roll back.
  try {
    runFlipStep("rename-in", () => {
      hooks.beforeRename?.();
      fs.renameSync(temporaryLink, paths.currentPath);
    });
  } catch (renameError) {
    if (!prevPath) throw stepFailed("rename-in", renameError, `renaming the new link to ${paths.currentPath}`);
    try {
      runFlipStep("rollback", () => {
        hooks.beforeRollback?.();
        fs.renameSync(prevPath, paths.currentPath);
      });
    } catch (rollbackError) {
      throw new FlipCurrentError(
        "current-flip-double-fault",
        `renaming the new link to ${paths.currentPath} failed (${describe(renameError)}) AND the `
          + `rollback from ${prevPath} failed (${describe(rollbackError)}). ${paths.currentPath} is `
          + `missing and the last good link is ${prevPath}. Recover manually: `
          + manualCurrentRecoveryCommand(prevPath, paths),
        "rollback",
        { cause: rollbackError },
      );
    }
    throw stepFailed("rename-in", renameError, `renaming the new link to ${paths.currentPath}; rolled back`);
  }

  if (!prevPath) return { strategy: "rename-aside", leftoverPrevPath: null };

  // Step 4: remove the previous link. NEVER traverse: it must still be a
  // symlink, and it is unlinked, never removed recursively.
  hooks.beforeRemovePrev?.(prevPath);
  let prevStat: fs.Stats;
  try {
    prevStat = fs.lstatSync(prevPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { strategy: "rename-aside", leftoverPrevPath: null };
    throw error;
  }
  if (!prevStat.isSymbolicLink()) {
    throw new FlipCurrentError(
      "current-flip-unsafe-prev",
      `Refusing to remove non-symlink ${prevPath}; it was not created by this flip. `
        + `${paths.currentPath} already points to the new payload.`,
      "remove-prev",
    );
  }
  try {
    runFlipStep("remove-prev", () => fs.unlinkSync(prevPath));
  } catch {
    // The flip itself succeeded; a leftover link is harmless and doctor reports it.
    return { strategy: "rename-aside", leftoverPrevPath: prevPath };
  }
  return { strategy: "rename-aside", leftoverPrevPath: null };
}

function describe(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

function stepFailed(step: FlipCurrentStep, error: unknown, doing: string): FlipCurrentError {
  return new FlipCurrentError(
    "current-flip-step-failed",
    `step ${step} failed while ${doing}: ${describe(error)}`,
    step,
    { cause: error },
  );
}

export function buildNextManifest(
  record: InstallRecord,
  current: InstallManifest | null,
): InstallManifest {
  const candidates: InstallRecord[] = current
    ? [
        {
          source: current.source,
          version: current.version,
          channel: current.channel,
          payloadPath: current.payloadPath,
          repo: current.repo,
          ref: current.ref,
          sha: current.sha,
          installedAt: current.installedAt,
        },
        ...current.previous,
      ]
    : [];
  const previous = candidates
    .filter((candidate) => path.resolve(candidate.payloadPath) !== path.resolve(record.payloadPath))
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => path.resolve(other.payloadPath) === path.resolve(candidate.payloadPath)) ===
        index,
    )
    .slice(0, 2);

  return { schemaVersion: INSTALL_MANIFEST_VERSION, ...record, previous };
}

export function pruneInstallPayloads(
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): string[] {
  const retained = new Set(
    [manifest, ...manifest.previous].map((record) => path.resolve(record.payloadPath)),
  );
  const removed: string[] = [];
  for (const source of ["npm", "git"] as const) {
    const sourceRoot = path.join(paths.installsRoot, source);
    if (!fs.existsSync(sourceRoot)) continue;
    const sourceStat = fs.lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing to prune unsafe install-store path ${sourceRoot}.`);
    }
    for (const entry of fs.readdirSync(sourceRoot)) {
      if (entry.startsWith(".")) continue;
      const candidate = path.join(sourceRoot, entry);
      if (!retained.has(path.resolve(candidate))) {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed.push(candidate);
      }
    }
  }
  return removed;
}

export function assertManagedShimWritable(paths = resolveInstallStorePaths()): void {
  const homeDir = path.dirname(path.dirname(path.dirname(paths.shimPath)));
  for (const directoryPath of [homeDir, path.join(homeDir, ".local"), path.dirname(paths.shimPath)]) {
    if (!fs.existsSync(directoryPath)) continue;
    const directoryStat = fs.lstatSync(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Refusing to use unsafe shim directory ${directoryPath}.`);
    }
    assertOwnedByCurrentUser(directoryStat, directoryPath);
  }
  try {
    const stat = fs.lstatSync(paths.shimPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular shim ${paths.shimPath}.`);
    }
    assertOwnedByCurrentUser(stat, paths.shimPath);
    if (stat.nlink > 1) throw new Error(`Refusing to replace multiply linked shim ${paths.shimPath}.`);
    const existing = fs.readFileSync(paths.shimPath, "utf8");
    if (!isManagedShimContents(existing)) {
      throw new Error(`Refusing to replace existing non-managed command ${paths.shimPath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isManagedShimContents(contents: string): boolean {
  const lines = contents.split("\n");
  return (
    lines.length === 5 &&
    lines[0] === "#!/bin/sh" &&
    lines[1] === `# ${MANAGED_SHIM_MARKER}` &&
    lines[2] === "set -eu" &&
    /^exec '(?:[^']|'"'"')+' '(?:[^']|'"'"')+' "\$@"$/.test(lines[3]) &&
    lines[4] === ""
  );
}

export function writeManagedShim(paths = resolveInstallStorePaths()): void {
  assertManagedShimWritable(paths);
  const homeDir = path.dirname(path.dirname(path.dirname(paths.shimPath)));
  const localDir = path.dirname(path.dirname(paths.shimPath));
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(localDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true, mode: 0o755 });
  assertManagedShimWritable(paths);
  const entrypoint = path.join(paths.currentPath, "node_modules", "paperclipai", "dist", "index.js");
  const contents = `#!/bin/sh\n# ${MANAGED_SHIM_MARKER}\nset -eu\nexec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} "\$@"\n`;
  writeFileAtomic(paths.shimPath, contents, 0o755);
}

export function removeManagedShim(paths = resolveInstallStorePaths()): boolean {
  try {
    const contents = fs.readFileSync(paths.shimPath, "utf8");
    if (!isManagedShimContents(contents)) return false;
    fs.rmSync(paths.shimPath, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function managedPathBlock(): string {
  return `${PATH_BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n${PATH_BLOCK_END}`;
}

export function addManagedPathBlock(rcPath: string): boolean {
  let existing = "";
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(rcPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to modify non-regular shell rc file ${rcPath}.`);
    }
    assertOwnedByCurrentUser(stat, rcPath);
    mode = stat.mode & 0o777;
    existing = fs.readFileSync(rcPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.includes(PATH_BLOCK_START)) return false;
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileAtomic(rcPath, `${existing}${prefix}${managedPathBlock()}\n`, mode);
  return true;
}

export function removeManagedPathBlock(rcPath: string): boolean {
  let existing: string;
  let mode: number;
  try {
    const stat = fs.lstatSync(rcPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to modify non-regular shell rc file ${rcPath}.`);
    }
    assertOwnedByCurrentUser(stat, rcPath);
    mode = stat.mode & 0o777;
    existing = fs.readFileSync(rcPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const escapedStart = PATH_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = PATH_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = existing.replace(new RegExp(`(?:^|\\n)${escapedStart}\\n[\\s\\S]*?${escapedEnd}\\n?`), "\n");
  if (next === existing) return false;
  writeFileAtomic(rcPath, next.replace(/^\n/, ""), mode);
  return true;
}

export function isManagedExecutable(
  executablePath: string | undefined,
  manifest: InstallManifest,
  paths = resolveInstallStorePaths(),
): boolean {
  if (!executablePath) return false;
  try {
    const executableRealPath = fs.realpathSync(executablePath);
    const payloadRealPath = fs.realpathSync(manifest.payloadPath);
    const currentRealPath = fs.realpathSync(paths.currentPath);
    return (
      currentRealPath === payloadRealPath &&
      executableRealPath.startsWith(`${payloadRealPath}${path.sep}`)
    );
  } catch {
    return false;
  }
}
