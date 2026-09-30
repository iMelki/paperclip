import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratchModule = new URL("../../../scripts/lib/ephemeral-scratch.mjs", import.meta.url);
// A variable URL preserves the standalone module boundary without adding JS
// emission to the DB TypeScript build.
const { createEphemeralDir, ephemeralChildEnv, isEphemeralName } = await import(scratchModule.href);
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
  assert.equal(digest, "a296c167b1d77fcb4b665152917f38f02d9b7c8c9458601d96bb678eeb38a6be");
  assert.equal(isEphemeralName(path.basename(fixtureRoot)), true);
});
