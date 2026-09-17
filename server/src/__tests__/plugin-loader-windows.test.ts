import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveNpmCliPath, resolveNpmInvocation } from "../services/plugin-loader.js";

const execFileAsync = promisify(execFile);

describe("resolveNpmInvocation", () => {
  it("runs npm through Node's JavaScript CLI on Windows", () => {
    const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
    const args = ["install", "paperclip-plugin-safe@1.0.0"];

    expect(resolveNpmInvocation(args, { platform: "win32", nodeExecutable })).toEqual({
      file: nodeExecutable,
      args: [resolveNpmCliPath(nodeExecutable), ...args],
    });
  });

  it("keeps the direct npm executable on non-Windows hosts", () => {
    const args = ["install", "paperclip-plugin-safe@1.0.0"];

    expect(resolveNpmInvocation(args, { platform: "linux" })).toEqual({
      file: "npm",
      args,
    });
  });

  it.runIf(process.platform === "win32")(
    "passes hostile package arguments as literal Node argv on Windows",
    async () => {
      const hostileArgs = [
        "install",
        "paperclip-plugin@^1.0.0&echo PR127_SHELL_EXECUTED&rem",
        "paperclip-plugin@~1.0.0",
        "%PATH%",
        "^caret^",
        "package name with spaces",
      ];
      const invocation = resolveNpmInvocation(hostileArgs, {
        platform: "win32",
        nodeExecutable: process.execPath,
      });
      const { stdout } = await execFileAsync(invocation.file, [
        "--eval",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)));",
        "--",
        ...invocation.args.slice(1),
      ]);

      expect(JSON.parse(stdout)).toEqual(hostileArgs);
    },
  );
});
