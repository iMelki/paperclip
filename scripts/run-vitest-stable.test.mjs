import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGateChild } from "./gate-child.mjs";

const sourceScripts = path.dirname(fileURLToPath(import.meta.url));

test("the real exact runner awaits each file and refuses a delayed second-suite failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pc-stable-await-"));
  let cleanupAllowed = true;
  try {
    const scripts = path.join(root, "scripts"); mkdirSync(scripts);
    mkdirSync(path.join(root, "server/src/__tests__"), { recursive: true });
    for (const name of ["run-vitest-stable.mjs", "run-vitest-direct.mjs", "git-local-env.mjs", "gate-child.mjs", "general-server-shard.mjs"]) {
      copyFileSync(path.join(sourceScripts, name), path.join(scripts, name));
    }
    const vitestRoot = path.join(root, "node_modules/vitest"); mkdirSync(vitestRoot, { recursive: true });
    writeFileSync(path.join(vitestRoot, "package.json"), JSON.stringify({ name: "vitest", type: "module", bin: { vitest: "vitest-cli.mjs" } }));
    const trace = path.join(root, "trace.jsonl");
    writeFileSync(path.join(vitestRoot, "vitest-cli.mjs"), [
      'import { appendFileSync } from "node:fs";',
      'const file = process.argv.at(-1);',
      `const log = ${JSON.stringify(trace)};`,
      'appendFileSync(log, JSON.stringify(["start", file]) + "\\n");',
      'setTimeout(() => { appendFileSync(log, JSON.stringify(["end", file]) + "\\n"); process.exitCode = file === process.env.PAPERCLIP_FAKE_VITEST_FAIL_FILE ? 23 : 0; }, 20);',
    ].join("\n"));
    const runner = path.join(scripts, "run-vitest-stable.mjs");
    const failing = await runGateChild(process.execPath, [runner, "--files", "first.test.ts", "second.test.ts", "later.test.ts"], {
      cwd: root, env: { ...process.env, PAPERCLIP_FAKE_VITEST_FAIL_FILE: "second.test.ts" }, timeoutMs: 30_000,
    });
    if (failing.cleanupIncomplete) { cleanupAllowed = false; throw new Error(`fixture cleanup unresolved; preserved ${root}`); }
    assert.equal(failing.error, null); assert.equal(failing.status, 23);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split(/\r?\n/u).map(JSON.parse), [
      ["start", "first.test.ts"], ["end", "first.test.ts"], ["start", "second.test.ts"], ["end", "second.test.ts"],
    ]);
    writeFileSync(trace, "");
    const restored = await runGateChild(process.execPath, [runner, "--files", "first.test.ts", "second.test.ts"], {
      cwd: root, env: { ...process.env, PAPERCLIP_FAKE_VITEST_FAIL_FILE: "" }, timeoutMs: 30_000,
    });
    if (restored.cleanupIncomplete) { cleanupAllowed = false; throw new Error(`fixture cleanup unresolved; preserved ${root}`); }
    assert.equal(restored.error, null); assert.equal(restored.status, 0);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split(/\r?\n/u).map(JSON.parse), [
      ["start", "first.test.ts"], ["end", "first.test.ts"], ["start", "second.test.ts"], ["end", "second.test.ts"],
    ]);
  } finally { if (cleanupAllowed) rmSync(root, { recursive: true, force: true }); }
});
