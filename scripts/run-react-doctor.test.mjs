import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./run-react-doctor.js", import.meta.url), "utf8");
const hook = readFileSync(new URL("../.husky/pre-commit", import.meta.url), "utf8");

test("uses only the pinned local analyzer boundary", () => {
  assert.doesNotMatch(source, /npx|react-doctor@latest|shell:\s*true/);
  assert.match(source, /process\.execPath/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /REACT_DOCTOR_NO_CACHE/);
  assert.match(source, /NODE_DISABLE_COMPILE_CACHE/);
  assert.match(source, /paperclip\.react-doctor-receipt\.v1/);
});

test("the hook stops when its first phase fails", () => {
  assert.match(hook, /set -eu/);
  assert.match(hook, /pre-commit-check\.ps1/);
  assert.match(hook, /run-react-doctor\.js/);
  assert.match(hook, /react_doctor_status/);
  assert.match(hook, /disabled: the exact local dependency is not pinned/);
});

test("a missing pinned package fails closed with a receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-react-doctor-missing-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "run-react-doctor.js"), source);
  const result = spawnSync(process.execPath, ["scripts/run-react-doctor.js"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 2, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.schemaVersion, "paperclip.react-doctor-receipt.v1");
  assert.equal(receipt.outcome, "incomplete");
  assert.equal(receipt.error, "pinned-package-missing");
  assert.equal(receipt.exitCode, 2);
  assert.equal(receipt.scope, "staged");
  assert.equal(receipt.mutationIntent, "none");
  assert.equal(receipt.networkIntent, "none");
});

test("a pinned local analyzer produces a normalized receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-react-doctor-pinned-"));
  const scripts = join(root, "scripts");
  const packageRoot = join(root, "node_modules", "react-doctor");
  mkdirSync(scripts);
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(scripts, "run-react-doctor.js"), source);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    devDependencies: { "react-doctor": "0.7.8" },
  }));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "react-doctor",
    version: "0.7.8",
    type: "module",
    main: "bin/react-doctor.js",
    bin: { "react-doctor": "bin/react-doctor.js" },
  }));
  writeFileSync(join(packageRoot, "bin", "react-doctor.js"), [
    "console.log(JSON.stringify({ schemaVersion: 3, ok: true, mode: 'staged' }));",
  ].join("\n"));

  const result = spawnSync(process.execPath, ["scripts/run-react-doctor.js"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.outcome, "passed");
  assert.equal(receipt.tool.version, "0.7.8");
  assert.match(receipt.tool.packageSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.networkIntent, "none");
});

test("preserves a real analyzer failure exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-react-doctor-failure-"));
  const scripts = join(root, "scripts");
  const packageRoot = join(root, "node_modules", "react-doctor");
  mkdirSync(scripts);
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(scripts, "run-react-doctor.js"), source);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    devDependencies: { "react-doctor": "0.7.8" },
  }));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "react-doctor",
    version: "0.7.8",
    type: "module",
    main: "bin/react-doctor.js",
    bin: { "react-doctor": "bin/react-doctor.js" },
  }));
  writeFileSync(join(packageRoot, "bin", "react-doctor.js"), [
    "console.log(JSON.stringify({ schemaVersion: 3, ok: false }));",
    "process.exit(23);",
  ].join("\n"));

  const result = spawnSync(process.execPath, ["scripts/run-react-doctor.js"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 23, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.exitCode, 23);
  assert.equal(receipt.error, "analyzer-reported-failure");
});

test("turns analyzer termination into an incomplete receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-react-doctor-terminated-"));
  const scripts = join(root, "scripts");
  const packageRoot = join(root, "node_modules", "react-doctor");
  mkdirSync(scripts);
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(scripts, "run-react-doctor.js"), source);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    devDependencies: { "react-doctor": "0.7.8" },
  }));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "react-doctor",
    version: "0.7.8",
    type: "module",
    main: "bin/react-doctor.js",
    bin: { "react-doctor": "bin/react-doctor.js" },
  }));
  writeFileSync(join(packageRoot, "bin", "react-doctor.js"),
    "process.kill(process.pid, 'SIGTERM');\n");

  const result = spawnSync(process.execPath, ["scripts/run-react-doctor.js"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.outcome, "incomplete");
  assert.ok(["analyzer-terminated", "empty-analyzer-output"].includes(receipt.error));
});
