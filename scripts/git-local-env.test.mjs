import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitLocalEnvironmentVariableNames, sanitizeGitLocalEnvironment } from "./git-local-env.mjs";

test("all discovered local names are removed while unrelated credential names stay intact", () => {
  let launch;
  const names = resolveGitLocalEnvironmentVariableNames({
    gitExecutable: process.execPath,
    spawn: (command, args, options) => { launch = { command, args, options }; return { status: 0, stdout: "GIT_DIR\nGIT_WORK_TREE\nGIT_INDEX_FILE\nGIT_COMMON_DIR\n" }; },
  });
  assert.deepEqual(sanitizeGitLocalEnvironment({ GIT_DIR: "a", GIT_WORK_TREE: "b", GIT_INDEX_FILE: "c", GIT_COMMON_DIR: "d", GITHUB_TOKEN: "fixture-only" }, names), { GITHUB_TOKEN: "fixture-only" });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(launch.options.windowsHide, true); assert.equal(launch.options.shell, false);
  assert.equal(launch.options.timeout, 120_000); assert.equal(launch.options.maxBuffer, 128 * 1024);
});

test("discovery timeout, failed exit and missing output status are hard failures", () => {
  for (const result of [{ error: new Error("sentinel timeout") }, { status: 128 }, { status: null, signal: "SIGTERM" }]) {
    assert.throws(() => resolveGitLocalEnvironmentVariableNames({ gitExecutable: process.execPath, spawn: () => result }), /Failed to enumerate/);
  }
});
