import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(sourceDir, "../../..");
const adapterRequire = createRequire(path.join(repository, "packages/adapters/codex-local/package.json"));
const distributionPath = adapterRequire.resolve("@agentclientprotocol/codex-acp/dist/index.js");
const dependencyRequire = createRequire(distributionPath);
const { applyPatch } = dependencyRequire("diff") as { applyPatch(source: string, patch: string): string | false };
const original = fs.readFileSync(distributionPath, "utf8");
const patch = fs.readFileSync(path.join(repository, "patches/@agentclientprotocol__codex-acp@1.13.1.patch"), "utf8");
// pnpm applies the pinned patch at install time, so a normal checkout already
// holds the patched file. An unpatched file (an install that skipped patches)
// gets the patch applied here, which also proves the hunk still matches.
const alreadyPatched = original.includes("function resolveWindowsCodexExecutable(");
const patched = process.env.PAPERCLIP_CODEX_PATCH_PROOF_BEFORE === "1" || alreadyPatched ? original : applyPatch(original, patch);
if (patched === false) throw new Error("The pinned Codex ACP patch does not apply to the installed distribution");
const proposed: string = patched;

function fixture(platform = "win32", arch = "x64") {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }> = [];
  const bundled = "C:\\packages\\codex\\bin\\codex.js";
  const platformPackage = "C:\\packages\\codex-platform\\package.json";
  let realTarget: string | undefined;
  let targetIsFile = true;
  let bundledExeMissing = false;
  const requireFixture = Object.assign((name: string) => {
    if (name === "node:path") return path.win32;
    if (name === "node:fs") return {
      realpathSync: (target: string) => realTarget ?? target,
      statSync: (target: string) => {
        if (bundledExeMissing && /[\\/]vendor[\\/]/.test(target)) throw new Error("ENOENT: no such file or directory");
        return { isFile: () => targetIsFile };
      },
    };
    throw new Error(`Unexpected fixture module: ${name}`);
  }, { resolve: (name: string) => {
    if (name === "@openai/codex/bin/codex.js") return bundled;
    if (/^@openai\/codex-win32-(x64|arm64)\/package\.json$/.test(name)) return platformPackage;
    throw new Error(`Unexpected fixture resolution: ${name}`);
  } });
  const nativeBegin = proposed.indexOf("function resolveWindowsCodexExecutable(");
  const begin = nativeBegin >= 0 ? nativeBegin : proposed.indexOf("function startCodexConnection(");
  const end = proposed.indexOf("// src/ACPSessionConnection.ts", begin);
  if (begin < 0 || end < 0) throw new Error("Patched production function boundaries are missing");
  const executableSource = proposed.slice(begin, end).replaceAll("import.meta.url", JSON.stringify("file:///fixture/dist/index.js"));
  const factory = vm.runInNewContext(executableSource + "\n({ startCodexConnection })", {
    process: { platform, arch, execPath: "/fixture/node", env: { SAFE: "preserved" } },
    createRequire: () => requireFixture,
    spawn: (command: string, second: string[] | Record<string, unknown>, third?: Record<string, unknown>) => {
      const args = Array.isArray(second) ? second : [];
      const options = (Array.isArray(second) ? third : second) as Record<string, unknown>;
      calls.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child;
    },
    logger: { log: (message: string) => logs.push(message) },
    createJSONRPCReader: (stream: unknown) => stream,
    createJSONRPCWriter: (stream: unknown) => stream,
    rpc: { createMessageConnection: () => ({ listen() {}, dispose() {} }) },
  }) as { startCodexConnection(codexPath?: string, env?: Record<string, string>): unknown };
  return { ...factory, calls, logs, children, setRealTarget: (value: string) => { realTarget = value; }, setTargetIsFile: (value: boolean) => { targetIsFile = value; }, setBundledExeMissing: (value: boolean) => { bundledExeMissing = value; } };
}

