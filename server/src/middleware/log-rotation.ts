import fs from "node:fs";
import path from "node:path";

/**
 * Size-capped rotation for the server log file.
 *
 * The pino-pretty file target keeps `server.log` open in append mode for the whole process
 * lifetime, so the live file cannot simply be renamed while the server runs. At runtime we copy
 * the file to `server.log.1` and truncate it in place (the writer appends, so it carries on at the
 * start of the emptied file). Lines written between the copy and the truncate are lost; that is
 * accepted so a log flood cannot fill the disk. Nothing is open yet at startup, so an oversized
 * file from an earlier run is renamed instead, which keeps its content and ages it out normally.
 */

export const DEFAULT_LOG_MAX_SIZE_MB = 50;
export const DEFAULT_LOG_MAX_FILES = 5;
export const LOG_ROTATION_CHECK_INTERVAL_MS = 30_000;

export interface LogRotationOptions {
  /** Rotate once the live file reaches this many bytes. 0 disables rotation. */
  maxBytes: number;
  /** Total files kept, the live file included (so `maxFiles - 1` archives). Minimum 1. */
  maxFiles: number;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Reads PAPERCLIP_LOG_MAX_SIZE_MB (default 50, 0 disables) and PAPERCLIP_LOG_MAX_FILES (default 5).
 * Invalid values fall back to the defaults.
 */
export function resolveLogRotationOptions(env: NodeJS.ProcessEnv = process.env): LogRotationOptions {
  const sizeMb = parsePositiveNumber(env.PAPERCLIP_LOG_MAX_SIZE_MB) ?? DEFAULT_LOG_MAX_SIZE_MB;
  const files = parsePositiveNumber(env.PAPERCLIP_LOG_MAX_FILES);
  const maxFiles = files !== undefined && Number.isInteger(files) && files >= 1 ? files : DEFAULT_LOG_MAX_FILES;
  return { maxBytes: Math.floor(sizeMb * 1024 * 1024), maxFiles };
}

function archivePath(logFile: string, index: number): string {
  return `${logFile}.${index}`;
}

/** Only `<logFile>.<number>` siblings inside the log file's own directory are ever touched. */
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

/** Drops archives beyond the keep count and shifts the rest up by one, freeing `.1`. */
function shiftArchives(logFile: string, maxFiles: number): void {
  const archivesToKeep = maxFiles - 1;
  for (const index of listArchiveIndexes(logFile).reverse()) {
    if (index >= archivesToKeep) {
      removeIfPresent(archivePath(logFile, index));
    } else {
      fs.renameSync(archivePath(logFile, index), archivePath(logFile, index + 1));
    }
  }
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
 * Startup rotation: nothing holds the file open yet, so a plain rename is safe. Returns true when
 * the file was rotated.
 */
export function rotateLogFileOnStartup(logFile: string, options: LogRotationOptions): boolean {
  if (options.maxBytes <= 0) return false;
  pruneLogArchives(logFile, options.maxFiles);
  if (statSize(logFile) < options.maxBytes) return false;
  if (options.maxFiles <= 1) {
    fs.truncateSync(logFile, 0);
    return true;
  }
  shiftArchives(logFile, options.maxFiles);
  fs.renameSync(logFile, archivePath(logFile, 1));
  return true;
}

/**
 * Runtime rotation for a file another handle holds open in append mode (copy, then truncate).
 * Returns true when the file was rotated.
 */
export async function rotateOpenLogFile(logFile: string, options: LogRotationOptions): Promise<boolean> {
  if (options.maxBytes <= 0) return false;
  if (statSize(logFile) < options.maxBytes) return false;
  if (options.maxFiles > 1) {
    shiftArchives(logFile, options.maxFiles);
    await fs.promises.copyFile(logFile, archivePath(logFile, 1));
  }
  await fs.promises.truncate(logFile, 0);
  return true;
}

export interface LogRotationHandle {
  stop(): void;
}

/** Rotates oversized logs at startup, then re-checks on an interval that never keeps the process alive. */
export function startLogRotation(
  logFile: string,
  options: LogRotationOptions = resolveLogRotationOptions(),
  intervalMs: number = LOG_ROTATION_CHECK_INTERVAL_MS,
): LogRotationHandle {
  try {
    rotateLogFileOnStartup(logFile, options);
  } catch {
    // Rotation must never stop the server from starting; the interval below retries.
  }
  if (options.maxBytes <= 0) return { stop() {} };

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    rotateOpenLogFile(logFile, options)
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
