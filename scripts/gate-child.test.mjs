import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runGateChild } from "./gate-child.mjs";

// Simulated transport fixtures only. They are not native Job/cleanup receipts.
function fixture(action = (child) => child.finish(0)) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let finished = false;
  child.finish = (status, signal = null) => {
    if (finished) return;
    finished = true;
    child.stdout.end(); child.stderr.end();
    child.emit("close", status, signal);
  };
  child.kill = () => { child.finish(null, "SIGTERM"); return true; };
  const observed = {};
  const spawnFn = (command, args, options) => {
    Object.assign(observed, { command, args, options });
    setImmediate(() => action(child));
    return child;
  };
  return { child, spawnFn, observed };
}

function sink({ fail = false, delayed = false } = {}) {
  const chunks = [];
  const stream = new Writable({ write(chunk, _encoding, done) {
    const finish = () => { chunks.push(Buffer.from(chunk)); done(fail ? new Error("sentinel sink failure") : null); };
    if (delayed) setImmediate(finish); else finish();
  } });
  return { stream, bytes: () => Buffer.concat(chunks) };
}

test("natural statuses and literal argv retain explicit windowless pipe transport", async () => {
  for (const status of [0, 1, 2, 23]) {
    const fake = fixture((child) => child.finish(status));
    const result = await runGateChild(process.execPath, ["a & hostile; $(literal)"], { spawnFn: fake.spawnFn });
    assert.equal(result.status, status); assert.equal(result.error, null);
    assert.equal(fake.observed.command, process.execPath);
    assert.deepEqual(fake.observed.args, ["a & hostile; $(literal)"]);
    assert.deepEqual(fake.observed.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(fake.observed.options.windowsHide, true);
    assert.equal(fake.observed.options.shell, false); assert.equal(fake.observed.options.detached, false);
  }
});

test("both pipes drain under backpressure before a successful result", async () => {
  const out = sink({ delayed: true }); const err = sink({ delayed: true });
  const fake = fixture((child) => {
    child.stdout.write(Buffer.alloc(256 * 1024, 65));
    child.stderr.write(Buffer.alloc(256 * 1024, 66));
    child.finish(0);
  });
  const result = await runGateChild(process.execPath, [], { spawnFn: fake.spawnFn, output: out.stream, errorOutput: err.stream });
  assert.equal(result.error, null); assert.equal(result.status, 0);
  assert.equal(out.bytes().length, 256 * 1024); assert.equal(err.bytes().length, 256 * 1024);
});

test("sink and source failures refuse success even when natural child status is zero", async () => {
  const failedSink = sink({ fail: true });
  const fake = fixture((child) => { child.stdout.write("retained failure evidence"); child.finish(0); });
  const result = await runGateChild(process.execPath, [], { spawnFn: fake.spawnFn, output: failedSink.stream });
  assert.match(result.error.message, /sentinel sink failure/);
  const broken = fixture((child) => { child.stderr.destroy(new Error("sentinel source failure")); child.finish(0); });
  const sourceResult = await runGateChild(process.execPath, [], { spawnFn: broken.spawnFn });
  assert.match(sourceResult.error.message, /sentinel source failure/);
});

test("spawn errors, signals, finite captures and deadlines never become success", async () => {
  const badSpawn = await runGateChild(process.execPath, [], { spawnFn: () => { throw new Error("sentinel spawn failure"); } });
  assert.match(badSpawn.error.message, /sentinel spawn failure/);
  const signalled = fixture((child) => child.finish(null, "SIGTERM"));
  const signalResult = await runGateChild(process.execPath, [], { spawnFn: signalled.spawnFn });
  assert.equal(signalResult.status, null); assert.equal(signalResult.signal, "SIGTERM");
  const overflow = fixture((child) => { child.stdout.write("too much"); child.finish(0); });
  const overflowResult = await runGateChild(process.execPath, [], { spawnFn: overflow.spawnFn, capture: true, maxCaptureBytes: 2 });
  assert.match(overflowResult.error.message, /finite bound/);
  const hanging = fixture(() => {});
  const timed = await runGateChild(process.execPath, [], { spawnFn: hanging.spawnFn, timeoutMs: 5, cleanupTimeoutMs: 50 });
  assert.match(timed.error.message, /deadline/); assert.equal(timed.cleanupIncomplete, false);
});

test("finite protocol input is closed and oversized input prevents a spawn", async () => {
  const fake = fixture((child) => child.finish(0));
  const bytes = Buffer.from("refs/heads/topic exact-object refs/heads/topic previous-object\n");
  const result = await runGateChild(process.execPath, [], { spawnFn: fake.spawnFn, input: bytes });
  assert.equal(result.status, 0); assert.equal(fake.child.stdin.writableEnded, true);
  assert.deepEqual(fake.child.stdin.read(), bytes);
  assert.deepEqual(fake.observed.options.stdio, ["pipe", "pipe", "pipe"]);
  let spawned = false;
  const overflow = await runGateChild(process.execPath, [], { input: Buffer.alloc(1024 * 1024 + 1), spawnFn: () => { spawned = true; } });
  assert.equal(spawned, false); assert.match(overflow.error.message, /oversized/);
});
