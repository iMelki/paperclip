import fs from "node:fs";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@paperclipai/db", () => ({ applyPendingMigrations: vi.fn(), ensurePostgresDatabase: vi.fn() }));
import { createRunner, launchFixtureCommand, waitForFixtureReady, createCleanup } from "./helpers/board-import-fixture-db.js";

class FakeChild extends EventEmitter {
  pid: number | undefined = 434343; // Synthetic identity; never an OS process.
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  didClose = false;
}
const roots: string[] = [];
const children: FakeChild[] = [];
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "board-import-fixtures-pipes-")));
  roots.push(root);
  const artifactDir = path.join(root, "artifacts"), dataDir = path.join(artifactDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const child = new FakeChild(); children.push(child);
  mocks.spawn.mockReturnValue(child);
  return { child, artifactDir, dataDir, root, run: createRunner(root, artifactDir, dataDir, { PATH: "synthetic-only" }),
    service: (timeout = 180_000) => launchFixtureCommand(root, artifactDir, dataDir, { PATH: "synthetic-only" },
      "probe", "C:/synthetic/postgres.exe", ["-D", dataDir], timeout, [0], true),
    receipt: () => JSON.parse(fs.readFileSync(path.join(artifactDir, "probe.receipt.json"), "utf8")) };
}
async function closeChild(child: FakeChild, code: number | null = 0, emitExit = true) {
  const drains = [child.stdout, child.stderr].filter(stream => !stream.readableEnded)
    .map(stream => { const done = once(stream, "end"); stream.end(); return done; });
  await Promise.all(drains);
  if (emitExit) child.emit("exit", code, null);
  child.didClose = true;
  child.emit("close", code, null);
}
afterEach(async () => {
  for (const child of children.splice(0)) if (!child.didClose) await closeChild(child);
  vi.useRealTimers(); vi.restoreAllMocks(); mocks.spawn.mockReset();
  for (const root of roots.splice(0)) console.info(`Synthetic pipe fixture retained for review: ${root}`);
});

