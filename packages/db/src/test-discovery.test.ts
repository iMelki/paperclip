import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratchModule = new URL("../../../scripts/lib/ephemeral-scratch.mjs", import.meta.url);
// A variable URL preserves the standalone module boundary without adding JS
// emission to the DB TypeScript build.
const {
  createEphemeralDir,
  createEphemeralFile,
  ephemeralChildEnv,
  ephemeralName,
  isEphemeralName,
} = await import(scratchModule.href);
const dbConfig = path.join(repoRoot, "packages/db/vitest.config.ts");
const vitestCli = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
const fixtureRoot = createEphemeralDir({ owner: "paperclip", purpose: "dbdiscovery" });
console.info(JSON.stringify({ caller: "db-test-discovery", fixtureRoot, retained: true }));
const authoredFiles = [
  "src/basic.test.ts",
  "src/nested/basic.spec.tsx",
  "src/common.test.cts",
  "src/module.spec.mts",
  "src/plain.test.js",
  "src/common.spec.cjs",
  "src/module.test.mjs",
  "scripts/maintenance.test.ts",
];
const rejectedFiles = [
  "dist/basic.test.js",
  "dist/stale-only.spec.js",
  "dist/scripts/maintenance.test.js",
  "docs/example.test.ts",
  "root.test.ts",
  "src/dist/nested.test.js",
  "src/node_modules/dependency.test.ts",
  "src/.git/hidden.test.ts",
];

// Keep the tiny synthetic fixture for failure inspection. Recycle it through
// the workspace cleanup tool; no live instance, credentials, or DB is used.
for (const file of [...authoredFiles, ...rejectedFiles]) {
  const destination = path.join(fixtureRoot, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, 'throw new Error("discovery must not execute fixtures");\n');
}

function listFiles(filter?: string): string[] {
  const result = spawnSync(process.execPath, [
    vitestCli, "list", "--filesOnly", "--json",
    "--config", dbConfig, "--root", fixtureRoot,
    ...(filter ? [filter] : []),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...ephemeralChildEnv(fixtureRoot) },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = JSON.parse(result.stdout) as { file: string }[];
  return entries.map(({ file }) => path.relative(fixtureRoot, file).replaceAll("\\", "/")).sort();
}

test("DB discovery selects authored src and maintenance suites, not build copies", { timeout: 40_000 }, () => {
  assert.deepEqual(listFiles(), [...authoredFiles].sort());
});

test("a CLI filter cannot enroll stale generated DB tests", { timeout: 40_000 }, () => {
  assert.deepEqual(listFiles("dist/stale-only"), []);
});

test("an exact maintenance filter still selects the authored suite once", { timeout: 40_000 }, () => {
  assert.deepEqual(listFiles("scripts/maintenance.test.ts"), ["scripts/maintenance.test.ts"]);
});

test("discovery reuses the pinned canonical scratch primitive", () => {
  // Ignore checkout line endings only; all other source drift must fail.
  const source = readFileSync(scratchModule, "utf8").replaceAll("\r\n", "\n");
  const digest = createHash("sha256").update(source).digest("hex");
  assert.equal(digest, "4c29cea62dbba24e737f3e8776b504bd7c710c3fbc6dc3ad1c980243cef11af2");
  assert.equal(isEphemeralName(path.basename(fixtureRoot)), true);
});

test("scratch files with safe extensions stay inside the requested root", () => {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "extok", root: fixtureRoot });
  const cases: [string | undefined, string][] = [
    [".json", ".json"], ["txt", ".txt"], [".tar.gz", ".tar.gz"], [undefined, ""],
  ];
  for (const [ext, suffix] of cases) {
    const file: string = createEphemeralFile({ owner: "paperclip", purpose: "extok", ext, root });
    const name = path.basename(file);
    assert.equal(path.dirname(file), path.resolve(root));
    assert.equal(name.endsWith(suffix), true);
    assert.equal(isEphemeralName(name.slice(0, name.length - suffix.length)), true);
  }
});

test("scratch file extensions cannot traverse or add path segments", () => {
  const outer = createEphemeralDir({ owner: "paperclip", purpose: "extbad", root: fixtureRoot });
  const root = path.join(outer, "inner");
  const unsafe = [
    "/../../escape", "../escape", ".x/../../escape", ".x/y", "/x", ".x\\..\\escape",
    ".x\\y", ".", "..", "...", ".a..b", ". x", ".x\0", ".abcdefghijklmnopq", 42,
  ];
  for (const ext of unsafe) {
    assert.throws(
      () => createEphemeralFile({ owner: "paperclip", purpose: "extbad", ext, root }),
      TypeError,
      `extension ${JSON.stringify(ext)} must be rejected`,
    );
  }
  // Nothing may have been written beside or above the requested root.
  assert.deepEqual(readdirSync(outer).filter((name) => name !== "inner"), []);
  assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0);
});

test("scratch name unique suffix must match the governed grammar", () => {
  for (const unique of ["../../x", "a/b/cd", "ABCDEF", "abc", "abcdefg"]) {
    assert.throws(() => ephemeralName({ owner: "paperclip", purpose: "unique", unique }), TypeError);
  }
  assert.equal(isEphemeralName(ephemeralName({ owner: "paperclip", purpose: "unique", unique: "abc123" })), true);
});

test("scratch directories and files are private to the creating user", { skip: process.platform === "win32" }, () => {
  const dir = createEphemeralDir({ owner: "paperclip", purpose: "mode", root: fixtureRoot });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = createEphemeralFile({ owner: "paperclip", purpose: "mode", ext: ".txt", root: dir });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