describe("pinned Codex ACP Windows launch patch", () => {
  it.skipIf(process.env.PAPERCLIP_CODEX_PATCH_PROOF_BEFORE === "1")("is applied to the installed distribution or applies to it cleanly", () => {
    expect(proposed).toContain("function resolveWindowsCodexExecutable(");
    expect(proposed).toContain("windowsHide: true");
  });

  it("launches the bundled native exe directly with bounded protocol pipes and no shell", () => {
    const run = fixture();
    const env = { SAFE: "preserved", PATH: "C:\\approved" };
    run.startCodexConnection(undefined, env);
    expect(run.calls).toEqual([{
      command: "C:\\packages\\codex-platform\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
      args: ["app-server"],
      options: { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env },
    }]);
    expect(env).toEqual({ SAFE: "preserved", PATH: "C:\\approved" });
  });

  it("preserves spaces and metacharacters in a configured absolute exe as one program", () => {
    const run = fixture();
    run.startCodexConnection("C:\\approved & tools\\codex.exe");
    expect(run.calls[0].command).toBe("C:\\approved & tools\\codex.exe");
    expect(run.calls[0].args).toEqual(["app-server"]);
    expect(run.calls[0].options).toMatchObject({ shell: false, windowsHide: true });
  });

  it.each(["codex", "codex.exe", "C:\\tools\\codex.cmd", "C:\\tools\\codex.ps1"]) (
    "keeps the previous shell launch, with a hidden window, for the shim or bare path %s", (target) => {
      const run = fixture();
      const env = { SAFE: "preserved" };
      run.startCodexConnection(target, env);
      expect(run.calls).toEqual([{
        command: `"${target}" app-server`,
        args: [],
        options: { shell: true, windowsHide: true, env },
      }]);
      expect(run.logs.some((line) => /not an absolute native \.exe path/.test(line))).toBe(true);
    },
  );

  it("refuses a redirected non-exe or directory target before spawn", () => {
    const redirected = fixture();
    redirected.setRealTarget("C:\\tools\\codex.cmd");
    expect(() => redirected.startCodexConnection("C:\\tools\\codex.exe")).toThrow(/native \.exe file/);
    expect(redirected.calls).toHaveLength(0);
    const directory = fixture();
    directory.setTargetIsFile(false);
    expect(() => directory.startCodexConnection("C:\\tools\\codex.exe")).toThrow(/native \.exe file/);
    expect(directory.calls).toHaveLength(0);
  });

  it("falls back to the bundled Node launcher, with a hidden window and a log line, when the native exe is missing", () => {
    const run = fixture();
    run.setBundledExeMissing(true);
    const env = { SAFE: "preserved" };
    run.startCodexConnection(undefined, env);
    expect(run.calls).toEqual([{
      command: "/fixture/node",
      args: ["C:\\packages\\codex\\bin\\codex.js", "app-server"],
      options: { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env },
    }]);
    expect(run.logs.some((line) => /Bundled native codex\.exe was not found/.test(line))).toBe(true);
  });

  it("selects the existing arm64 platform package and falls back to the Node launcher on an unsupported architecture", () => {
    const arm = fixture("win32", "arm64");
    arm.startCodexConnection();
    expect(arm.calls[0].command).toContain("aarch64-pc-windows-msvc");
    const unknown = fixture("win32", "ia32");
    unknown.startCodexConnection();
    expect(unknown.calls[0]).toMatchObject({ command: "/fixture/node", options: { windowsHide: true } });
    expect(unknown.logs.some((line) => /Unsupported Windows Codex architecture/.test(line))).toBe(true);
  });

  it("keeps non-Windows configured and bundled command choices", () => {
    const direct = fixture("linux");
    direct.startCodexConnection("/approved/codex");
    expect(direct.calls[0]).toMatchObject({ command: "/approved/codex", args: ["app-server"] });
    const bundled = fixture("linux");
    bundled.startCodexConnection();
    expect(bundled.calls[0]).toMatchObject({ command: "/fixture/node", args: ["C:\\packages\\codex\\bin\\codex.js", "app-server"] });
  });

  it("retains actual stdin/stdout/stderr log consumers and the existing EOF cleanup source", () => {
    const run = fixture();
    run.startCodexConnection();
    run.children[0].stdin.write("request");
    run.children[0].stdout.write("reply");
    run.children[0].stderr.write("diagnostic");
    expect(run.logs).toEqual(["[IN] request", "[OUT] reply", "[ERR] diagnostic"]);
    const eof = 'process.stdin.on("close", () => {';
    const before = original.slice(original.indexOf(eof), original.indexOf(eof) + 430);
    expect(before).toContain("codexProcessState.connection.process.stdin.end()");
    expect(proposed).toContain(before);
  });
});

