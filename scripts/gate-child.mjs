import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// The caller's supervisor owns the process tree and durable stdout/stderr sinks.
// This transport never detaches or inherits console handles. Its local bound is
// additional to (and cannot extend) the supervisor's whole-run deadline.
export const GATE_CHILD_TIMEOUT_MS = 30 * 60_000;
const CLEANUP_TIMEOUT_MS = 15_000;

export function resolveNativeExecutable(command, {
  env = process.env, platform = process.platform,
  realpath = realpathSync, isFile = (file) => statSync(file).isFile(),
} = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  if (typeof command !== "string" || !command || /[\0\r\n]/u.test(command)) {
    throw new Error("an executable name or absolute path is required");
  }
  if (!paths.isAbsolute(command) && /[\\/]/u.test(command)) throw new Error("relative executable paths are not allowed");
  const candidates = paths.isAbsolute(command)
    ? [command]
    : (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")
      .filter((entry) => entry && paths.isAbsolute(entry))
      .flatMap((entry) => platform === "win32" && !paths.extname(command)
        ? [paths.join(entry, `${command}.exe`)] : [paths.join(entry, command)]);
  for (const candidate of candidates) {
    try {
      const resolved = realpath(candidate);
      if (!isFile(resolved)) continue;
      if (platform === "win32" && paths.extname(resolved).toLowerCase() !== ".exe") continue;
      if (platform !== "win32") accessSync(resolved, constants.X_OK);
      return resolved;
    } catch { /* try the next explicit PATH entry */ }
  }
  throw new Error(`could not resolve a native executable for ${paths.basename(command)}`);
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded) {
      reject(new Error("gate output sink is unavailable"));
      return;
    }
    const failed = (error) => { stream.off("error", failed); reject(error); };
    stream.once("error", failed);
    try {
      stream.write(chunk, (error) => {
        // Writable emits 'error' after invoking an errored write callback.
        // Keep its one-shot listener until that event has been consumed.
        if (error) reject(error);
        else { stream.off("error", failed); resolve(); }
      });
    } catch (error) { failed(error); }
  });
}

/** Returns natural status separately from spawn/transport/deadline failures. */
export async function runGateChild(executable, args, {
  cwd = process.cwd(), env = process.env, input = null,
  output = process.stdout, errorOutput = process.stderr,
  capture = false, maxCaptureBytes = 128 * 1024,
  timeoutMs = GATE_CHILD_TIMEOUT_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  spawnFn = spawn,
} = {}) {
  if (!path.isAbsolute(executable) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return { status: null, signal: null, error: new Error("gate child requires an absolute executable and literal argv") };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATE_CHILD_TIMEOUT_MS ||
      !Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0 || cleanupTimeoutMs > CLEANUP_TIMEOUT_MS ||
      !Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes <= 0 || maxCaptureBytes > 128 * 1024) {
    return { status: null, signal: null, error: new Error("invalid finite gate child limits") };
  }
  if (input !== null && ((!Buffer.isBuffer(input) && typeof input !== "string") || Buffer.byteLength(input) > 1024 * 1024)) {
    return { status: null, signal: null, error: new Error("invalid or oversized finite gate input") };
  }
  let child;
  try {
    child = spawnFn(executable, args, {
      cwd, env, windowsHide: true, shell: false, detached: false,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) { return { status: null, signal: null, error }; }

  let failure = null;
  let status = null;
  let signal = null;
  let cleanupIncomplete = false;
  let captureBytes = 0;
  const captured = { stdout: [], stderr: [] };
  let finishFailure;
  const failed = new Promise((resolve) => { finishFailure = resolve; });
  const fail = (error) => {
    if (failure) return;
    failure = error;
    // Only the owned direct child is signalled here. The caller's Job/supervisor
    // must prove descendant termination; this is not a PID-only tree reaper.
    try { child.kill(); } catch { /* original failure is authoritative */ }
    finishFailure();
  };
  child.on("error", fail);
  const closed = new Promise((resolve) => child.once("close", (code, childSignal) => {
    status = code; signal = childSignal; resolve();
  }));
  async function forward(source, destination, name) {
    try {
      if (!source) throw new Error(`gate ${name} pipe is unavailable`);
      for await (const chunk of source) {
        if (capture) {
          captureBytes += chunk.length;
          if (captureBytes > maxCaptureBytes) throw new Error("gate captured output exceeded its finite bound");
          captured[name].push(Buffer.from(chunk));
        }
        // Capturing for a version assertion must not hide either stream from
        // the supervisor's durable sinks while that assertion is running.
        await writeChunk(destination, chunk);
      }
    } catch (error) { fail(error); }
  }
  // Start both drains before sending protocol input or waiting for termination.
  const stdoutDone = forward(child.stdout, output, "stdout");
  const stderrDone = forward(child.stderr, errorOutput, "stderr");
  if (input !== null) {
    if (!child.stdin) fail(new Error("gate stdin pipe is unavailable"));
    else {
      child.stdin.on("error", fail);
      child.stdin.end(input);
    }
  }
  const timer = setTimeout(() => fail(new Error("gate child deadline exceeded")), timeoutMs);
  const done = Promise.all([closed, stdoutDone, stderrDone]);
  await Promise.race([done, failed]);
  if (failure) {
    let cleanupTimer;
    const cleaned = await Promise.race([
      done.then(() => true),
      new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(false), cleanupTimeoutMs); }),
    ]);
    clearTimeout(cleanupTimer);
    if (!cleaned) {
      cleanupIncomplete = true;
      // Release only this transport's handles; report failure, never detach the
      // child or claim that closing pipes proves owned-tree cleanup.
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
  }
  clearTimeout(timer);
  return {
    status, signal, error: failure, cleanupIncomplete,
    stdout: Buffer.concat(captured.stdout).toString("utf8"),
    stderr: Buffer.concat(captured.stderr).toString("utf8"),
  };
}
