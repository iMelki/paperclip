import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { runVitestDirect } from "./run-vitest-direct.mjs";

test("hostile test filenames remain one literal argv value with no command shell", () => {
  const hostile = "ui/src/a & echo PWNED > side-effect.test.ts";
  let observed;
  const result = runVitestDirect(["run", "--files", hostile], {
    cwd: "C:/repo",
    env: { NODE_ENV: "test" },
    resolvePackage: () => path.join("C:/repo", "node_modules/vitest/package.json"),
    spawn: (command, args, options) => {
      observed = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(result.status, 0);
  assert.equal(observed.command, process.execPath);
  assert.equal(observed.args.at(-1), hostile);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
});
