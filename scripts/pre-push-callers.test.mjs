import assert from "node:assert/strict";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveNativeExecutable } from "./gate-child.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const psCaller = path.join(repoRoot, "scripts/pre-push-check.ps1");
const shCaller = path.join(repoRoot, "scripts/pre-push-check.sh");

function commandAvailable(command) {
  try {
    const executable = resolveNativeExecutable(command);
    const basename = path.basename(executable).replace(/\.exe$/iu, "");
    const args = basename === "sh" ? ["-c", "exit 0"] : ["-NoProfile", "-NonInteractive", "--version"];
    const result = spawnSync(executable, args, { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    return !result.error && result.status === 0;
  } catch { return false; }
}

const pwshCommand = commandAvailable("pwsh") ? resolveNativeExecutable("pwsh") : null;

const shCommand = [
  "sh",
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe")
    : null,
].filter(Boolean).map((command) => {
  try { return resolveNativeExecutable(command); } catch { return null; }
}).filter(Boolean).find(commandAvailable);

function assertNoTemporaryGateArtifacts(root, logName) {
  assert.match(readFileSync(path.join(root, logName), "utf8"), /Paperclip/);
  const temporaryArtifacts = readdirSync(root).filter(
    (entry) => entry === `${logName}.updates` || entry.startsWith(`${logName}.step-`),
  );
  assert.deepEqual(temporaryArtifacts, []);
}

function withFakeTools(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-prepush-callers-"));
  try {
    const nodeSh = path.join(root, "node");
    const pnpmSh = path.join(root, "pnpm");
    writeFileSync(
      nodeSh,
      [
        "#!/usr/bin/env sh",
        'if [ -n "${PAPERCLIP_FAKE_ARGS_LOG:-}" ]; then printf "%s\\n" "$*" >> "$PAPERCLIP_FAKE_ARGS_LOG"; fi',
        'if [ -n "${PAPERCLIP_FAKE_NATIVE_STDERR:-}" ]; then echo "sentinel native stderr" >&2; fi',
        'if [ "${PAPERCLIP_FAKE_SIGNAL_PARENT:-}" = "TERM" ]; then kill -TERM "$PPID"; exit 0; fi',
        'case "$*" in',
        '  *check-no-git-push.mjs*) exit "${PAPERCLIP_FAKE_NO_PUSH_EXIT:-0}";;',
        '  *scan-pre-push-secrets.mjs*) exit "${PAPERCLIP_FAKE_SECRET_EXIT:-0}";;',
        '  *run-pre-push-tests.mjs*) exit "${PAPERCLIP_FAKE_PLAN_EXIT:-0}";;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(pnpmSh, "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(nodeSh, 0o755);
    chmodSync(pnpmSh, 0o755);

    writeFileSync(
      path.join(root, "node.cmd"),
      [
        "@echo off",
        "if not \"%PAPERCLIP_FAKE_ARGS_LOG%\"==\"\" echo %*>>\"%PAPERCLIP_FAKE_ARGS_LOG%\"",
        "if not \"%PAPERCLIP_FAKE_NATIVE_STDERR%\"==\"\" echo sentinel native stderr 1>&2",
        "echo %* | %SystemRoot%\\System32\\findstr.exe /C:\"check-no-git-push.mjs\" >nul",
        "if %errorlevel%==0 exit /b %PAPERCLIP_FAKE_NO_PUSH_EXIT%",
        "echo %* | %SystemRoot%\\System32\\findstr.exe /C:\"scan-pre-push-secrets.mjs\" >nul",
        "if %errorlevel%==0 exit /b %PAPERCLIP_FAKE_SECRET_EXIT%",
        "echo %* | %SystemRoot%\\System32\\findstr.exe /C:\"run-pre-push-tests.mjs\" >nul",
        "if %errorlevel%==0 exit /b %PAPERCLIP_FAKE_PLAN_EXIT%",
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    writeFileSync(path.join(root, "pnpm.cmd"), "@echo off\r\nexit /b 0\r\n");
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeEnvironment(
  fakeBin,
  {
    planExit = 0,
    noPushExit = 0,
    secretExit = 0,
    argsLog = "",
    logPath = "",
    nativeStderr = false,
    signalParent = "",
  } = {},
) {
  return {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    PAPERCLIP_FAKE_PLAN_EXIT: `${planExit}`,
    PAPERCLIP_FAKE_NO_PUSH_EXIT: `${noPushExit}`,
    PAPERCLIP_FAKE_SECRET_EXIT: `${secretExit}`,
    PAPERCLIP_FAKE_ARGS_LOG: argsLog,
    PAPERCLIP_PRE_PUSH_LOG_PATH: logPath,
    PAPERCLIP_FAKE_NATIVE_STDERR: nativeStderr ? "1" : "",
    PAPERCLIP_FAKE_SIGNAL_PARENT: signalParent,
  };
}

// The PowerShell transport deliberately rejects .cmd-as-native execution. Its
// production caller is copied into an isolated fixture with real Node and inert
// gate modules, rather than weakening that requirement to accommodate a shim.
function withNativeFakeGate(body) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-native-gate-"));
  let fixtureCompleted = false;
  try {
    const scripts = path.join(root, "scripts"); mkdirSync(scripts);
    for (const name of ["pre-push-check.ps1", "gate-native.ps1", "resolve-pnpm-cli.mjs", "is-main-module.mjs"]) {
      copyFileSync(path.join(repoRoot, "scripts", name), path.join(scripts, name));
    }
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }));
    const pnpmRoot = path.join(root, "node_modules/pnpm"); mkdirSync(path.join(pnpmRoot, "bin"), { recursive: true });
    writeFileSync(path.join(pnpmRoot, "package.json"), JSON.stringify({ name: "pnpm", version: "9.15.4", bin: { pnpm: "bin/pnpm.cjs" } }));
    writeFileSync(path.join(pnpmRoot, "bin/pnpm.cjs"), "// inert pnpm fixture; all tasks succeed\n");
    for (const [name, exitKey] of [
      ["check-no-git-push.mjs", "PAPERCLIP_FAKE_NO_PUSH_EXIT"],
      ["check-pr-workflow-trigger.mjs", ""],
      ["scan-pre-push-secrets.mjs", "PAPERCLIP_FAKE_SECRET_EXIT"],
      ["run-pre-push-tests.mjs", "PAPERCLIP_FAKE_PLAN_EXIT"],
    ]) {
      writeFileSync(path.join(scripts, name), [
        'import { appendFileSync } from "node:fs";',
        'if (process.env.PAPERCLIP_FAKE_ARGS_LOG) appendFileSync(process.env.PAPERCLIP_FAKE_ARGS_LOG, process.argv.slice(1).join(" ") + "\\n");',
        'if (process.env.PAPERCLIP_FAKE_NATIVE_STDERR) console.error("sentinel native stderr");',
        `process.exitCode = Number(process.env[${JSON.stringify(exitKey)}] || 0);`,
      ].join("\n"));
    }
    writeFileSync(path.join(scripts, "run-workspace-gate.mjs"), [
      'import {appendFileSync} from "node:fs";',
      'if(process.env.PAPERCLIP_FAKE_ARGS_LOG)appendFileSync(process.env.PAPERCLIP_FAKE_ARGS_LOG,process.argv.slice(1).join(" ")+"\\n");',
      'process.exitCode=0;',
    ].join("\n"));
    const git = resolveNativeExecutable(process.platform === "win32" ? "git.exe" : "git");
    const discovery = spawnSync(git, ["rev-parse", "--local-env-vars"], {
      cwd: repoRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
      windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(discovery.status, 0, discovery.stderr);
    const env = { ...process.env };
    for (const name of discovery.stdout.split(/\r?\n/u).filter(Boolean)) delete env[name];
    const init = spawnSync(git, ["init", "--", root], { env, timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(init.status, 0, `${init.stderr}`);
    const identity = spawnSync(git, ["-C", root, "rev-parse", "--show-toplevel"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(identity.status, 0, identity.stderr);
    assert.equal(path.resolve(identity.stdout.trim()).toLowerCase(), path.resolve(root).toLowerCase(), "fixture must own its Git root before caller execution");
    const value = body(root, path.join(scripts, "pre-push-check.ps1"), env);
    fixtureCompleted = true;
    return value;
  } finally {
    if (fixtureCompleted) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ diagnostic: "pre-push failed fixture preserved", root }));
  }
}

test("both callers use the same security, workflow, and exact-plan gates", () => {
  const ps = readFileSync(psCaller, "utf8");
  const sh = readFileSync(shCaller, "utf8");
  const hook = readFileSync(path.join(repoRoot, ".husky/pre-push"), "utf8");
  for (const caller of [ps, sh]) {
    assert.match(caller, /check-no-git-push\.mjs/);
    assert.match(caller, /check-pr-workflow-trigger\.mjs/);
    assert.match(caller, /scan-pre-push-secrets\.mjs/);
    assert.match(caller, /run-pre-push-tests\.mjs/);
    assert.doesNotMatch(caller, /--related|PAPERCLIP_PRECOMMIT_RELATED_CAP/);
    assert.match(caller, /git-path[\s'\",]+paperclip-gate-logs\/pre-push/);
    assert.doesNotMatch(caller, /\.local-logs\/pre-push/);
  }
  assert.match(hook, /run-pre-push-pwsh\.mjs "\$pwsh_path" "\$1" "\$2"/);
  assert.match(hook, /pre-push-check\.sh "\$@"/);
  assert.match(ps, /PSNativeCommandUseErrorActionPreference\s*=\s*\$false/);
  for (const signal of ["HUP", "INT", "TERM"]) {
    assert.match(sh, new RegExp(`trap 'exit \\d+' ${signal}`));
  }
});

test("PowerShell native resolution accepts real hard links and refuses non-native or missing files", {
  skip: process.platform !== "win32" || !pwshCommand,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-native-hardlink-"));
  let completed = false;
  try {
    const linked = path.join(root, "hardlinked-node.exe");
    linkSync(process.execPath, linked);
    const bad = path.join(root, "refuse.cmd"); writeFileSync(bad, "@exit /b 0\r\n");
    const script = path.join(root, "resolve-hardlink.ps1");
    writeFileSync(script, [
      "param([string]$Helper, [string]$Linked, [string]$Bad, [string]$Missing)",
      "$ErrorActionPreference = 'Stop'",
      ". $Helper",
      "if ((Get-Item -LiteralPath $Linked).LinkType -ne 'HardLink') { throw 'Fixture is not an actual hard link.' }",
      "$selected = Resolve-GateExecutable -Command $Linked",
      "if ($selected -ne [IO.Path]::GetFullPath($Linked)) { throw 'Hard-link native path was not preserved.' }",
      "Write-Output 'hardlink-positive-ok'",
      "foreach ($candidate in @($Bad, $Missing)) {",
      "  $refused = $false",
      "  try { Resolve-GateExecutable -Command $candidate | Out-Null } catch { $refused = $true }",
      "  if (-not $refused) { throw 'Unsafe or missing executable was accepted.' }",
      "}",
      "Write-Output 'native-refusals-ok'",
    ].join("\n"));
    const result = spawnSync(pwshCommand, [
      "-NoProfile", "-NonInteractive", "-File", script,
      "-Helper", path.join(repoRoot, "scripts/gate-native.ps1"),
      "-Linked", linked, "-Bad", bad, "-Missing", path.join(root, "missing.exe"),
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(path.join(root, "result.private.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /hardlink-positive-ok/);
    assert.match(result.stdout, /native-refusals-ok/);
    completed = true;
  } finally {
    if (completed) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ diagnostic: "native hard-link fixture preserved", root }));
  }
});

test("PowerShell native capture returns separate streams and status after disposal", {
  skip: !pwshCommand,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-native-capture-"));
  let completed = false;
  try {
    const childScript = path.join(root, "capture-child.cjs");
    writeFileSync(childScript, [
      'process.stdin.once("end", () => {',
      '  process.stdout.write("native-stdout\\n");',
      '  process.stderr.write("native-stderr\\n");',
      '  process.exitCode = 23;',
      '});',
      'process.stdin.resume();',
    ].join("\n"));
    const script = path.join(root, "capture.ps1");
    writeFileSync(script, [
      'param([string]$Helper, [string]$Node, [string]$ChildScript, [string]$Root)',
      "$ErrorActionPreference = 'Stop'",
      '. $Helper',
      '$result = Invoke-GateNative -FilePath $Node -ArgumentList @($ChildScript) -WorkingDirectory $Root -Capture -TimeoutMs 10000',
      'if ($result.ExitCode -ne 23) { throw "Natural child status was not preserved." }',
      'if ($result.Stdout -cne "native-stdout`n") { throw "Stdout capture was missing or mixed." }',
      'if ($result.Stderr -cne "native-stderr`n") { throw "Stderr capture was missing or mixed." }',
      "Write-Output 'capture-returned-after-disposal-ok'",
    ].join("\n"));
    const result = spawnSync(pwshCommand, [
      "-NoProfile", "-NonInteractive", "-File", script,
      "-Helper", path.join(repoRoot, "scripts/gate-native.ps1"),
      "-Node", process.execPath, "-ChildScript", childScript, "-Root", root,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const receipt = { status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
    writeFileSync(path.join(root, "result.private.json"), JSON.stringify(receipt, null, 2));
    console.error(JSON.stringify({ diagnostic: "native capture before assertions", ...receipt }));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /capture-returned-after-disposal-ok/);
    completed = true;
  } finally {
    if (completed) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ diagnostic: "native capture fixture preserved", root }));
  }
});

test("PowerShell caller invokes the no-push gate, propagates failures, and passes after restore", {
  skip: !pwshCommand,
}, () => {
  withNativeFakeGate((fakeBin, fixtureCaller, isolatedEnv) => {
    const update = `refs/heads/topic ${"a".repeat(40)} refs/heads/topic ${"0".repeat(40)}\n`;
    const invoke = (fakeExits, label) => {
      const logName = `${label}.log`;
      let commandArgs = [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fixtureCaller,
        "-RemoteName",
        "origin",
        "-RemoteLocation",
        "trusted-location",
        "-LogPath",
        path.join(fakeBin, logName),
      ];
      if (fakeExits.nativePreference) {
        const quote = (value) => value.replaceAll("'", "''");
        const wrapper = path.join(fakeBin, `${label}-wrapper.ps1`);
        writeFileSync(
          wrapper,
          [
            "$PSNativeCommandUseErrorActionPreference = $true",
            `& '${quote(fixtureCaller)}' -RemoteName 'origin' -RemoteLocation 'trusted-location' ` +
              `-LogPath '${quote(path.join(fakeBin, logName))}'`,
            "exit $LASTEXITCODE",
            "",
          ].join("\n"),
        );
        commandArgs = ["-NoProfile", "-NonInteractive", "-File", wrapper];
      }
      const result = spawnSync(
        pwshCommand,
        commandArgs,
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...isolatedEnv, ...Object.fromEntries(Object.entries(fakeEnvironment(fakeBin, fakeExits)).filter(([key]) => key.startsWith("PAPERCLIP_FAKE_"))) },
          input: update,
          windowsHide: true,
          shell: false,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const childReceipt = {
        label, status: result.status, signal: result.signal,
        error: result.error ? { message: result.error.message, code: result.error.code } : null,
        stdout: result.stdout, stderr: result.stderr,
      };
      writeFileSync(path.join(fakeBin, `${label}.child-result.private.json`), JSON.stringify(childReceipt, null, 2));
      console.error(JSON.stringify({ diagnostic: "pre-push child before log assertions", ...childReceipt }));
      assertNoTemporaryGateArtifacts(fakeBin, logName);
      return result;
    };
    const noPushFailure = invoke(
      { noPushExit: 17, nativeStderr: true, nativePreference: true },
      "ps-no-push-fail",
    );
    assert.equal(noPushFailure.status, 1);
    assert.match(`${noPushFailure.stdout}\n${noPushFailure.stderr}`, /exit 17/);
    assert.match(`${noPushFailure.stdout}\n${noPushFailure.stderr}`, /sentinel native stderr/);
    const secretFailure = invoke({ secretExit: 23 }, "ps-secret-fail");
    assert.equal(secretFailure.status, 1);
    assert.match(`${secretFailure.stdout}\n${secretFailure.stderr}`, /exit 23/);
    const planFailure = invoke({ planExit: 19 }, "ps-plan-fail");
    assert.equal(planFailure.status, 1);
    assert.match(`${planFailure.stdout}\n${planFailure.stderr}`, /exit 19/);
    const argsLog = path.join(fakeBin, "ps-args.log");
    const passing = invoke({ argsLog }, "ps-pass");
    assert.equal(passing.status, 0, passing.stderr);
    const observed = readFileSync(argsLog, "utf8");
    for (const script of ["scan-pre-push-secrets.mjs", "run-pre-push-tests.mjs"]) {
      const line = observed.split(/\r?\n/).find((entry) => entry.includes(script));
      assert.match(line ?? "", /--remote-name origin/);
      assert.match(line ?? "", /--remote-location trusted-location/);
    }

    const missingLocation = spawnSync(
      pwshCommand,
      ["-NoProfile", "-NonInteractive", "-File", fixtureCaller, "-RemoteName", "origin"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: isolatedEnv,
        input: update,
        windowsHide: true,
        shell: false,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.notEqual(missingLocation.status, 0);
    assert.match(`${missingLocation.stdout}\n${missingLocation.stderr}`, /RemoteLocation is required/);
  });
});

test("POSIX caller invokes the no-push gate, propagates failures, and passes after restore", {
  skip: !shCommand,
}, () => {
  withFakeTools((fakeBin) => {
    const update = `refs/heads/topic ${"a".repeat(40)} refs/heads/topic ${"0".repeat(40)}\n`;
    const invoke = (fakeExits, label) => {
      const logName = `${label}.log`;
      const logPath = path.join(fakeBin, logName);
      const result = spawnSync(shCommand, [shCaller, "origin", "trusted-location"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: fakeEnvironment(fakeBin, { ...fakeExits, logPath }),
        input: update,
        windowsHide: true,
        shell: false,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      assertNoTemporaryGateArtifacts(fakeBin, logName);
      return result;
    };
    const noPushFailure = invoke({ noPushExit: 17 }, "sh-no-push-fail");
    assert.equal(noPushFailure.status, 1);
    assert.match(`${noPushFailure.stdout}\n${noPushFailure.stderr}`, /exit 17/);
    const secretFailure = invoke({ secretExit: 23 }, "sh-secret-fail");
    assert.equal(secretFailure.status, 1);
    assert.match(`${secretFailure.stdout}\n${secretFailure.stderr}`, /exit 23/);
    const planFailure = invoke({ planExit: 19 }, "sh-plan-fail");
    assert.equal(planFailure.status, 1);
    assert.match(`${planFailure.stdout}\n${planFailure.stderr}`, /exit 19/);
    const signalFailure = invoke({ signalParent: "TERM" }, "sh-term-fail");
    assert.equal(signalFailure.status, 143);
    const argsLog = path.join(fakeBin, "sh-args.log");
    const passing = invoke({ argsLog }, "sh-pass");
    assert.equal(passing.status, 0, passing.stderr);
    const observed = readFileSync(argsLog, "utf8");
    for (const script of ["scan-pre-push-secrets.mjs", "run-pre-push-tests.mjs"]) {
      const line = observed.split(/\r?\n/).find((entry) => entry.includes(script));
      assert.match(line ?? "", /--remote-name origin/);
      assert.match(line ?? "", /--remote-location trusted-location/);
    }

    const missingLocation = spawnSync(shCommand, [shCaller, "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: fakeEnvironment(fakeBin),
      input: update,
      windowsHide: true,
      shell: false,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.notEqual(missingLocation.status, 0);
    assert.match(`${missingLocation.stdout}\n${missingLocation.stderr}`, /remote location/);
  });
});
