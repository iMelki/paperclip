#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { runGateChild } from "./gate-child.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_UPDATE_BYTES = 1024 * 1024;

export function resolvePwshExecutable(selected, platform = process.platform, realpath = realpathSync) {
  if (typeof selected !== "string" || !selected || /[\r\n\0]/u.test(selected)) {
    throw new Error("pre-push requires an exact PowerShell executable path");
  }
  const native = platform === "win32"
    ? selected.replace(/^\/([a-zA-Z])\//u, (_, drive) => `${drive.toUpperCase()}:/`)
    : selected;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(native)) throw new Error("PowerShell executable must be absolute");
  const executable = realpath(native);
  if (paths.basename(executable).toLowerCase() !== (platform === "win32" ? "pwsh.exe" : "pwsh")) {
    throw new Error("unexpected PowerShell executable");
  }
  return executable;
}

export async function readUpdates(input = process.stdin, timeoutMs = 10_000) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off("data", data); input.off("end", end); input.off("error", failed); input.off("close", closed);
      if (error) { input.destroy(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_UPDATE_BYTES) finish(new Error("pre-push update input exceeds finite bound"));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const failed = (error) => finish(error);
    const closed = () => { if (!input.readableEnded) finish(new Error("pre-push input closed before EOF")); };
    const timer = setTimeout(() => finish(new Error("pre-push update input deadline exceeded")), timeoutMs);
    input.on("data", data); input.once("end", end); input.once("error", failed); input.once("close", closed);
  });
}

export async function runPwshGate(selected, remoteName, remoteLocation, {
  input = process.stdin, output = process.stdout, errorOutput = process.stderr,
  run = runGateChild, resolveExecutable = resolvePwshExecutable,
} = {}) {
  const executable = resolveExecutable(selected);
  const updates = await readUpdates(input);
  const result = await run(executable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "scripts", "pre-push-check.ps1"),
    "-RemoteName", remoteName ?? "", "-RemoteLocation", remoteLocation ?? "",
  ], { cwd: root, input: updates, output, errorOutput });
  if (result.error) throw result.error;
  return result.status ?? 2;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = await runPwshGate(...process.argv.slice(2)); }
  catch (error) { console.error(`pre-push PowerShell launch failed: ${error.message}`); process.exitCode = 2; }
}
