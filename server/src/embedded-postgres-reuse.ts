import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, renameSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { getPostgresDataDirectory } from "@paperclipai/db";
import { logger } from "./middleware/logger.js";

/** Builds the admin connection URL for a port, using the caller's embedded login. */
export type EmbeddedPostgresAdminUrl = (port: number) => string;

async function canonicalDataDirectory(dir: string): Promise<string> {
  const absolute = resolve(dir);
  // Physical canonicalization so symlink/junction aliases compare equal. A path
  // that cannot be resolved (for example, another host's directory) keeps its
  // lexical form and therefore only matches an identical path.
  const physical = await realpath(absolute).catch(() => absolute);
  return process.platform === "win32" ? physical.toLowerCase() : physical;
}

/**
 * Best-effort executable name of a live process, or `null` when it cannot be
 * determined (unsupported platform, missing tool, or the process is gone).
 */
export async function readProcessName(pid: number): Promise<string | null> {
  const run = (file: string, args: string[]) =>
    new Promise<string | null>((done) => {
      execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) =>
        done(error ? null : stdout.trim() || null),
      );
    });
  if (process.platform === "win32") {
    const row = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const match = row?.match(/^"([^"]+)"/);
    return match?.[1] ?? null;
  }
  const name = await run("ps", ["-p", String(pid), "-o", "comm="]);
  return name ? (name.split("/").pop() ?? null) : null;
}

const POSTGRES_PROCESS_NAME_RE = /^(?:postgres|postmaster)(?:\.exe)?$/i;

/**
 * Process exit code for a startup refused because a PostgreSQL that may own the
 * data directory could not be ruled out. Distinct from the generic failure code
 * 1 so service managers and health checks can tell it apart.
 */
export const EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE = 75;

export class EmbeddedPostgresLockRefusal extends Error {
  readonly exitCode = EMBEDDED_POSTGRES_LOCK_REFUSAL_EXIT_CODE;
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedPostgresLockRefusal";
  }
}

/**
 * A destination for a moved-aside lock that does not exist yet. A same-millisecond
 * timestamp (two rapid recoveries, a clock rollback) must not let rename() replace an
 * earlier archive, so a counter is appended until the name is free.
 */
