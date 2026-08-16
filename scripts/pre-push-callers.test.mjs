import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const psCaller = path.join(repoRoot, "scripts/pre-push-check.ps1");
const shCaller = path.join(repoRoot, "scripts/pre-push-check.sh");

function commandAvailable(command) {
  const args = command === "sh" ? ["-c", "exit 0"] : ["--version"];
  const result = spawnSync(command, args, { windowsHide: true, shell: false });
  return !result.error && result.status === 0;
}

const shCommand = [
  "sh",
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe")
    : null,
].filter(Boolean).find(commandAvailable);

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
    assert.match(caller, /git-path[\s'\"]+paperclip-gate-logs\/pre-push/);
    assert.doesNotMatch(caller, /\.local-logs\/pre-push/);
  }
  assert.match(hook, /-RemoteName "\$1" -RemoteLocation "\$2"/);
  assert.match(hook, /pre-push-check\.sh "\$@"/);
  assert.match(ps, /PSNativeCommandUseErrorActionPreference\s*=\s*\$false/);
  for (const signal of ["HUP", "INT", "TERM"]) {
    assert.match(sh, new RegExp(`trap 'exit \\d+' ${signal}`));
  }
});

test("PowerShell caller invokes the no-push gate, propagates failures, and passes after restore", {
  skip: !commandAvailable("pwsh"),
}, () => {
  withFakeTools((fakeBin) => {
    const update = `refs/heads/topic ${"a".repeat(40)} refs/heads/topic ${"0".repeat(40)}\n`;
    const invoke = (fakeExits, label) => {
      const logName = `${label}.log`;
      let commandArgs = [
        "-NoProfile",
        "-File",
        psCaller,
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
            `& '${quote(psCaller)}' -RemoteName 'origin' -RemoteLocation 'trusted-location' ` +
              `-LogPath '${quote(path.join(fakeBin, logName))}'`,
            "exit $LASTEXITCODE",
            "",
          ].join("\n"),
        );
        commandArgs = ["-NoProfile", "-File", wrapper];
      }
      const result = spawnSync(
        "pwsh",
        commandArgs,
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: fakeEnvironment(fakeBin, fakeExits),
          input: update,
          windowsHide: true,
          shell: false,
        },
      );
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
      "pwsh",
      ["-NoProfile", "-File", psCaller, "-RemoteName", "origin"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: fakeEnvironment(fakeBin),
        input: update,
        windowsHide: true,
        shell: false,
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
    });
    assert.notEqual(missingLocation.status, 0);
    assert.match(`${missingLocation.stdout}\n${missingLocation.stderr}`, /remote location/);
  });
});
