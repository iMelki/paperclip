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
function createRunner(fixtureRoot: string, artifactDir: string, dataDir: string, childEnv: NodeJS.ProcessEnv): NativeRun {
  return (tag, executable, args, timeoutMs = 25_000, accepted = [0]) => new Promise<string>((resolve, reject) => {
    canonicalDirectory(fixtureRoot, true); canonicalDirectory(artifactDir); canonicalDirectory(dataDir);
    const stdout = path.join(artifactDir, `${tag}.stdout.log`), stderr = path.join(artifactDir, `${tag}.stderr.log`);
    const stdoutFd = fs.openSync(stdout, "wx+"); let stderrFd: number;
    try { stderrFd = fs.openSync(stderr, "wx+"); } catch (error) { fs.closeSync(stdoutFd); throw error; }
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { cwd: artifactDir, env: childEnv, windowsHide: true, shell: false,
      stdio: ["ignore", stdoutFd, stderrFd] }); } catch (error) { fs.closeSync(stdoutFd); fs.closeSync(stderrFd); throw error; }
    const startedAt = Date.now(); let settled = false, timedOut = false, overOutputLimit = false;
    let timer: ReturnType<typeof setTimeout>, hardTimer: ReturnType<typeof setTimeout>, watcher: ReturnType<typeof setInterval>;
    const finish = (code: number | null, signal: string | null, rootExited: boolean, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hardTimer); clearInterval(watcher);
      try {
        const bytesAtCompletion = fs.fstatSync(stdoutFd).size + fs.fstatSync(stderrFd).size;
        overOutputLimit ||= bytesAtCompletion > 2 * 1024 * 1024;
        const buffer = Buffer.alloc(16384), readFd = fs.openSync(stdout, "r"); let length: number;
        try { length = fs.readSync(readFd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(readFd); }
        fs.writeFileSync(path.join(artifactDir, `${tag}.receipt.json`), JSON.stringify({ tag, pid: child.pid ?? null, code, signal,
          rootExited, completionBasis: rootExited ? "root_process_exit" : "termination_unverified", captureMode: "durable_files",
          timedOut, overOutputLimit, bytesAtCompletion, durationMs: Date.now() - startedAt,
          caller: "codex-board-import-fixture", completedAt: new Date().toISOString() }), { flag: "wx" });
        if (error || timedOut || overOutputLimit || code === null || !accepted.includes(code)) {
          reject(error ?? new Error(`Fixture ${tag} failed; retained logs: ${artifactDir}`));
        } else resolve(buffer.subarray(0, length).toString("utf8"));
      } catch (captureError) { reject(captureError); }
      finally { for (const fd of [stdoutFd, stderrFd]) { try { fs.closeSync(fd); } catch { /* Already failed capture retained. */ } } }
    };
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    hardTimer = setTimeout(() => finish(null, null, false,
      new Error(`Fixture ${tag} failed to terminate; NativeJob custody required`)), timeoutMs + 2000);
    watcher = setInterval(() => { if (!settled && fs.fstatSync(stdoutFd).size + fs.fstatSync(stderrFd).size > 2 * 1024 * 1024) {
      overOutputLimit = true; child.kill(); } }, 100);
    child.once("error", error => finish(null, null, false, error));
    child.once("exit", (code, signal) => finish(code, signal, true));
  });
}
function createCleanup(run: NativeRun, artifactDir: string, dataDir: string, port: number,
  pgCtl: string, stage: { startRequested: boolean }) {
  let stopped = false;
  return async () => {
    if (stopped) return;
    const pidFile = path.join(dataDir, "postmaster.pid");
    if (fs.existsSync(pidFile)) {
      if (fs.lstatSync(pidFile).isSymbolicLink()) throw new Error("Fixture process identity file is a reparse point");
      const lines = fs.readFileSync(pidFile, "utf8").split(/\r?\n/);
      if (!/^[1-9]\d*$/.test(lines[0]) || normalize(path.resolve(lines[1])) !== normalize(dataDir)
        || Number(lines[3]) !== port) throw new Error("Fixture cluster identity mismatch; nothing stopped");
      fs.writeFileSync(path.join(artifactDir, "postmaster-identity.json"), JSON.stringify({ pid: Number(lines[0]), dataDir, port, observedAt: new Date().toISOString() }), { flag: "wx" });
      await run("stop", pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "15"], 18_000);
    }
    if (stage.startRequested) await run("shutdown-status", pgCtl, ["status", "-D", dataDir], 5000, [3]);
    if (fs.existsSync(pidFile)) throw new Error("Fixture shutdown not verified; data and logs retained");
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
  const stage = { startRequested: false };
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
    await run("start", binaries.pg_ctl, ["start", "-D", dataDir, "-w", "-t", "20", "-l", path.join(artifactDir, "postmaster.log"),
      "-o", `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c logging_collector=off`]);
    const connectionString = `postgres://paperclip_fixture:@127.0.0.1:${port}/board_import_fixture`;
    await migrateFixture(connectionString, `postgres://paperclip_fixture:@127.0.0.1:${port}/postgres`);
    console.info(`Native board import fixture retained at ${artifactDir}; loopback port ${port}`);
    return { connectionString, cleanup, artifactDir, dataDir, port };
  } catch (error) {
    try { await cleanup(); } catch (stopError) { throw new AggregateError([error, stopError], `Fixture failed and shutdown is unverified: ${artifactDir}`); }
    throw error;
  }
}
