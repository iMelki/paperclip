import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readUpdates, resolvePwshExecutable, runPwshGate } from "./run-pre-push-pwsh.mjs";

test("PowerShell selection rejects relative/wrong executable and converts MSYS drive paths", () => {
  assert.equal(resolvePwshExecutable("/c/Program Files/PowerShell/7/pwsh.exe", "win32", (file) => file), "C:/Program Files/PowerShell/7/pwsh.exe");
  assert.throws(() => resolvePwshExecutable("pwsh.exe", "win32", (file) => file), /absolute/);
  assert.throws(() => resolvePwshExecutable("C:/bad/cmd.exe", "win32", (file) => file), /unexpected/);
});

test("raw Git updates, remote argv, explicit PowerShell flags and natural status survive", async () => {
  for (const status of [0, 1, 23]) {
    const input = new PassThrough(); const bytes = Buffer.from("exact raw updates\r\n"); input.end(bytes);
    let observed;
    const actual = await runPwshGate("selected", "origin", "literal & remote", {
      input, resolveExecutable: () => process.execPath,
      run: async (executable, args, options) => { observed = { executable, args, options }; return { status }; },
    });
    assert.equal(actual, status); assert.deepEqual(observed.options.input, bytes);
    assert.deepEqual(observed.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    assert.deepEqual(observed.args.slice(-4), ["-RemoteName", "origin", "-RemoteLocation", "literal & remote"]);
  }
});

test("input overflow, missing EOF and transport errors fail closed", async () => {
  const overflow = new PassThrough(); overflow.end(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(() => readUpdates(overflow), /finite bound/);
  await assert.rejects(() => readUpdates(new PassThrough(), 5), /deadline/);
  const input = new PassThrough(); input.end("updates");
  await assert.rejects(() => runPwshGate("selected", "origin", "remote", {
    input, resolveExecutable: () => process.execPath,
    run: async () => ({ status: 0, error: new Error("sentinel durable output failure") }),
  }), /sentinel durable output failure/);
});
