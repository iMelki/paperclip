import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { applyPendingMigrations, ensurePostgresDatabase } from "@paperclipai/db";

export const BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS = 90_000;
const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function canonicalDirectory(value: string | undefined, fixtureRoot = false): string {
  if (!value || !path.isAbsolute(value)) throw new Error("Explicit absolute board import fixture paths required");
  const resolved = path.resolve(value);
  if (normalize(fs.realpathSync.native(resolved)) !== normalize(resolved)) throw new Error("Canonical non-reparse fixture path required");
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Reparse fixture ancestors are forbidden");
    if (current === path.dirname(current)) break;
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Fixture root must already exist as a directory");
  if (fixtureRoot && (!/^board-import-fixtures(?:[-_][A-Za-z0-9_-]+)?$/.test(path.basename(resolved))
    || /(?:^|[\\/])\.paperclip(?:-worktrees)?(?:[\\/]|$)/i.test(resolved))) {
    throw new Error("A dedicated private board-import-fixtures directory is required, never a live instance root");
  }
  return resolved;
}
async function unusedPort(): Promise<number> {
  const reserved = new Set([5113, 5114, 5432, 54329, Number(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "").split(",").map(Number)]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      const timer = setTimeout(() => { server.close(); reject(new Error("Fixture port allocation timed out")); }, 2000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(error => { clearTimeout(timer); if (error || !address || typeof address === "string") {
          reject(error ?? new Error("Fixture port allocation failed"));
        } else resolve(address.port); });
      });
    });
    if (!reserved.has(port)) return port;
  }
  throw new Error("No non-reserved fixture loopback port available");
}

type NativeRun = (tag: string, executable: string, args: string[], timeoutMs?: number, accepted?: number[]) => Promise<string>;
type PipeCount = { seen: number; stored: number; dropped: number; ended: boolean };
type PipeCapture = { stdout: PipeCount; stderr: PipeCount; error?: Error; overOutputLimit: boolean };
const FIXTURE_OUTPUT_LIMIT = 2 * 1024 * 1024;

