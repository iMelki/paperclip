import fs from "node:fs";
import path from "node:path";

/**
 * Size-capped rotation for the server log file.
 *
 * The pino-pretty file target keeps `server.log` open in append mode for the whole process
 * lifetime, and other processes may hold it open too, so the live file is never renamed or
 * deleted. Rotation copies it to a temporary file, shifts the numbered archives, moves the copy to
 * `server.log.1`, and truncates the live file in place (the writer appends, so it carries on at
 * the start of the emptied file). Lines written between the end of the copy and the truncate are
 * lost; that is accepted so a log flood cannot fill the disk.
 *
 * Size bound: a file can exceed the cap by up to one check interval of writes, so disk use is
 * about `maxFiles x (cap + one interval of writes)`.
 *
 * Rotation is started explicitly by the server entry point (`startLogRotation`), never as a side
 * effect of importing the logger, so test forks and other importers never touch the live directory.
 */

export const DEFAULT_LOG_MAX_SIZE_MB = 50;
export const DEFAULT_LOG_MAX_FILES = 5;
export const MAX_LOG_MAX_SIZE_MB = 10_240;
export const MAX_LOG_MAX_FILES = 100;
export const LOG_ROTATION_CHECK_INTERVAL_MS = 30_000;
export const LOG_ROTATION_WARN_INTERVAL_MS = 60 * 60 * 1000;

export interface LogRotationOptions {
  /** Rotate once the live file reaches this many bytes. 0 disables rotation. */
  maxBytes: number;
  /** Total files kept, the live file included (so `maxFiles - 1` archives). Minimum 1. */
  maxFiles: number;
}

function parseNonNegativeNumber(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Reads PAPERCLIP_LOG_MAX_SIZE_MB (default 50, 0 disables, clamped to 10240) and
 * PAPERCLIP_LOG_MAX_FILES (default 5, clamped to 100). Invalid values, including a non-zero size
 * too small to be one byte, fall back to the defaults.
 */
export function resolveLogRotationOptions(env: NodeJS.ProcessEnv = process.env): LogRotationOptions {
  const requestedMb = parseNonNegativeNumber(env.PAPERCLIP_LOG_MAX_SIZE_MB);
  let sizeMb = requestedMb ?? DEFAULT_LOG_MAX_SIZE_MB;
  if (requestedMb !== undefined && requestedMb > 0 && Math.floor(requestedMb * 1024 * 1024) < 1) {
    sizeMb = DEFAULT_LOG_MAX_SIZE_MB;
  }
  sizeMb = Math.min(sizeMb, MAX_LOG_MAX_SIZE_MB);

  const files = parseNonNegativeNumber(env.PAPERCLIP_LOG_MAX_FILES);
  const maxFiles =
    files !== undefined && Number.isInteger(files) && files >= 1
      ? Math.min(files, MAX_LOG_MAX_FILES)
      : DEFAULT_LOG_MAX_FILES;
  return { maxBytes: Math.floor(sizeMb * 1024 * 1024), maxFiles };
}

// ---- Failure reporting (one stderr line per distinct error code per hour) ----

const lastWarnAt = new Map<string, number>();

export function reportLogRotationError(
  error: unknown,
  write: (line: string) => void = (line) => process.stderr.write(line),
  now: number = Date.now(),
): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
  const last = lastWarnAt.get(code);
  if (last !== undefined && now - last < LOG_ROTATION_WARN_INTERVAL_MS) return false;
  lastWarnAt.set(code, now);
  const message = error instanceof Error ? error.message : String(error);
  write(`[paperclip] server log rotation failed (${code}): ${message}. Further ${code} failures are hidden for an hour.\n`);
  return true;
}

/** Test hook: forget which error codes were already reported. */
export function resetLogRotationErrorReports(): void {
  lastWarnAt.clear();
}

// ---- Archive handling (only `<logFile>.<number>` regular files in the log directory) ----

function archivePath(logFile: string, index: number): string {
  return `${logFile}.${index}`;
}

function rotatingTempPath(logFile: string): string {
  return `${logFile}.rotating`;
}

