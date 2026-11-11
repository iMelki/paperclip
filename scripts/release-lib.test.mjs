import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function runPublishHelper({
  pnpmMode,
  npmVersionExists = false,
  distTag = "canary",
  callerPipefail = true,
  publishTool = "pnpm",
  waitForRegistry = false,
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-lib-"));
  const binDir = join(fixtureDir, "bin");
  const stateDir = join(fixtureDir, "state");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  writeFileSync(callLog, "");

  writeExecutable(
    join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$PNPM_MODE" in
  success)
    echo "published"
    exit 0
    ;;
  tlog-then-success)
    if [ ! -f "$FAKE_STATE_DIR/pnpm-called" ]; then
      touch "$FAKE_STATE_DIR/pnpm-called"
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
    fi
    case " $* " in
      *" --provenance=false "*)
        echo "published without provenance"
        exit 0
        ;;
      *)
        echo "retry did not disable provenance"
        exit 1
        ;;
    esac
    ;;
  tlog-always-fails)
    echo "npm error code TLOG_CREATE_ENTRY_ERROR"
    echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
    exit 1
    ;;
  non-tlog-failure)
    echo "npm error code E500"
    exit 1
    ;;
esac
exit 1
`,
  );

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [ "$1" = "view" ] && [ "$NPM_VERSION_EXISTS" = "true" ]; then
  echo "1.2.3"
  exit 0
fi
if [ "$1" = "publish" ]; then
  case "$PNPM_MODE" in
    success)
      echo "published"
      exit 0
      ;;
    tlog-then-success)
      if [ ! -f "$FAKE_STATE_DIR/npm-called" ]; then
        touch "$FAKE_STATE_DIR/npm-called"
        echo "npm error code TLOG_CREATE_ENTRY_ERROR"
        echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
        exit 1
      fi
      case " $* " in
        *" --provenance=false "*)
          echo "published without provenance"
          exit 0
          ;;
      esac
      ;;
    tlog-always-fails)
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
      ;;
    non-tlog-failure)
      echo "npm error code E500"
      exit 1
      ;;
  esac
fi
exit 1
`,
  );

  writeExecutable(
    join(binDir, "npx"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "$FAKE_CALL_LOG"
[ "$1" = "--yes" ] && shift
case "$1" in
  npm@10.9.7|npm@11.18.0) shift ;;
esac
exec npm "$@"
`,
  );

  const shellOptions = callerPipefail ? "set -euo pipefail" : "set -eu";
  const script = `
${shellOptions}
source "${repoRoot}/scripts/release-lib.sh"
${
  waitForRegistry
    ? `publish_package_to_npm_and_wait ${distTag} @paperclipai/example 1.2.3 ${publishTool} 1 0`
    : `publish_package_to_npm ${distTag} @paperclipai/example 1.2.3 ${publishTool}`
}
`;

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", ["-c", script], {
      cwd: fixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALL_LOG: callLog,
        FAKE_STATE_DIR: stateDir,
        NPM_VERSION_EXISTS: npmVersionExists ? "true" : "false",
        PNPM_MODE: pnpmMode,
        REPO_ROOT: fixtureDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  return {
    calls: readFileSync(callLog, "utf8"),
    output,
    status,
  };
}

test("publish_package_to_npm returns after a successful pnpm publish", () => {
  const result = runPublishHelper({ pnpmMode: "success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm uses trusted publishing from the bundled staging directory", () => {
  const result = runPublishHelper({ pnpmMode: "success", publishTool: "npm" });

  assert.equal(result.status, 0);
  assert.match(
    result.calls,
    /^npx --yes npm@11\.18\.0 publish --tag canary --access public --loglevel verbose$/m,
  );
  assert.match(
    result.calls,
    /^npm publish --tag canary --access public --loglevel verbose$/m,
  );
  assert.doesNotMatch(result.calls, / pack /);
  assert.doesNotMatch(result.calls, /^pnpm publish/m);
});

test("publish_package_to_npm retries bundled directory tlog failures without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success", publishTool: "npm" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^npm publish --tag canary --access public --provenance=false --loglevel verbose$/m,
  );
});

test("publish_package_to_npm retries duplicate tlog failures without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^pnpm publish --no-git-checks --tag canary --access public --provenance=false$/m,
  );
});

test("publish_package_to_npm treats a duplicate tlog failure as complete when npm exposes the version", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-always-fails", npmVersionExists: true });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry unrelated publish failures", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure" });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not mask failures when caller has no pipefail", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure", callerPipefail: false });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry stable publishes without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success", distTag: "latest" });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm_and_wait confirms registry visibility before returning", () => {
  const result = runPublishHelper({
    pnpmMode: "success",
    npmVersionExists: true,
    waitForRegistry: true,
  });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
});

test("publish_package_to_npm_and_wait blocks the release when registry visibility lags", () => {
  const result = runPublishHelper({ pnpmMode: "success", waitForRegistry: true });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(result.output, /did not become registry-visible/);
});

function runCanarySourceGuard({ preview = false, dryRun = false, branch = "topic", cliArgs = null } = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-canary-source-"));
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  writeFileSync(callLog, "");
  writeExecutable(join(binDir, "git"), "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'git %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"\n[ \"$#\" -eq 6 ] && [ \"$1\" = \"-C\" ] && [ \"$2\" = \"$REPO_ROOT\" ] && [ \"$3\" = \"symbolic-ref\" ] && [ \"$4\" = \"--quiet\" ] && [ \"$5\" = \"--short\" ] && [ \"$6\" = \"HEAD\" ]\nprintf '%s\\n' \"$FAKE_BRANCH\"\n");
  try {
    let args = ["-c", "set -euo pipefail\nsource \"$PAPERCLIP_GUARD_LIBRARY\"\nrequire_canary_source_branch \"$FAKE_PREVIEW\" \"$FAKE_DRY_RUN\"\n"];
    if (cliArgs) {
      const scriptsDir = join(fixtureDir, "scripts");
      mkdirSync(scriptsDir);
      for (const name of ["release.sh", "release-lib.sh"]) {
        writeFileSync(join(scriptsDir, name), readFileSync(join(repoRoot, "scripts", name)));
      }
      args = [join(scriptsDir, "release.sh"), ...cliArgs];
    }
    let status = 0;
    let output = "";
    try {
      output = execFileSync("bash", args, {
        cwd: fixtureDir, encoding: "utf8", timeout: 10_000, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: binDir + ":" + process.env.PATH, REPO_ROOT: fixtureDir,
          PAPERCLIP_GUARD_LIBRARY: join(repoRoot, "scripts/release-lib.sh"),
          FAKE_CALL_LOG: callLog, FAKE_BRANCH: branch,
          FAKE_PREVIEW: String(preview), FAKE_DRY_RUN: String(dryRun) },
      });
    } catch (error) {
      status = error.status ?? 1;
      output = String(error.stdout ?? "") + String(error.stderr ?? "");
    }
    return { status, output, calls: readFileSync(callLog, "utf8") };
  } finally {
    const owned = resolve(fixtureDir);
    if (!owned.startsWith(resolve(tmpdir()) + sep + "paperclip-canary-source-")) {
      throw new Error("Refusing cleanup outside the owned preview fixture");
    }
    rmSync(owned, { recursive: true, force: true });
  }
}

test("canary publication and default preview still require master", () => {
  assert.equal(runCanarySourceGuard({ branch: "master" }).status, 0);
  for (const dryRun of [false, true]) {
    const result = runCanarySourceGuard({ dryRun, branch: "topic" });
    assert.equal(result.status, 1);
    assert.match(result.output, /must run from branch master/);
    assert.match(result.calls, /symbolic-ref --quiet --short HEAD/);
  }
});

test("explicit canary dry-run preview accepts an existing topic or detached checkout", () => {
  for (const branch of ["topic", ""]) {
    const result = runCanarySourceGuard({ preview: true, dryRun: true, branch });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.calls, "");
  }
});

test("candidate preview never permits publishing even from master", () => {
  const result = runCanarySourceGuard({ preview: true, dryRun: false, branch: "master" });
  assert.equal(result.status, 1);
  assert.match(result.output, /never authorizes publishing/);
  assert.equal(result.calls, "");
});

for (const cliArgs of [
  ["canary", "--candidate-preview"],
  ["beta", "--dry-run", "--candidate-preview"],
  ["nightly", "--dry-run", "--candidate-preview"],
  ["stable", "--dry-run", "--candidate-preview"],
]) {
  test("release CLI rejects unsafe candidate-preview mode before Git or registry work: " + cliArgs.join(" "), () => {
    const result = runCanarySourceGuard({ cliArgs });
    assert.equal(result.status, 1);
    assert.match(result.output, /requires canary --dry-run/);
    assert.equal(result.calls, "");
  });
}