function captureFixturePipes(child: ReturnType<typeof spawn>, stdoutFd: number, stderrFd: number,
  finished: () => boolean, stop: () => void): PipeCapture {
  const state: PipeCapture = {
    stdout: { seen: 0, stored: 0, dropped: 0, ended: false },
    stderr: { seen: 0, stored: 0, dropped: 0, ended: false }, overOutputLimit: false,
  };
  const fail = (error: Error) => { state.error ??= error; stop(); };
  for (const name of ["stdout", "stderr"] as const) {
    const stream = child[name], metric = state[name], fd = name === "stdout" ? stdoutFd : stderrFd;
    if (!stream) { fail(new Error(`Fixture ${name} pipe is missing`)); continue; }
    stream.on("data", (chunk: Buffer | string) => {
      if (finished()) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      metric.seen += bytes.length;
      const allowed = Math.min(bytes.length, FIXTURE_OUTPUT_LIMIT - state.stdout.stored - state.stderr.stored);
      try {
        for (let offset = 0; offset < allowed;) {
          const written = fs.writeSync(fd, bytes, offset, allowed - offset);
          if (written <= 0) throw new Error("Fixture pipe capture made no write progress");
          offset += written; metric.stored += written;
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      metric.dropped = metric.seen - metric.stored;
      if (allowed < bytes.length) {
        state.overOutputLimit = true;
        fail(new Error("Fixture combined output limit exceeded"));
      }
    });
    stream.once("end", () => { metric.ended = true; });
    stream.once("error", fail);
  }
  return state;
}

type FixtureCommand = { pid: number | undefined; completion: Promise<string>; assertRunning: () => void;
  beginStop: () => void; terminate: () => void };

/** Same outer NativeJob owns short commands and the foreground PostgreSQL service. */
export function launchFixtureCommand(fixtureRoot: string, artifactDir: string, dataDir: string,
  childEnv: NodeJS.ProcessEnv, tag: string, executable: string, args: string[], timeoutMs = 25_000,
  accepted = [0], service = false): FixtureCommand {
  let pid: number | undefined;
  let assertRunning: () => void = () => { throw new Error("Fixture command did not start"); };
  let beginStop = () => {}, terminate = () => {};
  const completion = new Promise<string>((resolve, reject) => {
    canonicalDirectory(fixtureRoot, true); canonicalDirectory(artifactDir); canonicalDirectory(dataDir);
    const stdout = path.join(artifactDir, `${tag}.stdout.log`), stderr = path.join(artifactDir, `${tag}.stderr.log`);
    const stdoutFd = fs.openSync(stdout, "wx+"); let stderrFd: number;
    try { stderrFd = fs.openSync(stderr, "wx+"); } catch (error) { fs.closeSync(stdoutFd); throw error; }
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { cwd: artifactDir, env: childEnv, windowsHide: true, shell: false,
      stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { fs.closeSync(stdoutFd); fs.closeSync(stderrFd); throw error; }
    const startedAt = Date.now(); let settled = false, timedOut = false, rootExited = false, closeObserved = false, stopRequested = false;
    let expectedStop = false; pid = child.pid;
    let spawnError: Error | undefined;
    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      try { child.kill(); } catch (error) { spawnError ??= error instanceof Error ? error : new Error(String(error)); }
    };
    const capture = captureFixturePipes(child, stdoutFd, stderrFd, () => settled, stop);
    let timer: ReturnType<typeof setTimeout>, hardTimer: ReturnType<typeof setTimeout>;
    const finish = (code: number | null, signal: string | null, forcedError?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      try {
        const streamsComplete = capture.stdout.ended && capture.stderr.ended;
        const bytesAtCompletion = fs.fstatSync(stdoutFd).size + fs.fstatSync(stderrFd).size;
        const captureMatched = fs.fstatSync(stdoutFd).size === capture.stdout.stored
          && fs.fstatSync(stderrFd).size === capture.stderr.stored;
        const error = forcedError ?? spawnError ?? capture.error;
        fs.writeFileSync(path.join(artifactDir, `${tag}.receipt.json`), JSON.stringify({ tag, pid: child.pid ?? null, code, signal,
          rootExited, closeObserved, service, expectedStop, completionBasis: !rootExited ? "termination_unverified"
            : closeObserved && streamsComplete ? "root_exit_and_pipe_close" : "root_exit_pipe_drain_unverified",
          captureMode: "drained_pipes_to_durable_files", streamsComplete, captureMatched,
          stdout: capture.stdout, stderr: capture.stderr, error: error?.message ?? null,
          timedOut, overOutputLimit: capture.overOutputLimit, bytesAtCompletion, durationMs: Date.now() - startedAt,
          caller: "codex-board-import-fixture", completedAt: new Date().toISOString() }), { flag: "wx" });
        if (error || timedOut || capture.overOutputLimit || !rootExited || !closeObserved || !streamsComplete || !captureMatched
          || code === null || !accepted.includes(code)) {
          reject(error ?? new Error(`Fixture ${tag} failed; retained logs: ${artifactDir}`));
        } else {
          const buffer = Buffer.alloc(16384), readFd = fs.openSync(stdout, "r");
          try { resolve(buffer.subarray(0, fs.readSync(readFd, buffer, 0, buffer.length, 0)).toString("utf8")); }
          finally { fs.closeSync(readFd); }
        }
      } catch (captureError) { reject(captureError); }
      finally { for (const fd of [stdoutFd, stderrFd]) { try { fs.closeSync(fd); } catch { /* Failure retained. */ } } }
    };
    const armDeadline = (milliseconds: number) => {
      clearTimeout(timer); clearTimeout(hardTimer);
      timer = setTimeout(() => { timedOut = true; stop(); }, milliseconds);
      hardTimer = setTimeout(() => finish(null, null,
        new Error(`Fixture ${tag} did not reach verified exit and pipe drain; NativeJob custody required`)), milliseconds + 2000);
    };
    assertRunning = () => {
      if (spawnError || capture.error || timedOut || rootExited || settled) {
        throw spawnError ?? capture.error ?? new Error(`Fixture ${tag} is not a healthy running service`);
      }
    };
    beginStop = () => { expectedStop = true; if (!settled) armDeadline(10_000); };
    terminate = () => { stop(); if (!settled) armDeadline(2000); };
    armDeadline(timeoutMs);
    child.once("error", error => { spawnError ??= error; stop(); });
    child.once("exit", () => {
      rootExited = true;
      if (service && !expectedStop) spawnError ??= new Error(`Fixture ${tag} exited before owned shutdown`);
    });
    // exit alone can precede the last output; only close establishes pipe drain completion.
    child.once("close", (code, signal) => { closeObserved = true; finish(code, signal); });
  });
  // Retain service failures until readiness/cleanup consumes them; never leave an unhandled rejection.
  void completion.catch(() => undefined);
  return { pid, completion, assertRunning: () => assertRunning(), beginStop: () => beginStop(), terminate: () => terminate() };
}

export function createRunner(fixtureRoot: string, artifactDir: string, dataDir: string,
  childEnv: NodeJS.ProcessEnv): NativeRun {
  return (tag, executable, args, timeoutMs = 25_000, accepted = [0]) =>
    launchFixtureCommand(fixtureRoot, artifactDir, dataDir, childEnv, tag, executable, args, timeoutMs, accepted).completion;
}

function fixtureIdentity(dataDir: string, port: number, pid: number | undefined): string[] | null {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!fs.existsSync(pidFile)) return null;
  if (fs.lstatSync(pidFile).isSymbolicLink()) throw new Error("Fixture process identity file is a reparse point");
  const lines = fs.readFileSync(pidFile, "utf8").split(/\r?\n/);
  if (lines.length < 8) return null; // PostgreSQL can still be writing its startup identity.
  if (!pid || Number(lines[0]) !== pid || normalize(path.resolve(lines[1])) !== normalize(dataDir)
    || Number(lines[3]) !== port) throw new Error("Fixture cluster identity mismatch; nothing stopped");
  return lines;
}

/** PostgreSQL 18 PID-file line 8 is the same readiness discriminator used by pg_ctl -w. */
export async function waitForFixtureReady(service: FixtureCommand, dataDir: string, port: number, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    service.assertRunning();
    if (fixtureIdentity(dataDir, port, service.pid)?.[7].trim() === "ready") return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("Fixture PostgreSQL readiness deadline exceeded");
}

// Worst failure chain: stop10s + own terminate4s + status5s =19s; client close5s leaves6s of each30s hook.
export function createCleanup(run: NativeRun, artifactDir: string, dataDir: string, port: number,
  pgCtl: string, stage: { startRequested: boolean; service?: FixtureCommand }) {
  let stopped = false;
  return async () => {
    if (stopped) return;
    const pidFile = path.join(dataDir, "postmaster.pid"), service = stage.service;
    const failures: unknown[] = [];
    try {
      if (fs.existsSync(pidFile)) {
        if (!fixtureIdentity(dataDir, port, service?.pid)) throw new Error("Incomplete fixture identity; no pg_ctl stop");
        fs.writeFileSync(path.join(artifactDir, "postmaster-identity.json"), JSON.stringify({
          pid: service?.pid, dataDir, port, observedAt: new Date().toISOString(),
        }), { flag: "wx" });
        service?.beginStop();
        await run("stop", pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "5"], 8000);
      } else if (service) { service.beginStop(); service.terminate(); }
    } catch (error) { failures.push(error); service?.terminate(); }
    if (service) { try { await service.completion; } catch (error) { failures.push(error); } }
    try {
      if (stage.startRequested) await run("shutdown-status", pgCtl, ["status", "-D", dataDir], 3000, [3]);
      if (fs.existsSync(pidFile)) throw new Error("Fixture shutdown not verified; data and logs retained");
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, `Fixture owned shutdown or pipe drain unverified: ${artifactDir}`);
    stopped = true;
  };
}
async function migrateFixture(connectionString: string, adminUrl: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ensurePostgresDatabase(adminUrl, "board_import_fixture").then(() => applyPendingMigrations(connectionString)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture migration deadline exceeded")), 45_000); })]);
  } finally { clearTimeout(timer); }
}
/** Mandatory native fixture. The caller's NativeJob owns every descendant; no process reaper is used. */
export async function startBoardImportFixtureDatabase() {
  if (process.platform !== "win32") throw new Error("This bounded fixture launcher is qualified only for native Windows");
  if (Object.keys(process.env).some(key => /^PG/i.test(key))) throw new Error("NativeJob fixture environment must omit PG* defaults and credential variables");
  const fixtureRoot = canonicalDirectory(process.env.PAPERCLIP_BOARD_FIXTURE_ROOT, true);
  const binRoot = canonicalDirectory(process.env.PAPERCLIP_BOARD_FIXTURE_PG_BIN_ROOT);
  const expectedVersion = process.env.PAPERCLIP_BOARD_FIXTURE_PG_VERSION;
  if (!expectedVersion || !/^\d+(?:\.\d+){1,2}$/.test(expectedVersion)) throw new Error("Exact fixture PostgreSQL version pin required");
  const artifactDir = fs.mkdtempSync(path.join(fixtureRoot, "pg-"));
  canonicalDirectory(artifactDir);
  const dataDir = path.join(artifactDir, "data"); fs.mkdirSync(dataDir);
  const port = await unusedPort();
  const binaries = Object.fromEntries(["initdb", "pg_ctl", "postgres"].map(name => {
    const executable = path.join(binRoot, `${name}.exe`);
    if (fs.lstatSync(executable).isSymbolicLink() || !fs.statSync(executable).isFile()) throw new Error("Fixture binary must be a regular file");
    return [name, executable];
  }));
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (/^(?:path|pathext|systemroot|windir|comspec|temp|tmp|lang|lc_[a-z_]+)$/i.test(key)) childEnv[key] = process.env[key];
  const pathKey = Object.keys(childEnv).find(key => /^path$/i.test(key)) ?? "PATH";
  childEnv[pathKey] = [binRoot, canonicalDirectory(path.join(binRoot, "..", "lib")), childEnv[pathKey] ?? ""].join(path.delimiter);
  const run = createRunner(fixtureRoot, artifactDir, dataDir, childEnv);
  const stage: { startRequested: boolean; service?: FixtureCommand } = { startRequested: false };
  const cleanup = createCleanup(run, artifactDir, dataDir, port, binaries.pg_ctl, stage);
  try {
    const pins: Record<string, { path: string; version: string; sha256: string }> = {};
    for (const [name, executable] of Object.entries(binaries)) {
      const version = (await run(`${name}-version`, executable, ["--version"], 5000)).trim();
      if (version.match(/\(PostgreSQL\) (\d+(?:\.\d+){1,2})/)?.[1] !== expectedVersion) throw new Error("Fixture PostgreSQL version mismatch");
      pins[name] = { path: executable, version, sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") };
    }
    fs.writeFileSync(path.join(artifactDir, "binary-pins.json"), JSON.stringify(pins, null, 2), { flag: "wx" });
    await run("initdb", binaries.initdb, ["-D", dataDir, "-U", "paperclip_fixture", "--auth=trust", "--encoding=UTF8", "--locale=C", "--lc-messages=C", "--no-instructions"], 30_000);
    stage.startRequested = true;
    stage.service = launchFixtureCommand(fixtureRoot, artifactDir, dataDir, childEnv, "postgres-service",
      binaries.postgres, ["-D", dataDir, "-h", "127.0.0.1", "-p", String(port),
        "-c", "unix_socket_directories=", "-c", "logging_collector=off"], 180_000, [0], true);
    await waitForFixtureReady(stage.service, dataDir, port);
    fs.writeFileSync(path.join(artifactDir, "readiness.json"), JSON.stringify({
      pid: stage.service.pid, dataDir, port, basis: "owned_postmaster_pid_ready", observedAt: new Date().toISOString(),
    }), { flag: "wx" });
    const connectionString = `postgres://paperclip_fixture:@127.0.0.1:${port}/board_import_fixture`;
    await migrateFixture(connectionString, `postgres://paperclip_fixture:@127.0.0.1:${port}/postgres`);
    stage.service.assertRunning();
    console.info(`Native board import fixture retained at ${artifactDir}; loopback port ${port}`);
    return { connectionString, cleanup, artifactDir, dataDir, port };
  } catch (error) {
    try { await cleanup(); } catch (stopError) { throw new AggregateError([error, stopError], `Fixture failed and shutdown is unverified: ${artifactDir}`); }
    throw error;
  }
}
