import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qualifyPnpmPackage, resolvePnpmCli } from "./resolve-pnpm-cli.mjs";

function fixture(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pc-pnpm-binding-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }));
    return body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function pkg(root, version = "9.15.4", bin = "bin/pnpm.cjs") {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pnpm", version, bin: { pnpm: bin } }));
  writeFileSync(path.join(root, "bin/pnpm.cjs"), "// inert package fixture; never executed\n");
  return path.join(root, "package.json");
}

test("binds the project-exact installed CLI without invoking a version-manager shim", () => fixture((root) => {
  const selected = path.join(root, "pnpm.cmd"); writeFileSync(selected, "MUST NEVER EXECUTE");
  const manifest = pkg(path.join(root, ".tools/pnpm/9.15.4/node_modules/pnpm"));
  const binding = resolvePnpmCli({ repoRoot: root, selectedCommand: selected, env: {} });
  assert.equal(binding.manifest, manifest); assert.equal(binding.version, "9.15.4");
  assert.equal(binding.cli, path.join(path.dirname(manifest), "bin/pnpm.cjs"));
  assert.match(binding.cliSha256, /^[a-f0-9]{64}$/u);
}));

test("wrong-version directory metadata and missing exact package refuse instead of switching/installing", () => fixture((root) => {
  const selected = path.join(root, "pnpm.cmd"); writeFileSync(selected, "MUST NEVER EXECUTE");
  pkg(path.join(root, ".tools/pnpm/9.15.4/node_modules/pnpm"), "10.25.0");
  assert.throws(() => resolvePnpmCli({ repoRoot: root, selectedCommand: selected, env: {} }), /not installed/);
  assert.throws(() => resolvePnpmCli({ repoRoot: root, env: { npm_execpath: selected } }), /not installed/);
}));

test("invalid explicit CLI cannot silently use a valid default package", () => fixture((root) => {
  pkg(path.join(root, "node_modules/pnpm"));
  const wrong = pkg(path.join(root, "wrong"), "10.25.0");
  assert.throws(() => resolvePnpmCli({ repoRoot: root, explicitCli: path.join(path.dirname(wrong), "bin/pnpm.cjs"), env: {} }), /does not match/);
  assert.throws(() => resolvePnpmCli({ repoRoot: root, explicitCli: "relative.cjs", env: {} }), /absolute/);
}));

test("manifest bin escape and realpath sibling-prefix escape fail closed", () => fixture((root) => {
  const packageRoot = path.join(root, "pnpm");
  const manifest = pkg(packageRoot, "9.15.4", "../pnpm-elsewhere/pnpm.cjs");
  assert.throws(() => qualifyPnpmPackage(manifest, "9.15.4"), /safe relative|escapes/);
  pkg(packageRoot);
  const elsewhere = path.join(root, "pnpm-elsewhere"); mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, "pnpm.cjs"), "// outside\n");
  rmSync(path.join(packageRoot, "bin"), { recursive: true });
  symlinkSync(elsewhere, path.join(packageRoot, "bin"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => qualifyPnpmPackage(manifest, "9.15.4"), /contained/);
}));