describe("existing board fixture descendant pipe custody", () => {
  it("uses hidden direct spawn, closed stdin and two actively drained durable pipes", async () => {
    const f = fixture();
    const result = f.run("probe", "C:/synthetic/unexecuted.exe", ["--version"]);
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("C:/synthetic/unexecuted.exe", ["--version"], {
      cwd: f.artifactDir, env: { PATH: "synthetic-only" }, windowsHide: true, shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    f.child.stdout.write("hello\n"); f.child.stderr.write("diagnostic\n");
    await closeChild(f.child);
    await expect(result).resolves.toBe("hello\n");
    expect(fs.readFileSync(path.join(f.artifactDir, "probe.stderr.log"), "utf8")).toBe("diagnostic\n");
    expect(f.receipt()).toMatchObject({ rootExited: true, streamsComplete: true, captureMatched: true,
      captureMode: "drained_pipes_to_durable_files", stdout: { seen: 6, stored: 6, dropped: 0 },
      stderr: { seen: 11, stored: 11, dropped: 0 } });
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("retains output after exit and does not resolve before both pipes close", async () => {
    const f = fixture(); let settled = false;
    const result = f.run("probe", "unexecuted", []).then(value => { settled = true; return value; });
    f.child.emit("exit", 0, null);
    await Promise.resolve(); expect(settled).toBe(false);
    f.child.stdout.write("late-output");
    await closeChild(f.child, 0, false);
    await expect(result).resolves.toBe("late-output");
    expect(f.receipt().stdout).toMatchObject({ seen: 11, stored: 11, dropped: 0 });
  });

  it("caps combined stored bytes, counts dropped output and stops only its child", async () => {
    const f = fixture();
    const result = f.run("probe", "unexecuted", []);
    const refused = expect(result).rejects.toThrow("output limit exceeded");
    f.child.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024)); f.child.stderr.emit("data", Buffer.from("x"));
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    await closeChild(f.child); await refused;
    expect(f.receipt()).toMatchObject({ overOutputLimit: true, bytesAtCompletion: 2 * 1024 * 1024,
      stderr: { seen: 1, stored: 0, dropped: 1 } });
  });

  it("preserves a pipe error and refuses even after a zero exit", async () => {
    const f = fixture(); const result = f.run("probe", "unexecuted", []);
    const refused = expect(result).rejects.toThrow("synthetic pipe error");
    f.child.stderr.emit("error", new Error("synthetic pipe error"));
    await closeChild(f.child); await refused;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.receipt().error).toBe("synthetic pipe error");
  });

  it("never treats a spawn error and close as verified root exit", async () => {
    const f = fixture(); f.child.pid = undefined;
    const result = f.run("probe", "unexecuted", []);
    const refused = expect(result).rejects.toThrow("synthetic spawn error");
    f.child.emit("error", new Error("synthetic spawn error"));
    await closeChild(f.child, null, false); await refused;
    expect(f.receipt()).toMatchObject({ pid: null, rootExited: false, completionBasis: "termination_unverified" });
  });

  it("bounds a child that never exits and records drain/termination as unverified", async () => {
    vi.useFakeTimers();
    const f = fixture(); const result = f.run("probe", "unexecuted", [], 10);
    const refused = expect(result).rejects.toThrow("verified exit and pipe drain");
    await vi.advanceTimersByTimeAsync(2011); await refused;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toMatchObject({ timedOut: true, rootExited: false, streamsComplete: false });
  });

  it("refuses close without drain evidence rather than reporting an empty successful capture", async () => {
    const f = fixture(); const result = f.run("probe", "unexecuted", []);
    const refused = expect(result).rejects.toThrow("Fixture probe failed");
    f.child.emit("exit", 0, null); f.child.emit("close", 0, null);
    await refused;
    expect(f.receipt()).toMatchObject({ rootExited: true, streamsComplete: false });
  });

  it("does not claim pipe-close completion when root exit is followed by retained handles", async () => {
    vi.useFakeTimers();
    const f = fixture(); const result = f.run("probe", "unexecuted", [], 10);
    const refused = expect(result).rejects.toThrow("verified exit and pipe drain");
    f.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2011); await refused;
    expect(f.receipt()).toMatchObject({ rootExited: true, closeObserved: false, streamsComplete: false,
      completionBasis: "root_exit_pipe_drain_unverified" });
  });

  it("preserves capture-write failure and counts unpersisted bytes", async () => {
    const f = fixture(); const result = f.run("probe", "unexecuted", []);
    const refused = expect(result).rejects.toThrow("synthetic disk failure");
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("synthetic disk failure"); });
    f.child.stdout.emit("data", Buffer.from("hello")); write.mockRestore();
    await closeChild(f.child); await refused;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toMatchObject({ error: "synthetic disk failure", stdout: { seen: 5, stored: 0, dropped: 5 } });
  });

  it("preserves the caller's explicit accepted status code after complete drain", async () => {
    const f = fixture(); const result = f.run("probe", "unexecuted", [], 1000, [3]);
    await closeChild(f.child, 3);
    await expect(result).resolves.toBe("");
    expect(f.receipt()).toMatchObject({ code: 3, rootExited: true, streamsComplete: true });
  });
});

function readyIdentity(f: ReturnType<typeof fixture>, pid = f.child.pid, port = 49217, status = "ready") {
  fs.writeFileSync(path.join(f.dataDir, "postmaster.pid"),
    [pid, f.dataDir, Math.floor(Date.now() / 1000), port, "", "127.0.0.1", "0", status, ""].join("\n"), { flag: "wx" });
}