describe("Paperclip Windows builtin ACP selection", () => {
  async function select(agent: string, platform: string, remote = false, entrypoint = "C:\\pinned package\\codex-acp\\dist\\index.js", node = "C:\\Program Files\\node\\node.exe", warnings: string[] = []) {
    const source = fs.readFileSync(process.env.PAPERCLIP_ACPX_COMMAND_SOURCE ?? path.join(sourceDir, "acpx-engine/execute.ts"), "utf8");
    const begin = source.indexOf("async function resolveBuiltInAgentCommand(");
    const end = source.indexOf("const execFileAsync", begin);
    if (begin < 0 || end < 0) throw new Error("Production command-selection function is missing");
    const executable = transformSync(source.slice(begin, end), { loader: "ts", target: "es2022", format: "esm" }).code;
    const resolve = vm.runInNewContext(executable + "\nresolveBuiltInAgentCommand", {
      process: { platform, execPath: node },
      path: path.win32,
      createRequire: () => ({ resolve: () => { if (!entrypoint) throw new Error("MODULE_NOT_FOUND"); return entrypoint; } }),
      shellQuote: (value: string) => `'${value.replaceAll("'", `'\\''`)}'`,
      findAncestorBin: async () => "C:\\existing\\agent.cmd",
    }) as (input: unknown) => Promise<{ command: string; shellCommand: string }>;
    return resolve({ agent, packageRootDir: "C:\\adapter", executionTargetIsRemote: remote, onWarning: (message: string) => warnings.push(message) });
  }

  it("bypasses the Windows Codex batch shim with exact Node and pinned JS arguments", async () => {
    const chosen = await select("codex", "win32");
    expect(chosen.command).toBe('"C:\\Program Files\\node\\node.exe" "C:\\pinned package\\codex-acp\\dist\\index.js"');
    expect(chosen.command).not.toContain(".cmd");
  });

  it("round-trips spaces, apostrophes and metacharacters through the installed ACPX Windows parser", async () => {
    const entrypoint = "C:\\pinned's package & tools\\codex-acp\\dist\\index.js";
    const node = "C:\\Program Files\\O'Brien & Co\\node.exe";
    const selected = await select("codex", "win32", false, entrypoint, node);
    const acpxRequire = createRequire(path.join(repository, "packages/adapter-utils/package.json"));
    const runtimeDir = path.dirname(acpxRequire.resolve("acpx/runtime"));
    const chunk = fs.readdirSync(runtimeDir).find((name) => /^live-checkpoint-.*\.js$/.test(name));
    if (!chunk) throw new Error("The pinned installed ACPX parser chunk is missing");
    const source = fs.readFileSync(path.join(runtimeDir, chunk), "utf8");
    const begin = source.indexOf("function splitCommandLine(");
    const end = source.indexOf("function asAbsoluteCwd(", begin);
    if (begin < 0 || end < 0) throw new Error("The installed ACPX parser function closure is missing");
    const parse = vm.runInNewContext(source.slice(begin, end) + "\nsplitCommandLine", { process: { platform: "win32" } }) as (input: string) => { command: string; args: string[] };
    expect(parse(selected.command)).toEqual({ command: node, args: [entrypoint] });
  });

  it("falls back to the existing bin lookup when the pinned entrypoint cannot be resolved", async () => {
    const warnings: string[] = [];
    expect((await select("codex", "win32", false, "", undefined, warnings)).command).toBe("C:\\existing\\agent.cmd");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Could not resolve the pinned codex-acp entrypoint from C:\\adapter \(MODULE_NOT_FOUND\)/);
    expect(warnings[0]).toMatch(/console window/);
  });

  it("preserves remote, non-Windows and other-provider selection", async () => {
    expect((await select("codex", "linux")).command).toBe("C:\\existing\\agent.cmd");
    expect((await select("codex", "win32", true)).command).toBe("codex-acp");
    expect((await select("claude", "win32")).command).toBe("C:\\existing\\agent.cmd");
  });
});