function listArchiveIndexes(logFile: string): number[] {
  const dir = path.dirname(logFile);
  const prefix = `${path.basename(logFile)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const indexes: number[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(suffix)) continue;
    try {
      if (!fs.lstatSync(path.join(dir, name)).isFile()) continue;
    } catch {
      continue;
    }
    indexes.push(Number(suffix));
  }
  return indexes.sort((a, b) => a - b);
}

function removeIfPresent(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Drops archives beyond the keep count and shifts the rest up by one, freeing `.1`. A rename that
 * fails (for example the target is locked) falls back to deleting the source so rotation never
 * gets stuck; the first error is returned for reporting.
 */
function shiftArchives(logFile: string, maxFiles: number): unknown {
  const archivesToKeep = maxFiles - 1;
  let firstError: unknown;
  for (const index of listArchiveIndexes(logFile).reverse()) {
    try {
      if (index >= archivesToKeep) {
        removeIfPresent(archivePath(logFile, index));
      } else {
        try {
          fs.renameSync(archivePath(logFile, index), archivePath(logFile, index + 1));
        } catch (error) {
          firstError ??= error;
          removeIfPresent(archivePath(logFile, index));
        }
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

/** Removes archives numbered above the keep count, e.g. after lowering the keep setting. */
export function pruneLogArchives(logFile: string, maxFiles: number): void {
  const archivesToKeep = Math.max(0, maxFiles - 1);
  for (const index of listArchiveIndexes(logFile)) {
    if (index > archivesToKeep) removeIfPresent(archivePath(logFile, index));
  }
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Rotates the log when it has reached the cap. Safe whether or not other handles hold the file
 * open. Archive failures are reported but never prevent the truncate, because capping disk use is
 * the priority. Returns true when the live file was truncated.
 */
export async function rotateLogFile(
  logFile: string,
  options: LogRotationOptions,
  report: (error: unknown) => void = reportLogRotationError,
): Promise<boolean> {
  if (options.maxBytes <= 0) return false;
  if (statSize(logFile) < options.maxBytes) return false;

  if (options.maxFiles <= 1) {
    // Keep nothing but the live file: older archives must not linger until the next startup.
    try {
      pruneLogArchives(logFile, options.maxFiles);
    } catch (error) {
      report(error);
    }
  } else {
    const temp = rotatingTempPath(logFile);
    try {
      // Copy first: nothing is shifted or deleted unless the copy succeeded (so a failing copy
      // cannot eat the existing archives one tick at a time).
      await fs.promises.copyFile(logFile, temp);
      const shiftError = shiftArchives(logFile, options.maxFiles);
      if (shiftError) report(shiftError);
      fs.renameSync(temp, archivePath(logFile, 1));
    } catch (error) {
      report(error);
      try {
        removeIfPresent(temp);
      } catch {
        // best effort
      }
    }
  }
  try {
    await fs.promises.truncate(logFile, 0);
  } catch (error) {
    report(error);
    return false;
  }
  return true;
}

export interface LogRotationHandle {
  stop(): void;
}

const activeRotations = new Map<string, LogRotationHandle>();

/**
 * Rotates an oversized log now, then re-checks on an interval that never keeps the process alive.
 * Call once from the server entry point. Starting the same file twice returns the first handle.
 */
export function startLogRotation(
  logFile: string,
  options: LogRotationOptions = resolveLogRotationOptions(),
  intervalMs: number = LOG_ROTATION_CHECK_INTERVAL_MS,
): LogRotationHandle {
  const existing = activeRotations.get(logFile);
  if (existing) return existing;

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    rotateLogFile(logFile, options)
      .catch((error) => reportLogRotationError(error))
      .finally(() => {
        running = false;
      });
  };

  if (options.maxBytes <= 0) return { stop() {} };

  try {
    pruneLogArchives(logFile, options.maxFiles);
  } catch (error) {
    reportLogRotationError(error);
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const handle: LogRotationHandle = {
    stop() {
      clearInterval(timer);
      activeRotations.delete(logFile);
    },
  };
  activeRotations.set(logFile, handle);
  return handle;
}
