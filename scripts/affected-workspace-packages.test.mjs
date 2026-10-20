import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { affectedPayload, listWorkspacePackages, runCaptured } from "./affected-workspace-packages.mjs";

function fixture(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-membership-"));
  let completed = false;
  try {
    const pkg = path.join(root, "node_modules/pnpm"); mkdirSync(path.join(pkg, "bin"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }));
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version: "9.15.4", bin: { pnpm: "bin/pnpm.cjs" } }));
    const cli = path.join(pkg, "bin/pnpm.cjs");
    writeFileSync(cli, [
      'const fs = require("node:fs");',
      'if (process.argv.slice(2).join(" ") !== "list -r --depth -1 --json") throw new Error("membership argv changed");',
      'fs.appendFileSync(process.env.MEMBERSHIP_CALL_LOG, JSON.stringify(process.argv) + "\\n");',
      'process.stderr.write("membership-fixture-stderr\\n");',
      'process.stdout.write(process.env.MEMBERSHIP_JSON);',
      'process.exitCode = Number(process.env.MEMBERSHIP_EXIT || 0);',
    ].join("\n"));
    const env = { ...process.env, MEMBERSHIP_CALL_LOG: path.join(root, "calls.log"), MEMBERSHIP_JSON: JSON.stringify([
      { name: "root", path: root }, { name: "parent", path: path.join(root, "packages/adapters") },
      { name: "nested", path: path.join(root, "packages/adapters/codex-local") },
      { name: "outside", path: path.join(root, "../outside") },
    ]) };
    const value = body({ root, pkg, cli, env, logPrefix: path.join(root, "capture") }); completed = true; return value;
  } finally {
    if (completed) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ diagnostic: "failed membership fixture preserved", root }));
  }
}

test("real exact-node pnpm query preserves authoritative membership, exclusions and longest prefix", () => fixture(({root, cli, env, logPrefix}) => {
  let observed;
  const packages = listWorkspacePackages(root, { env, logPrefix, spawn: (executable, args, options) => {
    observed = { executable, args, options }; return spawnSync(executable, args, options);
  } });
  assert.equal(observed.executable, process.execPath);
  assert.deepEqual(observed.args, [cli, "list", "-r", "--depth", "-1", "--json"]);
  assert.deepEqual(observed.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(observed.options.windowsHide, true); assert.equal(observed.options.shell, false);
  assert.equal(observed.options.timeout, 120000); assert.equal(observed.options.maxBuffer, 131072);
  const result = affectedPayload(["packages/adapters/codex-local/a.ts", "excluded-smoke/a.ts", "doc/a.md"], packages);
  assert.deepEqual(result.packages, ["nested"]);
  assert.deepEqual(result.unmatchedFiles, ["excluded-smoke/a.ts", "doc/a.md"]);
  assert.match(readFileSync(logPrefix + ".stdout.log", "utf8"), /nested/);
  assert.match(readFileSync(logPrefix + ".stderr.log", "utf8"), /membership-fixture-stderr/);
}));

test("actual pnpm query failure rejects valid-looking JSON and restored query passes", () => fixture(({root, env, logPrefix}) => {
  assert.throws(() => listWorkspacePackages(root, { env: { ...env, MEMBERSHIP_EXIT: "23" }, logPrefix }), /exit 23/);
  assert.equal(listWorkspacePackages(root, { env, logPrefix }).length, 2);
}));

test("wrong installed pnpm version refuses before any query child", () => fixture(({root, pkg, env}) => {
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version: "10.25.0", bin: { pnpm: "bin/pnpm.cjs" } }));
  let births = 0;
  assert.throws(() => listWorkspacePackages(root, { env: { ...env, PATH: "", npm_execpath: "" }, spawn: () => { births++; throw new Error("unexpected child"); } }), /not installed/);
  assert.equal(births, 0);
}));

test("malformed membership refuses and root build input still forces full sweep", () => fixture(({root, env, logPrefix}) => {
  assert.throws(() => listWorkspacePackages(root, { env: { ...env, MEMBERSHIP_JSON: "{}" }, logPrefix }), /not return an array/);
  assert.throws(() => listWorkspacePackages(root, { env: { ...env, MEMBERSHIP_JSON: "[" }, logPrefix }), /parse pnpm list/);
  assert.deepEqual(affectedPayload(["package.json"], [], "package.json"), { fullSweep: true, fullSweepReason: "root build input changed: package.json", changedFileCount: 1, packages: [], unmatchedFiles: [] });
}));

test("native query deadline/transport failure refuses success-shaped stdout", () => {
  assert.throws(() => runCaptured(process.execPath, [], { spawn: () => ({ status: 0, stdout: "[]", stderr: "", error: new Error("ETIMEDOUT") }) }), /ETIMEDOUT/);
});
