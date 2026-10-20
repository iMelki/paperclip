import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  forEachExactVitestFile,
  resolveVitestCli,
  runVitestDirect,
} from "./run-vitest-direct.mjs";

test("resolves the Vitest executable from the package manifest bin field", () => {
  const manifestPath = path.join("C:/repo", "node_modules/vitest/package.json");
  const cli = resolveVitestCli(
    () => manifestPath,
    () => JSON.stringify({ bin: { vitest: "./dist/custom-cli.mjs" } }),
  );
  assert.equal(cli, path.resolve(path.dirname(manifestPath), "dist/custom-cli.mjs"));
  assert.throws(
    () => resolveVitestCli(() => manifestPath, () => JSON.stringify({ bin: {} })),
    /does not declare a vitest executable/,
  );
  assert.throws(
    () => resolveVitestCli(
      () => manifestPath,
      () => JSON.stringify({ bin: { vitest: "../outside.mjs" } }),
    ),
    /outside its package/,
  );
});

test("hostile test filenames remain one literal argv value with no command shell", async () => {
  const hostile = "ui/src/a & echo PWNED > side-effect.test.ts";
  let observed;
  const result = await runVitestDirect(["run", "--files", hostile], {
    cwd: "C:/repo",
    env: { NODE_ENV: "test" },
    resolvePackage: () => path.join("C:/repo", "node_modules/vitest/package.json"),
    readManifest: () => JSON.stringify({ bin: { vitest: "./vitest-cli.mjs" } }),
    run: async (command, args, options) => {
      observed = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(observed.command, process.execPath);
  assert.equal(observed.args[0], path.resolve("C:/repo", "node_modules/vitest/vitest-cli.mjs"));
  assert.equal(observed.args.at(-1), hostile);
  assert.equal(observed.options.stdio, undefined);
});

test("exact files run independently and the first unmatched file stops the plan", async () => {
  const calls = [];
  await assert.rejects(
    () => forEachExactVitestFile(
      ["included.test.ts", "excluded.spec.ts", "later.test.ts"],
      async (file) => {
        calls.push([file]);
        if (file === "excluded.spec.ts") throw new Error(`no test files found for ${file}`);
      },
    ),
    /no test files found for excluded\.spec\.ts/,
  );
  assert.deepEqual(calls, [["included.test.ts"], ["excluded.spec.ts"]]);

  const restored = [];
  await forEachExactVitestFile(["first.test.ts", "second.test.ts"], async (file) => restored.push([file]));
  assert.deepEqual(restored, [["first.test.ts"], ["second.test.ts"]]);
});

test("a delayed second-suite failure cannot disappear behind an early resolved plan", async () => {
  const calls = [];
  await assert.rejects(() => forEachExactVitestFile(["first.test.ts", "second.test.ts", "later.test.ts"], async (file) => {
    await new Promise((resolve) => setImmediate(resolve));
    calls.push(file);
    if (file === "second.test.ts") throw new Error("sentinel delayed exact-suite failure");
  }), /sentinel delayed exact-suite failure/);
  assert.deepEqual(calls, ["first.test.ts", "second.test.ts"]);
});
