import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  stdin: "",
  stdinEnded: false,
  spawnError: false,
}));

vi.mock("./command-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./command-path.js")>()),
  resolveCommandPath: vi.fn(async (command: string) => command),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    fixture.calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 770001;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin.on("data", (chunk) => { fixture.stdin += chunk.toString(); });
    const endInput = child.stdin.end;
    child.stdin.end = (function (this: PassThrough, ...input: unknown[]) {
      fixture.stdinEnded = true;
      return Reflect.apply(endInput, this, input);
    }) as typeof child.stdin.end;
    const complete = () => {
      child.stdout.write("captured output");
      child.stderr.write("captured diagnostic");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    };
    if (fixture.spawnError) queueMicrotask(() => child.emit("error", new Error("fixture spawn failure")));
    else if ((options.stdio as string[])[0] === "pipe") child.stdin.once("finish", complete);
    else queueMicrotask(complete);
    return child;
  },
}));

import { runChildProcess, runningProcesses } from "./server-utils.js";

afterEach(() => {
  fixture.calls.length = 0;
  fixture.stdin = "";
  fixture.stdinEnded = false;
  fixture.spawnError = false;
  runningProcesses.clear();
});

describe("runChildProcess windowless launch contract", () => {
  it("suppresses the console and captures both streams without inherited stdio", async () => {
    const logs: Array<[string, string]> = [];
    const result = await runChildProcess("windowless-no-input", "C:/fixture/agent.exe", [], {
      cwd: "C:/fixture",
      env: {},
      timeoutSec: 1,
      graceSec: 1,
      onLog: async (stream, chunk) => { logs.push([stream, chunk]); },
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].options).toMatchObject({
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "captured output", stderr: "captured diagnostic" });
    expect(logs).toEqual([["stdout", "captured output"], ["stderr", "captured diagnostic"]]);
    expect(runningProcesses.has("windowless-no-input")).toBe(false);
  });

  it("writes the prompt through a pipe and closes it while retaining console suppression", async () => {
    await runChildProcess("windowless-with-input", "C:/fixture/agent.exe", ["exec"], {
      cwd: "C:/fixture",
      env: {},
      timeoutSec: 1,
      graceSec: 1,
      stdin: "bounded prompt\n",
      onLog: async () => {},
    });
    expect(fixture.calls[0].options).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(fixture.stdin).toBe("bounded prompt\n");
    expect(fixture.stdinEnded).toBe(true);
  });

  it("reports spawn failure and clears the owned run entry", async () => {
    fixture.spawnError = true;
    await expect(runChildProcess("windowless-spawn-failure", "C:/fixture/agent.exe", [], {
      cwd: "C:/fixture",
      env: {},
      timeoutSec: 1,
      graceSec: 1,
      onLog: async () => {},
    })).rejects.toThrow("fixture spawn failure");
    expect(fixture.calls[0].options.windowsHide).toBe(true);
    expect(runningProcesses.has("windowless-spawn-failure")).toBe(false);
  });
});