function uniqueAsidePath(pidFile: string): string {
  const base = `${pidFile}.stale-${Date.now()}`;
  let candidate = base;
  for (let n = 1; existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

/**
 * True when `command` names `needle` as a whole path: it must start at a token or
 * option-value boundary and end at the end, whitespace, a quote or a separator, so
 * `/srv/db-backup` and `/mnt/srv/db` never count as `/srv/db`.
 */
export function commandReferencesPath(command: string, needle: string): boolean {
  for (let from = command.indexOf(needle); from !== -1; from = command.indexOf(needle, from + 1)) {
    const before = from === 0 ? "" : command[from - 1];
    const after = command[from + needle.length] ?? "";
    if (/^(?:|[\s"'=])$/.test(before) && /^(?:|[\s"'/\\])$/.test(after)) return true;
  }
  return false;
}

/**
 * Moves a leftover lock out of the way before start-up. The file is never deleted, so
 * an operator can still inspect it. Throws a lock refusal when it cannot be moved.
 */
export function moveStaleLockAside(pidFile: string): string {
  const aside = uniqueAsidePath(pidFile);
  try {
    renameSync(pidFile, aside);
  } catch (error) {
    throw new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: the leftover lock ${pidFile} could not be moved aside ` +
        `(${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions and start again.`,
    );
  }
  return aside;
}

export type PostgresProcess = { pid: number; command: string };

const inspectCommand = (pid: number) =>
  process.platform === "win32" ? `tasklist /FI "PID eq ${pid}" /V` : `ps -p ${pid} -o pid,args`;

const stopCommand = (pid: number) => (process.platform === "win32" ? `taskkill /PID ${pid}` : `kill ${pid}`);

/**
 * Finds PostgreSQL server processes that reference `dataDir` (by command line
 * or, where readable, working directory). Returns `null` when the process list
 * itself cannot be read, so callers can tell "none found" from "could not look".
 */
export async function listPostgresProcessesForDataDir(dataDir: string): Promise<PostgresProcess[] | null> {
  const run = (file: string, args: string[]) =>
    new Promise<string | null>((done) => {
      execFile(file, args, { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
        done(error ? null : stdout),
      );
    });
  const wanted = await canonicalDataDirectory(dataDir);
  const norm = (value: string) =>
    process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
  const needles = [...new Set([wanted, resolve(dataDir)])].map(norm);
  const found: PostgresProcess[] = [];
  if (process.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (out === null) return null;
    const trimmed = out.trim();
    if (!trimmed) return found;
    let rows: Array<{ ProcessId?: number; CommandLine?: string | null }>;
    try {
      const parsed = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
    for (const row of rows) {
      const command = row.CommandLine ?? "";
      if (typeof row.ProcessId === "number" && needles.some((n) => commandReferencesPath(norm(command), n))) {
        found.push({ pid: row.ProcessId, command });
      }
    }
    return found;
  }
  const out = await run("ps", ["-eo", "pid=,args="]);
  if (out === null) return null;
  return scanPsOutputForDataDir(out, needles, dataDir, (pid) => readlinkSync(`/proc/${pid}/cwd`));
}

/**
 * Picks the PostgreSQL servers in `ps -eo pid=,args=` output that use the data directory:
 * by command line, else by working directory. Returns `null` when a PostgreSQL server
 * matched nothing but its working directory could not be read (no /proc on macOS or BSD,
 * or no permission), because that server may still own the directory.
 */
export async function scanPsOutputForDataDir(
  out: string,
  needles: string[],
  dataDir: string,
  readCwd: (pid: number) => string,
): Promise<PostgresProcess[] | null> {
  const found: PostgresProcess[] = [];
  let cwdUnknown = false;
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === process.pid || !POSTGRES_PROCESS_NAME_RE.test((command.split(/\s+/)[0] ?? "").split("/").pop() ?? "")) continue;
    let owns = needles.some((n) => commandReferencesPath(command, n));
    // An explicit -D / --data-directory that names another directory settles it.
    const namesOtherDir = !owns && /(?:^|\s)(?:-D\s*|--data-directory[=\s])\S/.test(command);
    if (!owns && !namesOtherDir) {
      // A postmaster's working directory is its data directory (also when it was
      // started through PGDATA instead of -D).
      const cwd = (() => {
        try {
          return readCwd(pid);
        } catch {
          return null;
        }
      })();
      // No /proc (macOS, BSD) or an unreadable entry: this server's directory is unknown.
      if (cwd === null) cwdUnknown = true;
      else owns = await isSameDataDirectory(cwd, dataDir);
    }
    if (owns) found.push({ pid, command });
  }
  // Nothing matched, but a PostgreSQL server whose directory could not be inspected may
  // still own this one, so report "could not look" and let the caller refuse.
  if (found.length === 0 && cwdUnknown) return null;
  return found;
}

export type EmbeddedPostgresReuseOptions = {
  /** Test seam: resolves the executable name of a live PID. */
  readProcessName?: (pid: number) => Promise<string | null>;
  /** Test seam: PostgreSQL processes that reference the data directory, or null if unreadable. */
  listPostgresProcesses?: (dataDir: string) => Promise<PostgresProcess[] | null>;
};

/**
 * Handles a `postmaster.pid` whose owner cannot be read from the file (unreadable
 * or no valid PID). The owner is looked up without it: a server answering on the
 * configured port, or any PostgreSQL process referencing this data directory,
 * keeps the lock and refuses with the exact process and command to resolve it.
 * Only when nothing is found is the lock renamed aside so startup can proceed.
 */
async function recoverLockWithUnknownOwner(
  pidFile: string,
  dataDir: string,
  configuredPort: number,
  adminUrl: EmbeddedPostgresAdminUrl,
  options: EmbeddedPostgresReuseOptions,
  problem: string,
): Promise<null> {
  const refuse = (detail: string) =>
    new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: postmaster.pid ${problem}, and ${detail} ` +
        "The lock file was left unchanged.",
    );
  if ((await getPostgresDataDirectory(adminUrl(configuredPort)).catch(() => null)) !== null) {
    throw refuse(
      `a PostgreSQL server is answering on port ${configuredPort}. Stop it (or point the server at that instance), then start again.`,
    );
  }
  const owners = await (options.listPostgresProcesses ?? listPostgresProcessesForDataDir)(dataDir);
  if (owners === null) {
    throw refuse(
      "the process list could not be read, so a running PostgreSQL cannot be ruled out. " +
        `Once no PostgreSQL uses ${dataDir}, move postmaster.pid aside and start again.`,
    );
  }
  if (owners.length > 0) {
    const first = owners[0];
    throw refuse(
      `PostgreSQL process ${first.pid} (${first.command}) references this data directory. ` +
        `Stop it with \`${stopCommand(first.pid)}\`, then start again; the stale lock is handled automatically.`,
    );
  }
  const aside = uniqueAsidePath(pidFile);
  try {
    renameSync(pidFile, aside);
  } catch (error) {
    throw refuse(
      `it could not be moved aside (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions and start again.`,
    );
  }
  logger.warn(
    { pidFile, aside, problem },
    "postmaster.pid could not name its owner, no PostgreSQL answers or references this data directory; moved the lock file aside and trying normal startup",
  );
  return null;
}

export async function isSameDataDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([canonicalDataDirectory(a), canonicalDataDirectory(b)]);
  return left === right;
}

/**
 * Returns the PostgreSQL recorded in `postmaster.pid` when it is verified to
 * serve `dataDir`, or `null` only when the lock is affirmatively stale (no
 * PID file, a dead PID, this process's own PID, a recycled non-PostgreSQL PID,
 * or an unreadable/garbled lock with no PostgreSQL answering or referencing the
 * data directory). Throws `EmbeddedPostgresLockRefusal`, leaving the lock
 * untouched, whenever a possibly-live owner cannot be ruled out, because
 * removing it could start a second postmaster.
 */
export async function readRunningEmbeddedPostgres(
  dataDir: string,
  configuredPort: number,
  adminUrl: EmbeddedPostgresAdminUrl,
  options: EmbeddedPostgresReuseOptions = {},
): Promise<{ pid: number; port: number } | null> {
  const pidFile = resolve(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  let lines: string[];
  try {
    lines = readFileSync(pidFile, "utf8").split("\n");
  } catch (error) {
    return recoverLockWithUnknownOwner(
      pidFile,
      dataDir,
      configuredPort,
      adminUrl,
      options,
      `could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    );
  }
  const pid = Number(lines[0]?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return recoverLockWithUnknownOwner(
      pidFile,
      dataDir,
      configuredPort,
      adminUrl,
      options,
      "does not hold a valid process id",
    );
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH proves the process is gone. EPERM and any other error leave
    // liveness unknown, so identity must still be established.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
  }

  const port = Number(lines[3]?.trim() || configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EmbeddedPostgresLockRefusal("Refusing to reuse PostgreSQL: postmaster.pid has an invalid port.");
  }
  // PID occupancy alone is not PostgreSQL identity: the OS may recycle it.
  // A query also distinguishes PostgreSQL from an unrelated TCP listener.
  const actualDataDir = await getPostgresDataDirectory(adminUrl(port)).catch(() => null);
  if (actualDataDir === null) {
    if (pid === process.pid) {
      // The lock names this Node process, which is not PostgreSQL.
      logger.warn(
        { pid, port },
        "Embedded PostgreSQL identity could not be verified and postmaster.pid names the current process; treating postmaster.pid as stale and trying normal startup",
      );
      return null;
    }
    // A live PID that is affirmatively not PostgreSQL (the OS recycled it), with
    // nothing answering on the recorded or configured port, is a leftover lock.
    // The lock is moved aside, never deleted, so an operator can still inspect it.
    // An unknown process name keeps the refusal below.
    const processName = await (options.readProcessName ?? readProcessName)(pid);
    if (processName !== null && !POSTGRES_PROCESS_NAME_RE.test(processName)) {
      // The recorded port was already probed above; probe the configured one too.
      const configuredAnswers =
        port !== configuredPort &&
        (await getPostgresDataDirectory(adminUrl(configuredPort)).catch(() => null)) !== null;
      if (!configuredAnswers) {
        const aside = uniqueAsidePath(pidFile);
        try {
          renameSync(pidFile, aside);
        } catch (error) {
          throw new EmbeddedPostgresLockRefusal(
            `Refusing to start embedded PostgreSQL: postmaster.pid names process ${pid} (${processName}), which is not PostgreSQL, ` +
              `but the lock could not be moved aside (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions and start again.`,
          );
        }
        logger.warn(
          { pid, processName, port, aside },
          "postmaster.pid names a live process that is not PostgreSQL and no PostgreSQL answers; moved the lock file aside and trying normal startup",
        );
        return null;
      }
    }
    // Only name a stop command for a process that is verified to be a PostgreSQL
    // referencing this data directory; otherwise the PID may belong to anything.
    const owners = await (options.listPostgresProcesses ?? listPostgresProcessesForDataDir)(dataDir);
    const verified = owners?.find((owner) => owner.pid === pid);
    const action = verified
      ? `It is PostgreSQL for this data directory (${verified.command}). Stop it with \`${stopCommand(pid)}\` and start again.`
      : `It was not confirmed to be PostgreSQL for this data directory${processName ? ` (the process is named ${processName})` : ""}. ` +
        `Check what process ${pid} is (\`${inspectCommand(pid)}\`) and stop it only if it is PostgreSQL using ${dataDir}, then start again.`;
    throw new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: postmaster.pid names process ${pid}, which may still be alive, ` +
        `but PostgreSQL identity could not be verified on port ${port} (it may be starting, recovering, ` +
        `or refusing the login). The lock file was left unchanged. ${action}`,
    );
  }
  if (!(await isSameDataDirectory(actualDataDir, dataDir))) {
    throw new EmbeddedPostgresLockRefusal("Refusing to reuse PostgreSQL: its data directory belongs to another instance.");
  }
  return { pid, port };
}
