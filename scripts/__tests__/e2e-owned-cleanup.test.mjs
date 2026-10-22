// Regression tests for scripts/ci/e2e-owned-cleanup.sh, the e2e cleanup used by
// pr.yml (e2e_shards) and e2e.yml. The cleanup must only kill processes this
// job started and only delete the one home dir this job created.
//
// E2E_CLEANUP_IMPL=legacy runs the same tests against the d07bd93d inline
// cleanup (fixtures/e2e-cleanup-legacy-d07bd93d.sh, sandboxed so it can only
// signal PIDs these tests spawned and only delete inside the fixture root).
// Every test below except the last fails in that mode; that is the fail-first
// proof. Linux only: it reads /proc.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "ci", "e2e-owned-cleanup.sh");
const legacyScript = path.join(repoRoot, "scripts", "__tests__", "fixtures", "e2e-cleanup-legacy-d07bd93d.sh");
const IMPL = process.env.E2E_CLEANUP_IMPL === "legacy" ? "legacy" : "owned";
const RUN = { id: "4242", attempt: "1", job: "e2e_shards", suffix: "0" };
const OWNED_NAME = `paperclip-e2e-home-${RUN.id}-${RUN.attempt}-${RUN.job}-${RUN.suffix}`;
const skip = process.platform !== "linux" ? "needs /proc (Linux)" : false;

function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  } catch {
    return null;
  }
}

