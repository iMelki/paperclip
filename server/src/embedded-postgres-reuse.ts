import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getPostgresDataDirectory } from "@paperclipai/db";
import { serverLogShowsRecoveryInProgress } from "./embedded-postgres-start-wait.js";
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
// Case-sensitive on purpose: PostgreSQL's lowercase `-d <debuglevel>` is not a data directory.
const DATA_DIRECTORY_ARGUMENT =
  /(?:^|\s)(?:-D\s*|--data-directory[=\s])(?:"([^"]+)"|'([^']+)'|(\S+))/g;

// `-c data_directory=<path>` and `--data_directory=<path>` set the effective data directory and take
// precedence over `-D`, which then names only the configuration directory.
const DATA_DIRECTORY_SETTING =
  /(?:^|\s)(?:-c\s*|--)data_directory=(?:"([^"]+)"|'([^']+)'|(\S+))/g;

const POSTGRES_CHILD_TITLE_RE = /^postgres:\s/i;
const POSTGRES_FORK_CHILD_RE = /(?:^|\s)--fork/i;

type DataDirectoryOwnership = "owns" | "unknown";

/**
 * Whether `command` names this data directory. A command can only prove that it owns the directory:
 * `data_directory` in a configuration file (or one it includes) can replace whatever `-D` names, so a
 * different directory is "unknown", never "other". Anything that is not evidence (PGDATA, a relative
 * path, a value cut at a space) is also "unknown".
 */
async function commandOwnership(
  command: string,
  needles: string[],
  dataDir: string,
): Promise<DataDirectoryOwnership> {
  // `-D` is read from the command as given: Windows normalization lowercases the whole line, which
  // would turn `-D` into the debug-level option `-d`. Only the path comparison below uses it.
  // PostgreSQL applies the last occurrence of an option, so that one is the effective value. A
  // data_directory setting on the command line wins over `-D`.
  let override: string | undefined;
  for (const named of command.matchAll(DATA_DIRECTORY_SETTING)) override = named[1] ?? named[2] ?? named[3];
  if (override && isAbsolute(override)) {
    return (await isSameDataDirectory(override, dataDir)) ? "owns" : "unknown";
  }
  let value: string | undefined;
  for (const named of command.matchAll(DATA_DIRECTORY_ARGUMENT)) value = named[1] ?? named[2] ?? named[3];
  let normalized = normalizeCommand(command);
  if (value && isAbsolute(value) && existsSync(value)) {
    if (await isSameDataDirectory(value, dataDir)) return "owns";
    // Another existing directory is the effective one: look for this directory elsewhere in the
    // command, not in an earlier or longer data-directory option (a descendant such as
    // `<dataDir>/backup` would otherwise pass the path-reference test).
    for (const named of command.matchAll(DATA_DIRECTORY_ARGUMENT)) {
      const given = named[1] ?? named[2] ?? named[3];
      if (given) normalized = normalized.split(normalizeCommand(given)).join(" ");
    }
  }
  return needles.some((needle) => commandReferencesPath(normalized, needle)) ? "owns" : "unknown";
}

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
  // An archive inside a cluster directory that was never initialised (no PG_VERSION) would make
  // initdb reject it as non-empty, so it is kept beside the directory instead.
  const dir = dirname(pidFile);
  const archived = existsSync(join(dir, "PG_VERSION"))
    ? pidFile
    : join(dirname(dir), `${basename(dir)}.${basename(pidFile)}`);
  const base = `${archived}.stale-${Date.now()}`;
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

/** What identifies one particular `postmaster.pid` file: a replacement file differs in at least one field. */
export type LockIdentity = { dev: number; ino: number; size: number; mtimeMs: number };

/** Identity of the lock file now at `pidFile`, or `null` when it cannot be inspected. */
export function readLockIdentity(pidFile: string): LockIdentity | null {
  try {
    const { dev, ino, size, mtimeMs } = lstatSync(pidFile);
    return { dev, ino, size, mtimeMs };
  } catch {
    return null;
  }
}

