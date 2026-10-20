import assert from "node:assert/strict";
import test from "node:test";
import { runPluginCompiler } from "./ensure-plugin-build-deps.mjs";

test("plugin compiler awaits transport and preserves exact compiler/target argv and failed status", async () => {
  let completed = false;
  const result = await runPluginCompiler({ tsconfig: "literal & target.json" }, {
    compiler: "literal compiler/tsc", cwd: "owned-root",
    run: async (command, args, options) => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["literal compiler/tsc", "-p", "literal & target.json"]);
      assert.equal(options.cwd, "owned-root");
      completed = true;
      return { status: 19 };
    },
  });
  assert.equal(completed, true); assert.equal(result.status, 19);
});

test("compiler transport failure is retained for the owning build loop", async () => {
  const error = new Error("sentinel compiler transport failure");
  const result = await runPluginCompiler({ tsconfig: "target.json" }, { run: async () => ({ error, status: 0 }) });
  assert.equal(result.error, error);
});