describe("foreground fixture service lifetime", () => {
  it("readiness keeps both captured pipes and the owned server alive until explicit shutdown", async () => {
    const f = fixture(), service = f.service(); let completed = false;
    void service.completion.then(() => { completed = true; });
    readyIdentity(f); await waitForFixtureReady(service, f.dataDir, 49217);
    expect(completed).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.artifactDir, "probe.receipt.json"))).toBe(false);
    f.child.stderr.write("running-server-output");
    service.beginStop(); await closeChild(f.child); await service.completion;
    expect(f.receipt()).toMatchObject({ service: true, expectedStop: true, rootExited: true,
      closeObserved: true, streamsComplete: true, stderr: { stored: 21, dropped: 0 } });
  });

  it.each(["pid", "port", "directory"])("refuses ready status with the wrong %s identity", async kind => {
    const f = fixture(), service = f.service();
    readyIdentity(f, kind === "pid" ? 777777 : f.child.pid, kind === "port" ? 49218 : 49217);
    const testDir = kind === "directory" ? path.join(f.root, "wrong-data") : f.dataDir;
    if (kind === "directory") {
      fs.mkdirSync(testDir); fs.copyFileSync(path.join(f.dataDir, "postmaster.pid"), path.join(testDir, "postmaster.pid"));
    }
    await expect(waitForFixtureReady(service, testDir, 49217)).rejects.toThrow("identity mismatch");
    service.beginStop(); await closeChild(f.child); await service.completion;
  });

  it("does not confuse a partial startup identity with readiness and accepts its later ready line", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.service();
    fs.writeFileSync(path.join(f.dataDir, "postmaster.pid"), "434343\n", { flag: "wx" });
    const ready = waitForFixtureReady(service, f.dataDir, 49217, 500);
    fs.writeFileSync(path.join(f.dataDir, "postmaster.pid"),
      [f.child.pid, f.dataDir, Math.floor(Date.now() / 1000), 49217, "", "127.0.0.1", "0", "ready", ""].join("\n"));
    await vi.advanceTimersByTimeAsync(51); await ready;
    service.beginStop(); await closeChild(f.child); await service.completion;
  });

  it("bounds missing readiness without claiming that service capture is complete", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.service();
    const ready = expect(waitForFixtureReady(service, f.dataDir, 49217, 10)).rejects.toThrow("readiness deadline");
    await vi.advanceTimersByTimeAsync(51); await ready;
    expect(fs.existsSync(path.join(f.artifactDir, "probe.receipt.json"))).toBe(false);
    service.beginStop(); await closeChild(f.child); await service.completion;
  });

  it("refuses an unexpected service exit even when its code is zero", async () => {
    const f = fixture(), service = f.service(); await closeChild(f.child);
    await expect(service.completion).rejects.toThrow("before owned shutdown");
    await expect(waitForFixtureReady(service, f.dataDir, 49217)).rejects.toThrow("before owned shutdown");
    expect(f.receipt()).toMatchObject({ service: true, expectedStop: false, rootExited: true });
  });

  it("drains late service output after owned stop and root exit before recording final completion", async () => {
    const f = fixture(), service = f.service(); let completed = false;
    void service.completion.then(() => { completed = true; });
    service.beginStop(); f.child.emit("exit", 0, null); await Promise.resolve(); expect(completed).toBe(false);
    f.child.stderr.write("final-shutdown"); await closeChild(f.child, 0, false); await service.completion;
    expect(f.receipt()).toMatchObject({ completionBasis: "root_exit_and_pipe_close", stderr: { stored: 14, dropped: 0 } });
  });

  it("enforces a finite service lifetime and preserves unverified termination as failure", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.service(10);
    const failed = expect(service.completion).rejects.toThrow("verified exit and pipe drain");
    await vi.advanceTimersByTimeAsync(2011); await failed;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toMatchObject({ service: true, timedOut: true, rootExited: false, streamsComplete: false });
  });

  it("surfaces active service capture failure to readiness and retains the final failure receipt", async () => {
    const f = fixture(), service = f.service(); readyIdentity(f);
    f.child.stderr.emit("error", new Error("synthetic service capture error"));
    await expect(waitForFixtureReady(service, f.dataDir, 49217)).rejects.toThrow("service capture error");
    service.beginStop(); await closeChild(f.child);
    await expect(service.completion).rejects.toThrow("service capture error");
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });

  it("owned cleanup checks the exact PID, waits for service drains and verifies shutdown status", async () => {
    const f = fixture(), service = f.service(); readyIdentity(f);
    const exists = fs.existsSync.bind(fs); let removed = false;
    vi.spyOn(fs, "existsSync").mockImplementation(p => p === path.join(f.dataDir, "postmaster.pid") && removed ? false : exists(p));
    const run = vi.fn(async (tag: string) => {
      if (tag === "stop") { f.child.stderr.write("stopping"); await closeChild(f.child); removed = true; }
      return "";
    });
    const cleanup = createCleanup(run, f.artifactDir, f.dataDir, 49217, "unexecuted-pg_ctl", { startRequested: true, service });
    await cleanup(); await cleanup();
    expect(run.mock.calls.map(call => call[0])).toEqual(["stop", "shutdown-status"]);
    expect(f.receipt()).toMatchObject({ expectedStop: true, streamsComplete: true, closeObserved: true });
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("identity-mismatched cleanup never invokes pg_ctl stop for a foreign PID", async () => {
    const f = fixture(), service = f.service(); readyIdentity(f, 777777);
    f.child.kill.mockImplementation(() => { queueMicrotask(() => { void closeChild(f.child); }); return true; });
    const run = vi.fn(async (_tag: string) => "");
    const cleanup = createCleanup(run, f.artifactDir, f.dataDir, 49217, "unexecuted-pg_ctl", { startRequested: true, service });
    await expect(cleanup()).rejects.toThrow("owned shutdown or pipe drain unverified");
    expect(run.mock.calls.map(call => call[0])).toEqual(["shutdown-status"]);
    expect(f.child.kill).toHaveBeenCalledTimes(1); // Original direct handle only; never the substituted PID.
    expect(fs.existsSync(path.join(f.artifactDir, "postmaster-identity.json"))).toBe(false);
  });

  it("owned shutdown cannot report completion if its final pipe writers remain open", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.service();
    service.beginStop(); f.child.emit("exit", 0, null);
    const failed = expect(service.completion).rejects.toThrow("verified exit and pipe drain");
    await vi.advanceTimersByTimeAsync(12_001); await failed;
    expect(f.receipt()).toMatchObject({ expectedStop: true, rootExited: true, closeObserved: false,
      streamsComplete: false, completionBasis: "root_exit_pipe_drain_unverified" });
  });
  it("finishes the cumulative stop, non-draining service and status failure path inside the existing cleanup hook", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.service(); readyIdentity(f);
    const started = Date.now(); let settledAt: number | undefined;
    const run = vi.fn(async (tag: string, _executable: string, _args: string[], timeoutMs = 25_000, _accepted = [0]) => {
      await new Promise(resolve => setTimeout(resolve, timeoutMs + 2000)); // Actual runner deadline plus hard drain grace.
      if (tag === "stop") throw new Error("synthetic stop hard deadline");
      return "";
    });
    const cleanup = createCleanup(run, f.artifactDir, f.dataDir, 49217, "unexecuted-pg_ctl", { startRequested: true, service });
    const result = cleanup().catch(error => { settledAt = Date.now(); throw error; });
    const failed = expect(result).rejects.toThrow("owned shutdown or pipe drain unverified");
    await vi.advanceTimersByTimeAsync(40_000); await failed;
    expect(settledAt).toBeDefined();
    expect(settledAt! - started).toBeLessThanOrEqual(19_000);
    expect(settledAt! - started + 5000).toBeLessThan(30_000); // Actual consumers reserve client.end({ timeout:5 }).
    expect(run).toHaveBeenNthCalledWith(1, "stop", "unexecuted-pg_ctl",
      ["stop", "-D", f.dataDir, "-m", "fast", "-w", "-t", "5"], 8000);
    expect(run).toHaveBeenNthCalledWith(2, "shutdown-status", "unexecuted-pg_ctl",
      ["status", "-D", f.dataDir], 3000, [3]);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.receipt()).toMatchObject({ timedOut: true, rootExited: false, streamsComplete: false });
  });

});