const sameLockIdentity = (a: LockIdentity | null, b: LockIdentity) =>
  a !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

export type EmbeddedStartLockOptions = {
  timeoutMs?: number;
  pollMs?: number;
  /** Test seam: writes the owner record into the freshly created lock file. */
  writeOwner?: (fd: number, text: string) => void;
};

/**
 * Serialises embedded PostgreSQL starts on one data directory. The lock is a file beside the data
 * directory (never inside it), created exclusively and holding the owner's PID. A start that finds it
 * waits until the owner releases it or is gone, so a second Paperclip start can neither look at the
 * data directory's `postmaster.pid` while the first is still starting PostgreSQL, nor move it. Hold it
 * from the first lock check through `start()`. A lock is never moved or removed by a later start:
 * an owner that is alive, or a file that cannot be read, is waited for and then refused after
 * `timeoutMs`; an owner that is gone (`ESRCH`) is refused at once with a manual step, because no
 * rename can test that the file is still the one that was read. Where the lock cannot be created
 * or written (for example a read-only parent directory) the start refuses; it never continues
 * unserialised.
 * Returns the function that releases the lock.
 */
export async function acquireEmbeddedStartLock(
  dataDir: string,
  options: EmbeddedStartLockOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  const refuse = (message: string) => new EmbeddedPostgresLockRefusal(`Refusing to start embedded PostgreSQL: ${message}`);
  // The name is keyed on the physical path, so a symlink or junction to the data directory shares one lock.
  const lockBase = (() => {
    try {
      return physicalPathBeside(dataDir);
    } catch (error) {
      throw refuse(
        `the physical location of ${resolve(dataDir)} could not be established (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), ` +
          "so concurrent starts cannot be serialised. Fix the path or its permissions and start again.",
      );
    }
  })();
  const lockPath = `${lockBase}.paperclip-start.lock`;
  try {
    // On a first start the directory that will contain the data directory may not exist yet.
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw refuse(
      `the directory ${dirname(lockPath)} could not be created (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), ` +
        "so concurrent starts cannot be serialised. Fix its permissions and start again.",
    );
  }
  const readOwner = (file: string): { text: string; pid: number | null } | null => {
    try {
      const text = readFileSync(file, "utf8");
      const pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
      return { text, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : { text: "", pid: null };
    }
  };
  const createExclusively = (file: string): void => {
    const fd = openSync(file, "wx");
    try {
      (options.writeOwner ?? ((target, text) => void writeSync(target, text)))(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
    } catch (error) {
      // The file was created by this call, so it may be removed: an empty or partial lock would
      // otherwise block every later start. Any write or close error refuses the start.
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      try {
        unlinkSync(file);
      } catch {
        // Gone already.
      }
      throw error;
    }
  };
  const timeoutRefusal = (owner: { pid: number | null } | null) =>
    refuse(
      `another start holds ${lockPath}` +
        (owner?.pid != null ? ` (process ${owner.pid})` : " (its owner could not be read)") +
        ` and did not finish in ${Math.round(timeoutMs / 1000)} seconds. If no Paperclip server is starting, move that file aside by hand and start again. Do not delete any data.`,
    );
  for (;;) {
    try {
      createExclusively(lockPath);
      return () => {
        try {
          if (readOwner(lockPath)?.text.includes(token)) unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Anything but "already exists" is a permanent problem: starting without the lock would leave
      // concurrent starts unserialised, so the start refuses and says what to fix.
      if (code !== "EEXIST") {
        throw refuse(
          `the start lock ${lockPath} could not be created (${code ?? "unknown error"}), so concurrent starts cannot be serialised. ` +
            `The directory that contains the data directory must be writable. Fix its permissions and start again.`,
        );
      }
    }
    const owner = readOwner(lockPath);
    let dead = false;
    if (owner !== null && owner.pid !== null) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (owner !== null && dead) {
      // ESRCH shows that the recorded process is gone, not that the file at this name is still the
      // lock that was read, and a rename cannot test that. The file is left for an operator.
      throw refuse(
        `the start lock ${lockPath} names process ${owner.pid}, which is gone (a start that did not finish). ` +
          "It is not removed automatically. Confirm that no Paperclip server is starting, move that file aside by hand (keep it), and start again. Do not delete any data.",
      );
    }
    if (Date.now() >= deadline) throw timeoutRefusal(owner);
    await new Promise((done) => setTimeout(done, owner === null ? Math.min(pollMs, 10) : pollMs));
  }
}

/**
 * `dataDir` resolved through every symlink and junction of the part that exists, with the part that
 * does not exist yet appended. Throws when no ancestor can be resolved.
 */
function physicalPathBeside(dataDir: string): string {
  const absolute = resolve(dataDir);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const physical = missing.length > 0 ? join(real, ...missing.reverse()) : real;
      return process.platform === "win32" ? physical.toLowerCase() : physical;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(probe);
      if ((code === "ENOENT" || code === "ENOTDIR") && parent !== probe) {
        missing.push(basename(probe));
        probe = parent;
        continue;
      }
      throw error;
    }
  }
}

/** Test seam: runs at the two points where another process could replace the lock. */
export type LockMoveHooks = {
  /** After the file at the name was verified, before it is moved. */
  afterVerify?: () => void;
  /** After a replacement was moved, before it is put back. */
  beforeRestore?: () => void;
};

/**
 * Moves `pidFile` aside only if it is still the file the caller examined (`expected`). The check
 * happens before anything is removed: a hard link takes hold of whatever file has the name now, and
 * that file is compared with `expected` while it is still in place, so a replacement (a live server's
 * new lock) is never taken out of its path on the strength of a stale verdict. Only then is the name
 * moved, and the moved file is compared once more. The rename itself cannot test identity, so a file
 * that replaces the verified one in that last instant is put back with a hard link, which never
 * overwrites a newer file; if the name was taken again it stays where it was moved and the refusal
 * names it. An unknown identity (`expected` null) fails closed. Other lock-start processes are kept
 * out of that last instant by the start lock (`acquireEmbeddedStartLock`).
 * Returns the archive path, or `null` when the lock was already gone. Raw OS errors are thrown as they are.
 */
function renameLockAside(
  pidFile: string,
  expected: LockIdentity | null | undefined,
  hooks: LockMoveHooks = {},
): string | null {
  const refuse = (detail: string) =>
    new EmbeddedPostgresLockRefusal(`Refusing to start embedded PostgreSQL: ${pidFile} ${detail} The lock was not archived.`);
  if (!expected) {
    throw refuse("could not be identified, so it cannot be shown to be the stale lock that was examined.");
  }
  const aside = uniqueAsidePath(pidFile);
  try {
    linkSync(pidFile, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!sameLockIdentity(readLockIdentity(aside), expected)) {
    unlinkSync(aside); // only the extra name; the file at pidFile is untouched
    throw refuse("was replaced while it was being checked, so it is not the lock that was examined. It was left in place.");
  }
  hooks.afterVerify?.();
  const moved = `${aside}.moving`;
  renameSync(pidFile, moved);
  if (sameLockIdentity(readLockIdentity(moved), expected)) {
    unlinkSync(moved); // the verified file is archived under `aside`
    return aside;
  }
  hooks.beforeRestore?.();
  try {
    linkSync(moved, pidFile);
    unlinkSync(moved);
  } catch {
    throw refuse(
      `was replaced in the instant it was moved, and the name was taken again before it could be put back. The replacement is kept at ${moved}; ` +
        "check that no PostgreSQL is using this data directory.",
    );
  }
  throw refuse("was replaced in the instant it was moved. The replacement was put back.");
}

/**
 * Moves a leftover lock out of the way before start-up. The file is never deleted, so
 * an operator can still inspect it. Throws a lock refusal when it cannot be moved, when
 * `expected` is missing, or when the file at the name is not the one `expected` describes.
 * Returns `null` when the lock was already gone.
 */
export function moveStaleLockAside(
  pidFile: string,
  expected: LockIdentity | null | undefined,
  hooks?: LockMoveHooks,
): string | null {
  try {
    return renameLockAside(pidFile, expected, hooks);
  } catch (error) {
    if (error instanceof EmbeddedPostgresLockRefusal) throw error;
    throw new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: the leftover lock ${pidFile} could not be moved aside ` +
        `(${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Fix its permissions and start again.`,
    );
  }
}

export type PostgresProcess = { pid: number; command: string };

const inspectCommand = (pid: number) =>
  process.platform === "win32" ? `tasklist /FI "PID eq ${pid}" /V` : `ps -p ${pid} -o pid,args`;

const stopCommand = (pid: number) => (process.platform === "win32" ? `taskkill /PID ${pid}` : `kill ${pid}`);

/**
 * Finds PostgreSQL server processes that reference `dataDir` (by command line
 * or, where readable, working directory). Returns `null` when the process list
 * itself cannot be read, so callers can tell "none found" from "could not look".
 * When the result is `null` because some servers could not be tied to any directory,
 * those servers are added to `undecided` so a refusal can name them.
 */
export async function listPostgresProcessesForDataDir(
  dataDir: string,
  undecided?: PostgresProcess[],
): Promise<PostgresProcess[] | null> {
  const run = (file: string, args: string[]) =>
    new Promise<string | null>((done) => {
      execFile(file, args, { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
        done(error ? null : stdout),
      );
    });
  const needles = await dataDirectoryNeedles(dataDir);
  if (process.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    if (out === null) return null;
    const trimmed = out.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed) as WindowsPostgresRow | WindowsPostgresRow[];
      return scanWindowsPostgresRows(Array.isArray(parsed) ? parsed : [parsed], needles, dataDir, undecided);
    } catch {
      return null;
    }
  }
  // `comm` is the executable name (a full path on macOS, read by its last segment), so a
  // path with spaces in `args` is not mistaken for the process name.
  // Two listings, joined by pid: `comm` can hold a path with spaces (macOS), so it cannot
  // share a line with `args` and still be split reliably.
  const commOut = await run("ps", ["-eo", "pid=,comm="]);
  const argsOut = await run("ps", ["-eo", "pid=,args="]);
  if (commOut === null || argsOut === null) return null;
  return scanPsOutputForDataDir(joinPsColumns(commOut, argsOut), needles, dataDir, (pid) =>
    readlinkSync(`/proc/${pid}/cwd`), undecided);
}

export type WindowsPostgresRow = { ProcessId?: number; CommandLine?: string | null };

/**
 * Classifies Windows `postgres.exe` rows. A server whose command line does not
 * name a data directory (it was started through PGDATA, or WMI omitted the
 * command line) is inconclusive: returning an empty list there would let
 * startup move a live postmaster's lock aside.
 */
export async function scanWindowsPostgresRows(
  rows: WindowsPostgresRow[],
  needles: string[],
  dataDir: string,
  undecided: PostgresProcess[] = [],
): Promise<PostgresProcess[] | null> {
  const found: PostgresProcess[] = [];
  let unknown = false;
  for (const row of rows) {
    if (typeof row.ProcessId !== "number") continue;
    const command = row.CommandLine ?? "";
    // Windows postmaster children (`postgres.exe --forkbackend` etc.) carry no data directory and
    // are not servers; counting them would make any unrelated PostgreSQL look inconclusive.
    if (POSTGRES_FORK_CHILD_RE.test(command)) continue;
    const ownership = await commandOwnership(command, needles, dataDir);
    if (ownership === "owns") found.push({ pid: row.ProcessId, command });
    else if (ownership === "unknown") {
      unknown = true;
      undecided.push({ pid: row.ProcessId, command });
    }
  }
  if (found.length === 0 && unknown) return null;
  return found;
}

const PS_LINE_RE = /^\s*(\d+)\s+(.*\S)\s*$/;

/** Joins `ps -eo pid=,comm=` and `ps -eo pid=,args=` into `pid<TAB>comm<TAB>args` lines. */
export function joinPsColumns(commOut: string, argsOut: string): string {
  const args = new Map<string, string>();
  for (const line of argsOut.split("\n")) {
    const match = PS_LINE_RE.exec(line);
    if (match) args.set(match[1], match[2]);
  }
  const rows: string[] = [];
  for (const line of commOut.split("\n")) {
    const match = PS_LINE_RE.exec(line);
    if (match) rows.push(`${match[1]}\t${match[2]}\t${args.get(match[1]) ?? ""}`);
  }
  return rows.length ? `${rows.join("\n")}\n` : "";
}

/**
 * Picks the PostgreSQL servers in `pid<TAB>comm<TAB>args` rows (see joinPsColumns) that use the data
 * directory: by command line, else by working directory. `comm` is matched as the
 * process name so an executable path that contains spaces is still examined.
 * Returns `null` when a PostgreSQL server matched nothing but its working directory
 * could not be read (no /proc on macOS or BSD, or no permission), because that
 * server may still own the directory.
 */
export async function scanPsOutputForDataDir(
  out: string,
  needles: string[],
  dataDir: string,
  readCwd: (pid: number) => string,
  undecided: PostgresProcess[] = [],
): Promise<PostgresProcess[] | null> {
  const found: PostgresProcess[] = [];
  let cwdUnknown = false;
  for (const line of out.split("\n")) {
    const [pidText, comm = "", command = ""] = line.split("\t");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || !POSTGRES_PROCESS_NAME_RE.test(comm.replace(/\\/g, "/").split("/").pop() ?? "")) continue;
    // Backends and workers rename themselves `postgres: checkpointer ...`; they are not servers.
    if (POSTGRES_CHILD_TITLE_RE.test(command)) continue;
    // A postmaster's working directory is its data directory, whatever its command line says (an
    // include in a configuration file can hide a data_directory override), so a readable one decides.
    const cwd = (() => {
      try {
        return readCwd(pid);
      } catch {
        return null;
      }
    })();
    let owns: boolean;
    if (cwd !== null) owns = await isSameDataDirectory(cwd, dataDir);
    else {
      // No /proc (macOS, BSD) or an unreadable entry: only the command line can show ownership.
      owns = (await commandOwnership(command, needles, dataDir)) === "owns";
      // Nothing proves it is another server, so its directory is unknown.
      if (!owns) {
        cwdUnknown = true;
        undecided.push({ pid, command });
      }
    }
    if (owns) found.push({ pid, command });
  }
  // Nothing matched, but a PostgreSQL server whose directory could not be inspected may
  // still own this one, so report "could not look" and let the caller refuse.
  if (found.length === 0 && cwdUnknown) return null;
  return found;
}

async function dataDirectoryNeedles(dataDir: string): Promise<string[]> {
  const wanted = await canonicalDataDirectory(dataDir);
  return [...new Set([wanted, resolve(dataDir)])].map(normalizeCommand);
}

function normalizeCommand(value: string): string {
  return process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
}

export type EmbeddedPostgresReuseOptions = {
  /** Test seam: resolves the executable name of a live PID. */
  readProcessName?: (pid: number) => Promise<string | null>;
  /** Test seam: PostgreSQL processes that reference the data directory, or null if unreadable. */
  listPostgresProcesses?: (dataDir: string, undecided?: PostgresProcess[]) => Promise<PostgresProcess[] | null>;
  /** Test seam: runs where another process could replace the lock while it is moved. */
  lockMoveHooks?: LockMoveHooks;
  /** True only while the caller holds the start lock (`acquireEmbeddedStartLock`). A lock is moved aside only then. */
  startLockHeld?: boolean;
  /** The embedded PostgreSQL server log. Defaults to `server.log` in the data directory. */
  serverLogPath?: string;
};

/** True when the server log shows crash recovery that has not reached "ready" yet. */
function serverLogShowsRecovery(logPath: string): boolean {
  try {
    return serverLogShowsRecoveryInProgress(readFileSync(logPath, "utf8"));
  } catch {
    return false;
  }
}

/**
 * A lock is only moved aside while this start holds the start lock for the data directory. Without
 * it nothing keeps another Paperclip start out of the short step in which a lock is moved, so the
 * lock stays where it is and an operator decides.
 */
function requireStartLock(pidFile: string, options: EmbeddedPostgresReuseOptions): void {
  if (options.startLockHeld === true) return;
  throw new EmbeddedPostgresLockRefusal(
    `Refusing to start embedded PostgreSQL: ${pidFile} may be stale, but it is only moved aside while this start holds the start lock, ` +
      "which it does not. The lock was not archived. Start again through the server, or move the file aside by hand after confirming no PostgreSQL uses this data directory. Do not delete any data.",
  );
}

const describeProcesses = (processes: PostgresProcess[]) =>
  processes.map((entry) => `PostgreSQL process ${entry.pid} (${entry.command || "command line not available"})`).join("; ");

/** The safe manual step when ownership cannot be proven. It never suggests deleting data. */
const manualStep = (pidFile: string, processes: PostgresProcess[]) =>
  `Stop ${processes.length === 1 ? "that server" : "those servers"}` +
  (processes.length === 1 ? ` with \`${stopCommand(processes[0].pid)}\`` : "") +
  `, or, if ${processes.length === 1 ? "it is" : "they are"} unrelated, move ${pidFile} aside by hand after confirming no Paperclip instance is running. ` +
  "Do not delete any data.";

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
  lockIdentity: LockIdentity | null,
): Promise<null> {
  const refuse = (detail: string) =>
    new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: postmaster.pid ${problem}, and ${detail} ` +
        "The lock file was left unchanged.",
    );
  const answeringDir = await getPostgresDataDirectory(adminUrl(configuredPort)).catch(() => null);
  // A server on the configured port that serves another data directory is not this lock's owner.
  if (answeringDir !== null && (await isSameDataDirectory(answeringDir, dataDir))) {
    throw refuse(
      `a PostgreSQL server is answering on port ${configuredPort}. Stop it (or point the server at that instance), then start again.`,
    );
  }
  const undecided: PostgresProcess[] = [];
  const owners = await (options.listPostgresProcesses ?? listPostgresProcessesForDataDir)(dataDir, undecided);
  if (owners === null) {
    throw refuse(
      undecided.length > 0
        ? `ownership of this data directory could not be proven for ${describeProcesses(undecided)}. ${manualStep(pidFile, undecided)}`
        : "the process list could not be read, so a running PostgreSQL cannot be ruled out. " +
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
  let aside: string | null;
  try {
    requireStartLock(pidFile, options);
    aside = renameLockAside(pidFile, lockIdentity, options.lockMoveHooks);
  } catch (error) {
    if (error instanceof EmbeddedPostgresLockRefusal) throw error;
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

/**
 * A stale lock inside a cluster directory that has no PG_VERSION would make the first-time
 * `initdb` fail (it needs an empty directory), and initialisation runs before any later
 * lock handling, so the lock is archived beside the directory here. An initialised cluster
 * keeps its lock for the caller's existing handling.
 */
function moveAsideBeforeInitialisation(
  pidFile: string,
  dataDir: string,
  lockIdentity: LockIdentity | null,
  options: EmbeddedPostgresReuseOptions,
): void {
  if (existsSync(join(dataDir, "PG_VERSION"))) return;
  requireStartLock(pidFile, options);
  const aside = moveStaleLockAside(pidFile, lockIdentity, options.lockMoveHooks);
  logger.warn({ pidFile, aside }, "moved a stale postmaster.pid out of an uninitialised data directory");
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
  // The verdict below is about this file; a rename later must still find the same one.
  const lockIdentity = readLockIdentity(pidFile);
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
      lockIdentity,
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
      lockIdentity,
    );
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    // Only ESRCH proves the process is gone. EPERM and any other error leave
    // liveness unknown, so identity must still be established.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      moveAsideBeforeInitialisation(pidFile, dataDir, lockIdentity, options);
      return null;
    }
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
      moveAsideBeforeInitialisation(pidFile, dataDir, lockIdentity, options);
      return null;
    }
    // A live PID that is affirmatively not PostgreSQL (the OS recycled it), with
    // nothing answering on the recorded or configured port, is a leftover lock.
    // The lock is moved aside, never deleted, so an operator can still inspect it.
    // An unknown process name keeps the refusal below.
    const processName = await (options.readProcessName ?? readProcessName)(pid);
    if (processName !== null && !POSTGRES_PROCESS_NAME_RE.test(processName)) {
      // The recorded port was already probed above; probe the configured one too.
      const configuredDir =
        port !== configuredPort
          ? await getPostgresDataDirectory(adminUrl(configuredPort)).catch(() => null)
          : null;
      // A server on the configured port that serves another data directory does not own this lock.
      const configuredAnswers = configuredDir !== null && (await isSameDataDirectory(configuredDir, dataDir));
      if (!configuredAnswers) {
        let aside: string | null;
        try {
          requireStartLock(pidFile, options);
    aside = renameLockAside(pidFile, lockIdentity, options.lockMoveHooks);
        } catch (error) {
          if (error instanceof EmbeddedPostgresLockRefusal) throw error;
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
    const undecided: PostgresProcess[] = [];
    const owners = await (options.listPostgresProcesses ?? listPostgresProcessesForDataDir)(dataDir, undecided);
    const verified = owners?.find((owner) => owner.pid === pid);
    const serverLogPath = options.serverLogPath ?? join(dataDir, "server.log");
    // Stopping a server in crash recovery restarts recovery from the beginning, so say to wait instead.
    const action = verified && serverLogShowsRecovery(serverLogPath)
      ? `It is PostgreSQL for this data directory (${verified.command}), and its server log (${serverLogPath}) shows ` +
        "crash recovery that has not finished. Do not stop it: a stop restarts recovery from the beginning. " +
        "Wait until the log shows \"database system is ready to accept connections\", then start again."
      : verified
      ? `It is PostgreSQL for this data directory (${verified.command}). Stop it with \`${stopCommand(pid)}\` and start again.`
      : `It was not confirmed to be PostgreSQL for this data directory${processName ? ` (the process is named ${processName})` : ""}. ` +
        `Check what process ${pid} is (\`${inspectCommand(pid)}\`) and stop it only if it is PostgreSQL using ${dataDir}, then start again.`;
    throw new EmbeddedPostgresLockRefusal(
      `Refusing to start embedded PostgreSQL: postmaster.pid names process ${pid}, which may still be alive, ` +
        `but PostgreSQL identity could not be verified on port ${port} (it may be starting, recovering, ` +
        `or refusing the login). The lock file was left unchanged. ${action}` +
        (undecided.length > 0
          ? ` Ownership of this data directory also could not be proven for ${describeProcesses(undecided)}. ${manualStep(pidFile, undecided)}`
          : ""),
    );
  }
  if (!(await isSameDataDirectory(actualDataDir, dataDir))) {
    throw new EmbeddedPostgresLockRefusal("Refusing to reuse PostgreSQL: its data directory belongs to another instance.");
  }
  return { pid, port };
}