function isAlive(proc) {
  const now = startTime(proc.pid);
  if (now === null || now !== proc.start) return false;
  // A zombie still has /proc/<pid>/stat but has been killed.
  const stat = readFileSync(`/proc/${proc.pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(") ") + 2)[0] !== "Z";
}

async function waitFor(check, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function createFixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paperclip-e2e-cleanup-test-")));
  const runnerTemp = path.join(root, "runner-temp");
  const systemTmp = path.join(root, "system-tmp");
  mkdirSync(runnerTemp);
  mkdirSync(systemTmp);
  const env = { ...process.env };
  delete env.PAPERCLIP_E2E_OWNER_TOKEN;
  delete env.TMPDIR;
  Object.assign(env, {
    RUNNER_TEMP: runnerTemp,
    GITHUB_RUN_ID: RUN.id,
    GITHUB_RUN_ATTEMPT: RUN.attempt,
    GITHUB_JOB: RUN.job,
    PAPERCLIP_E2E_OWNER_SUFFIX: RUN.suffix,
    PAPERCLIP_E2E_CLEANUP_GRACE_SECONDS: "2",
    LEGACY_PORT: "1",
    LEGACY_SYSTEM_TMP: systemTmp,
    SANDBOX_ROOT: root,
    SANDBOX_LOG: path.join(root, "sandbox.log"),
  });
  const spawned = [];
  const children = [];
  t.after(() => {
    // Kill only the exact processes this test spawned, and only while the PID
    // still has the start time recorded at spawn.
    for (const proc of spawned) {
      if (startTime(proc.pid) === proc.start) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {}
      }
    }
    for (const child of children) child.unref();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runnerTemp, systemTmp, env, spawned, children, ownedDir: path.join(runnerTemp, OWNED_NAME) };
}

function track(fixture, pid) {
  const proc = { pid, start: startTime(pid) };
  assert.ok(proc.start, `pid ${pid} has a start time`);
  fixture.spawned.push(proc);
  return proc;
}

// A same-user process that is not this job's, started on its own session.
function spawnForeign(fixture, code, args = [], options = {}) {
  const child = spawn(process.execPath, ["-e", code, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, ...(options.env ?? {}) },
  });
  fixture.children.push(child);
  return { child, proc: track(fixture, child.pid) };
}

function runScript(fixture, args) {
  const result = spawnSync(script, args, { env: fixture.env, encoding: "utf8" });
  return result;
}

function prepare(fixture) {
  if (IMPL === "legacy") {
    mkdirSync(fixture.ownedDir);
    return fixture.ownedDir;
  }
  const result = runScript(fixture, ["prepare"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fixture.ownedDir);
  return fixture.ownedDir;
}

// Runs a short owned command so a session record exists, as after a normal run.
function runOwnedQuick(fixture) {
  if (IMPL === "legacy") return;
  const result = runScript(fixture, ["run", "--", process.execPath, "-e", "0"]);
  assert.equal(result.status, 0, result.stderr);
}

function cleanup(fixture) {
  const result =
    IMPL === "legacy"
      ? spawnSync("bash", [legacyScript], {
          env: { ...fixture.env, SANDBOX_KILLABLE: fixture.spawned.map((p) => p.pid).join(" ") },
          encoding: "utf8",
        })
      : runScript(fixture, ["cleanup"]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const IDLE = "setInterval(() => {}, 1e9)";

test("an unrelated same-user process matching the onboard pattern survives", { skip }, async (t) => {
  const fixture = createFixture(t);
  prepare(fixture);
  runOwnedQuick(fixture);
  const { proc } = spawnForeign(fixture, IDLE, ["paperclipai", "onboard", "--yes", "--run"]);
  const homeLike = spawnForeign(fixture, IDLE, [path.join(fixture.systemTmp, "paperclip-e2e-home-foreign")]);
  cleanup(fixture);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(isAlive(proc), "foreign onboard process must not be killed");
  assert.ok(isAlive(homeLike.proc), "foreign process using another e2e home must not be killed");
});

test("a foreign listener on the e2e port survives", { skip }, async (t) => {
  const fixture = createFixture(t);
  prepare(fixture);
  runOwnedQuick(fixture);
  const { child, proc } = spawnForeign(
    fixture,
    "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); })",
  );
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const port = await waitFor(() => out.trim(), "listener port");
  child.stdout.destroy();
  // The legacy logic hard-codes 3199; the fixture uses this free port instead
  // so the test never collides with a real e2e server on a shared runner.
  fixture.env.LEGACY_PORT = port;
  cleanup(fixture);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(isAlive(proc), "foreign listener must not be killed");
});

test("foreign temp homes in RUNNER_TEMP and the /tmp stand-in survive, only the owned dir is deleted", { skip }, async (t) => {
  const fixture = createFixture(t);
  const owned = prepare(fixture);
  runOwnedQuick(fixture);
  writeFileSync(path.join(owned, "data"), "owned");
  const foreign = [
    // Another run, another attempt, another shard and a mkdtemp-style home.
    path.join(fixture.runnerTemp, "paperclip-e2e-home-9999-1-e2e_shards-0"),
    path.join(fixture.runnerTemp, `paperclip-e2e-home-${RUN.id}-2-${RUN.job}-${RUN.suffix}`),
    path.join(fixture.runnerTemp, `paperclip-e2e-home-${RUN.id}-${RUN.attempt}-${RUN.job}-1`),
    path.join(fixture.runnerTemp, "paperclip-e2e-home-AbC123"),
    // Stands in for /tmp. The test never writes a real /tmp/paperclip-e2e-home-*,
    // which a concurrent job still on the d07bd93d cleanup would delete.
    path.join(fixture.systemTmp, "paperclip-e2e-home-XyZ789"),
  ];
  for (const dir of foreign) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "data"), "foreign");
  }
  cleanup(fixture);
  for (const dir of foreign) {
    assert.ok(existsSync(path.join(dir, "data")), `${dir} must survive`);
  }
  assert.equal(existsSync(owned), false, "the owned dir is deleted");
});

test("a reused PID (same PID, different start time) is not killed", { skip }, async (t) => {
  const fixture = createFixture(t);
  const owned = prepare(fixture);
  // A same-user process now holds the recorded leader PID, matches the onboard
  // pattern, and leads its own session with a child in it. The record says the
  // leader PID started earlier, so this PID was reused.
  const { child, proc } = spawnForeign(
    fixture,
    `const c = require('node:child_process').spawn(process.execPath, ['-e', '${IDLE}'], { stdio: 'ignore' }); console.log(c.pid); ${IDLE}`,
    ["paperclipai", "onboard", "--yes", "--run"],
  );
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const memberPid = Number(await waitFor(() => out.trim(), "session member pid"));
  child.stdout.destroy();
  const member = track(fixture, memberPid);
  writeFileSync(path.join(owned, ".paperclip-e2e-session"), `${proc.pid} ${Number(proc.start) - 1}\n`);
  cleanup(fixture);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(isAlive(proc), "a process on a reused PID must not be killed");
  assert.ok(isAlive(member), "members of a reused PID's session must not be killed");
});

test("owned cleanup kills the processes this job started and deletes its dir", { skip }, async (t) => {
  const fixture = createFixture(t);
  const owned = prepare(fixture);
  const pidsFile = path.join(fixture.root, "owned-pids.json");
  // Like Playwright: the run spawns a detached server (its own session, still
  // carrying the run's environment) that ignores SIGTERM, plus a child in the
  // run's session with a scrubbed environment, and writes a home via mkdtemp.
  const ownedCode = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const server = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); ${IDLE}", 'paperclipai', 'onboard', '--yes', '--run'], { detached: true, stdio: 'ignore' });
    const env = { PATH: process.env.PATH };
    const helper = spawn(process.execPath, ['-e', '${IDLE}'], { env, stdio: 'ignore' });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-e2e-home-'));
    fs.writeFileSync(process.env.PIDS_FILE, JSON.stringify({ leader: process.pid, server: server.pid, helper: helper.pid, home }));
    ${IDLE}`;
  const command = [process.execPath, "-e", ownedCode];
  const env = { ...fixture.env, PIDS_FILE: pidsFile };
  const runner =
    IMPL === "legacy"
      ? spawn(command[0], command.slice(1), { env: { ...env, TMPDIR: owned }, stdio: "ignore" })
      : spawn(script, ["run", "--", ...command], { env, stdio: "ignore" });
  fixture.children.push(runner);
  track(fixture, runner.pid);
  const pids = await waitFor(() => existsSync(pidsFile) && JSON.parse(readFileSync(pidsFile, "utf8")), "owned pids");
  const procs = { leader: track(fixture, pids.leader), server: track(fixture, pids.server), helper: track(fixture, pids.helper) };
  assert.ok(pids.home.startsWith(owned + path.sep), `the run's TMPDIR is the owned dir (got ${pids.home})`);
  const runnerExit = new Promise((resolve) => runner.on("exit", resolve));
  cleanup(fixture);
  await runnerExit;
  await waitFor(() => Object.values(procs).every((p) => !isAlive(p)), "owned processes to exit", 5_000).catch(() => {});
  for (const [name, proc] of Object.entries(procs)) {
    assert.equal(isAlive(proc), false, `owned ${name} must be killed`);
  }
  assert.equal(existsSync(owned), false, "the owned dir is deleted");
});

test("owned cleanup refuses a dir without this run's identity marker", { skip: skip || (IMPL === "legacy" && "owned-only guard") }, async (t) => {
  const fixture = createFixture(t);
  mkdirSync(fixture.ownedDir);
  writeFileSync(path.join(fixture.ownedDir, ".paperclip-e2e-owner"), "run_id=1\nrun_attempt=1\njob=other\nsuffix=\n");
  cleanup(fixture);
  assert.ok(existsSync(fixture.ownedDir), "a dir with another run's marker must survive");
  const outside = path.join(fixture.root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "data"), "x");
  rmSync(fixture.ownedDir, { recursive: true });
  spawnSync("ln", ["-s", outside, fixture.ownedDir]);
  cleanup(fixture);
  assert.ok(existsSync(path.join(outside, "data")), "a symlinked dir must not be followed");
});
