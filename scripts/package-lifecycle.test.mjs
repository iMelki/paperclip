import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const prepare = path.join(ROOT, "scripts", "prepare-package-for-publish.mjs");
const restore = path.join(ROOT, "scripts", "restore-package-after-publish.mjs");

async function makeFixture(generatorBody) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "paperclip package lifecycle "));
  await writeFile(path.join(fixture, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  await writeFile(path.join(fixture, "generator.mjs"), generatorBody, "utf8");
  return fixture;
}

test("prepare and restore preserve the development package byte-for-byte", async () => {
  const fixture = await makeFixture(
    `import { writeFileSync } from "node:fs"; writeFileSync("package.json", "{\\"name\\":\\"published\\"}\\n");`,
  );
  try {
    const original = await readFile(path.join(fixture, "package.json"));
    await execFileAsync(process.execPath, [prepare, "generator.mjs"], { cwd: fixture });
    assert.deepEqual(await readFile(path.join(fixture, "package.dev.json")), original);
    await execFileAsync(process.execPath, [restore], { cwd: fixture });
    assert.deepEqual(await readFile(path.join(fixture, "package.json")), original);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("pre-existing backup collision fails without changing either file", async () => {
  const fixture = await makeFixture(
    `import { writeFileSync } from "node:fs"; writeFileSync("package.json", "changed\\n");`,
  );
  const backup = Buffer.from("caller-owned backup\\n");
  try {
    await writeFile(path.join(fixture, "package.dev.json"), backup);
    await assert.rejects(execFileAsync(process.execPath, [prepare, "generator.mjs"], { cwd: fixture }));
    assert.equal(await readFile(path.join(fixture, "package.dev.json"), "utf8"), backup.toString());
    assert.equal(await readFile(path.join(fixture, "package.json"), "utf8"), '{"name":"fixture","version":"1.0.0"}\n');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("generator failure restores the original package and removes its backup", async () => {
  const fixture = await makeFixture('process.exit(17);');
  try {
    await assert.rejects(execFileAsync(process.execPath, [prepare, "generator.mjs"], { cwd: fixture }));
    assert.equal(await readFile(path.join(fixture, "package.json"), "utf8"), '{"name":"fixture","version":"1.0.0"}\n');
    await assert.rejects(readFile(path.join(fixture, "package.dev.json")));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("published package manifests use the shared native lifecycle helpers", async () => {
  const manifests = [
    "ui/package.json",
    "packages/plugins/plugin-workspace-diff/package.json",
    "packages/plugins/sandbox-providers/cloudflare/package.json",
    "packages/plugins/sandbox-providers/daytona/package.json",
    "packages/plugins/sandbox-providers/e2b/package.json",
    "packages/plugins/sandbox-providers/exe-dev/package.json",
    "packages/plugins/sandbox-providers/kubernetes/package.json",
    "packages/plugins/sandbox-providers/modal/package.json",
    "packages/plugins/sandbox-providers/novita/package.json",
  ];
  for (const relative of manifests) {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
    assert.match(packageJson.scripts.prepack, /prepare-package-for-publish\.mjs/u, relative);
    assert.match(packageJson.scripts.postpack, /restore-package-after-publish\.mjs/u, relative);
    assert.doesNotMatch(
      `${packageJson.scripts.prepack} ${packageJson.scripts.postpack}`,
      /\b(?:rm|cp|mv|bash)\b/u,
      relative,
    );
  }
});
