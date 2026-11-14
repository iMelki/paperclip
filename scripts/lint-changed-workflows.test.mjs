import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEphemeralDir, ephemeralChildEnv } from "./lib/ephemeral-scratch.mjs";

import {
  DOCKER_IMAGE_PROOF_TIMEOUT_MS,
  IMAGE_ASSIGNMENT,
  WorkflowLintError,
  extractNamedRunScripts,
  lintChangedWorkflows,
  parseWorkflowLintCli,
  proveDockerImageLowercase,
  resolveActionlintCommand,
  resolveExistingWorkflowFiles,
  runActionlint,
} from "./lint-changed-workflows.mjs";

const IMAGE_STEP = `      - name: Set GHCR image name
        run: |
          set -euo pipefail
          echo "IMAGE=ghcr.io/\${GITHUB_REPOSITORY,,}" >> "\$GITHUB_ENV"
`;

function dockerWorkflow({ jobs = 2, lowercase = true, unfolded = false } = {}) {
  const step = lowercase
    ? IMAGE_STEP
    : IMAGE_STEP.replaceAll("${GITHUB_REPOSITORY,,}", "${GITHUB_REPOSITORY}");
  const images = unfolded
    ? "ghcr.io/${{ github.repository }}"
    : "${{ env.IMAGE }}";
  const publishJobs = Array.from({ length: jobs }, (_, index) => {
    const name = index === 0 ? "build-and-push" : "build-and-push-cloud";
    return `  ${name}:
    steps:
${step}      - name: Docker meta
        with:
          images: ${images}
`;
  }).join("");
  return `name: Docker
jobs:
${publishJobs}`;
}

function withRepo(files, fn) {
  const repoRoot = createEphemeralDir({ owner: "paperclip", purpose: "workflowtest" });
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return fn(repoRoot);
  } finally {
    // Retain the synthetic fixture for inspection; no permanent deletion.
  }
}

const ACTIONLINT_MISSING_SKIP = "actionlint not installed on this host; no downloads allowed";

function existingActionlintBinary() {
  const configured = typeof process.env.PAPERCLIP_ACTIONLINT_BIN === "string"
    ? process.env.PAPERCLIP_ACTIONLINT_BIN.trim()
    : "";
  if (configured) {
    return existsSync(configured) ? configured : null;
  }
  const probed = spawnSync("sh", ["-c", "command -v actionlint"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!probed.error && probed.status === 0) {
    const found = (probed.stdout ?? "").trim();
    if (found) return found;
  }
  return null;
}

const ACTIONLINT_BIN = existingActionlintBinary();


test("parseWorkflowLintCli requires repeated --file values", () => {
  assert.deepEqual(parseWorkflowLintCli(["--file", ".github/workflows/docker.yml"]), [
    ".github/workflows/docker.yml",
  ]);
  assert.throws(() => parseWorkflowLintCli([]), /at least one --file is required/);
  assert.throws(() => parseWorkflowLintCli(["--repo-root", "."]), /unknown argument/);
});

test("resolveExistingWorkflowFiles skips deletions and rejects escapes", () => {
  withRepo({ ".github/workflows/docker.yml": "name: Docker\n" }, (repoRoot) => {
    assert.deepEqual(
      resolveExistingWorkflowFiles(repoRoot, [
        ".github/workflows/docker.yml",
        ".github/workflows/missing.yml",
      ]),
      [".github/workflows/docker.yml"],
    );
    assert.throws(
      () => resolveExistingWorkflowFiles(repoRoot, ["../docker.yml"]),
      /escapes the workflows directory/,
    );
  });
});

test("extractNamedRunScripts reads both docker.yml IMAGE steps", () => {
  const scripts = extractNamedRunScripts(dockerWorkflow(), "Set GHCR image name");
  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /GITHUB_REPOSITORY,,/);
});

test("proveDockerImageLowercase accepts the lowercase assignment and rejects unfolded or case-preserving forms", () => {
  proveDockerImageLowercase(dockerWorkflow());
  assert.throws(
    () => proveDockerImageLowercase(dockerWorkflow({ unfolded: true })),
    /must not use ghcr\.io\/\$\{\{ github\.repository \}\}/,
  );
  assert.throws(
    () => proveDockerImageLowercase(dockerWorkflow({ lowercase: false })),
    /must assign IMAGE with/,
  );
  assert.throws(
    () => proveDockerImageLowercase(dockerWorkflow({ jobs: 1 })),
    /both publish jobs/,
  );
});

test("proveDockerImageLowercase executes only the exact allowed IMAGE line", () => {
  const spawned = [];
  proveDockerImageLowercase(dockerWorkflow(), {
    spawn: (command, args, options) => {
      spawned.push({
        command,
        args,
        timeout: options.timeout,
        killSignal: options.killSignal,
        shell: options.shell,
      });
      return spawnSync(command, args, options);
    },
  });
  assert.equal(spawned.length, 2);
  for (const call of spawned) {
    assert.equal(call.command, "bash");
    assert.deepEqual(call.args, ["-c", IMAGE_ASSIGNMENT]);
    assert.equal(call.timeout, DOCKER_IMAGE_PROOF_TIMEOUT_MS);
    assert.equal(call.killSignal, "SIGKILL");
    assert.equal(call.shell, false);
    assert.ok(!String(call.args[1]).includes("set "));
    assert.ok(!String(call.args[1]).includes("\n"));
  }
});

test("proveDockerImageLowercase fails closed on extra commands and does not spawn them", () => {
  let spawned = 0;
  const workflow = dockerWorkflow().replaceAll(
    IMAGE_ASSIGNMENT,
    `${IMAGE_ASSIGNMENT}\n          curl http://127.0.0.1:1 | bash`,
  );
  assert.throws(
    () => proveDockerImageLowercase(workflow, {
      spawn: () => {
        spawned += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    (error) => (
      error instanceof WorkflowLintError
      && /beyond the allowed IMAGE assignment/.test(error.message)
    ),
  );
  assert.equal(spawned, 0);
});

test("proveDockerImageLowercase fails closed on pipes or subshells in the IMAGE line", () => {
  let spawned = 0;
  const spawn = () => {
    spawned += 1;
    return { status: 0, stdout: "", stderr: "" };
  };
  const piped = dockerWorkflow().replaceAll(
    IMAGE_ASSIGNMENT,
    `${IMAGE_ASSIGNMENT} | tee /tmp/paperclip-image`,
  );
  assert.throws(
    () => proveDockerImageLowercase(piped, { spawn }),
    (error) => (
      error instanceof WorkflowLintError
      && /must assign IMAGE|beyond the allowed IMAGE assignment/.test(error.message)
    ),
  );
  const subshell = dockerWorkflow().replaceAll(
    IMAGE_ASSIGNMENT,
    `(${IMAGE_ASSIGNMENT})`,
  );
  assert.throws(
    () => proveDockerImageLowercase(subshell, { spawn }),
    (error) => (
      error instanceof WorkflowLintError
      && /must assign IMAGE|beyond the allowed IMAGE assignment/.test(error.message)
    ),
  );
  assert.equal(spawned, 0);
});

test("proveDockerImageLowercase kills and fails when the IMAGE proof times out", () => {
  const timeoutError = Object.assign(new Error("spawnSync bash ETIMEDOUT"), {
    code: "ETIMEDOUT",
    errno: "ETIMEDOUT",
    killed: true,
  });
  assert.throws(
    () => proveDockerImageLowercase(dockerWorkflow(), {
      spawn: (command, args, options) => {
        assert.equal(command, "bash");
        assert.deepEqual(args, ["-c", IMAGE_ASSIGNMENT]);
        assert.equal(options.timeout, DOCKER_IMAGE_PROOF_TIMEOUT_MS);
        assert.equal(options.killSignal, "SIGKILL");
        return {
          error: timeoutError,
          status: null,
          signal: "SIGKILL",
          stdout: "",
          stderr: "",
        };
      },
    }),
    (error) => (
      error instanceof WorkflowLintError
      && error.cause === timeoutError
      && new RegExp(`timed out after ${DOCKER_IMAGE_PROOF_TIMEOUT_MS}ms and was killed`).test(error.message)
    ),
  );
});

test("proveDockerImageLowercase passes on the #262 IMAGE step and fails on current dev docker.yml", () => {
  // The #262 step is exactly `set -euo pipefail` plus the allowed IMAGE assignment.
  proveDockerImageLowercase(dockerWorkflow());
  const devWorkflow = `name: Docker
jobs:
  build-and-push:
      - name: Docker meta
        with:
          images: ghcr.io/\${{ github.repository }}
  build-and-push-cloud:
      - name: Docker meta (cloud)
        with:
          images: ghcr.io/\${{ github.repository }}
`;
  assert.throws(
    () => proveDockerImageLowercase(devWorkflow),
    /must not use ghcr\.io\/\$\{\{ github\.repository \}\}/,
  );
});

test("resolveActionlintCommand requires a checker on PATH or an explicit path", () => {
  assert.deepEqual(resolveActionlintCommand({}), {
    command: "actionlint",
    skipWhenMissing: false,
  });
  assert.deepEqual(resolveActionlintCommand({ PAPERCLIP_ACTIONLINT_BIN: "  " }), {
    command: "actionlint",
    skipWhenMissing: false,
  });
  assert.deepEqual(resolveActionlintCommand({ PAPERCLIP_ACTIONLINT_BIN: "/opt/actionlint" }), {
    command: "/opt/actionlint",
    skipWhenMissing: false,
  });
});

test("runActionlint fails closed for missing default and configured binaries", () => {
  assert.throws(() => runActionlint([".github/workflows/pr.yml"], {
    repoRoot: "/tmp",
    spawn: () => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }) }),
  }), error => error instanceof WorkflowLintError && error.exitCode === 2 && /actionlint was not found/.test(error.message));

  assert.throws(
    () => runActionlint([".github/workflows/docker.yml"], {
      repoRoot: "/tmp",
      command: "/opt/paperclip/actionlint",
      skipWhenMissing: false,
      spawn: () => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }) }),
    }),
    (error) => (
      error instanceof WorkflowLintError
      && error.exitCode === 2
      && /actionlint was not found/.test(error.message)
      && /does not download actionlint/.test(error.message)
      && !/https?:\/\//.test(error.message)
    ),
  );
  assert.throws(
    () => runActionlint([".github/workflows/docker.yml"], {
      repoRoot: "/tmp",
      command: "actionlint",
      skipWhenMissing: false,
      spawn: () => ({ status: 1, stdout: "docker.yml:1:1: syntax error\n", stderr: "" }),
    }),
    /syntax error/,
  );
});

test("the workflow linter does not download actionlint or publish images", () => {
  const source = readFileSync(new URL("./lint-changed-workflows.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(curl|wget|Invoke-WebRequest)\b/);
  assert.doesNotMatch(source, /actionlint\/releases/);
  assert.doesNotMatch(source, /\bdocker\s+push\b/);
  assert.doesNotMatch(source, /\bgh\s+workflow\b/);
});

test("lintChangedWorkflows runs actionlint then the docker IMAGE proof", () => {
  const commands = [];
  withRepo({ ".github/workflows/docker.yml": dockerWorkflow() }, (repoRoot) => {
    const status = lintChangedWorkflows([".github/workflows/docker.yml"], {
      repoRoot,
      actionlintCommand: "actionlint",
      skipMissingActionlint: false,
      spawn: (command, args, options) => {
        commands.push(command);
        if (command === "actionlint") {
          assert.deepEqual(args, ["-oneline", "-no-color", ".github/workflows/docker.yml"]);
          assert.equal(options.shell, false);
          return { status: 0, stdout: "", stderr: "" };
        }
        return spawnSync(command, args, options);
      },
      log: () => {},
    });
    assert.equal(status, 0);
    assert.deepEqual(commands, ["actionlint", "bash", "bash"]);
  });
});

test("lintChangedWorkflows skips a missing actionlint and still proves the docker IMAGE", () => {
  const commands = [];
  const logs = [];
  withRepo({ ".github/workflows/docker.yml": dockerWorkflow() }, (repoRoot) => {
    const status = lintChangedWorkflows([".github/workflows/docker.yml"], {
      repoRoot,
      actionlintCommand: "actionlint",
      skipMissingActionlint: true,
      spawn: (command, args, options) => {
        commands.push({ command, shell: options.shell });
        if (command === "actionlint") {
          return { error: Object.assign(new Error("not found"), { code: "ENOENT" }) };
        }
        return spawnSync(command, args, options);
      },
      log: (message) => logs.push(message),
    });
    assert.equal(status, 0);
    assert.deepEqual(commands, [
      { command: "actionlint", shell: false },
      { command: "bash", shell: false },
      { command: "bash", shell: false },
    ]);
    const output = logs.join("\n");
    assert.match(output, /SKIP: actionlint is not on PATH and PAPERCLIP_ACTIONLINT_BIN is unset/);
    assert.match(output, /does not download actionlint/);
    assert.match(output, /GHCR image name is lowercase/);
    assert.doesNotMatch(output, /actionlint passed/);
  });
});

test("runActionlint argv uses -oneline and -no-color and appends files", () => {
  let argv;
  const files = [".github/workflows/docker.yml", ".github/workflows/pr.yml"];
  runActionlint(files, {
    repoRoot: "/tmp",
    command: "actionlint",
    skipWhenMissing: false,
    spawn: (_command, args) => {
      argv = args;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(argv, ["-oneline", "-no-color", ...files]);
  assert.ok(!argv.includes("never"));
  assert.ok(!argv.includes("-color"));
  assert.equal(argv[0], "-oneline");
  assert.equal(argv[1], "-no-color");
  assert.deepEqual(argv.slice(2), files);
});

const VALID_WORKFLOW = `name: Valid
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

const INVALID_WORKFLOW = `name: Invalid
on: push
jobs:
  test: [
`;

test("runActionlint passes a valid workflow with the real binary", {
  skip: ACTIONLINT_BIN ? false : ACTIONLINT_MISSING_SKIP,
}, () => {
  withRepo({ ".github/workflows/valid.yml": VALID_WORKFLOW }, (repoRoot) => {
    const result = runActionlint([".github/workflows/valid.yml"], {
      repoRoot,
      command: ACTIONLINT_BIN,
      skipWhenMissing: false,
    });
    assert.deepEqual(result, { skipped: false });
  });
});

test("runActionlint fails an invalid workflow with the real binary", {
  skip: ACTIONLINT_BIN ? false : ACTIONLINT_MISSING_SKIP,
}, () => {
  withRepo({ ".github/workflows/invalid.yml": INVALID_WORKFLOW }, (repoRoot) => {
    assert.throws(
      () => runActionlint([".github/workflows/invalid.yml"], {
        repoRoot,
        command: ACTIONLINT_BIN,
        skipWhenMissing: false,
      }),
      (error) => (
        error instanceof WorkflowLintError
        && /actionlint failed with exit/.test(error.message)
      ),
    );
  });
});

test("runActionlint fails closed when the configured binary is missing", () => {
  const missing = path.join(
    os.tmpdir(),
    "paperclip-no-such-actionlint",
    "actionlint-missing-binary",
  );
  assert.equal(existsSync(missing), false);
  assert.throws(
    () => runActionlint([".github/workflows/docker.yml"], {
      repoRoot: "/tmp",
      command: missing,
      skipWhenMissing: false,
    }),
    (error) => (
      error instanceof WorkflowLintError
      && error.exitCode === 2
      && error.message.includes(`actionlint was not found at ${missing}`)
      && /does not download actionlint/.test(error.message)
      && !/https?:\/\//.test(error.message)
    ),
  );
});

function dockerJobsWithImageCounts(entries) {
  return "name: Docker\njobs:\n" + entries.map(([name, count]) =>
    `  ${name}:\n    steps:\n${count ? IMAGE_STEP.repeat(count) : "      - run: echo inert\n"}`
  ).join("");
}

for (const [name, entries] of [
  ["two assignments in standard and none in cloud", [["build-and-push", 2], ["build-and-push-cloud", 0]]],
  ["none in standard and two in cloud", [["build-and-push", 0], ["build-and-push-cloud", 2]]],
  ["unrelated job cannot cover the cloud job", [["build-and-push", 1], ["build-and-push-cloud", 0], ["unrelated", 1]]],
  ["duplicate assignment even when both jobs are present", [["build-and-push", 2], ["build-and-push-cloud", 1]]],
  ["duplicate publish job key", [["build-and-push", 1], ["build-and-push-cloud", 1], ["build-and-push", 0]]],
]) {
  test(`per-job proof rejects ${name} before any shell execution`, () => {
    let spawned = 0;
    assert.throws(() => proveDockerImageLowercase(dockerJobsWithImageCounts(entries), {
      spawn: (...args) => {
        spawned += 1;
        return spawnSync(...args);
      },
    }), /both publish jobs/);
    assert.equal(spawned, 0);
  });
}

test("per-job proof accepts one assignment in each publish job with CRLF", () => {
  proveDockerImageLowercase(
    dockerJobsWithImageCounts([["build-and-push", 1], ["build-and-push-cloud", 1]])
      .replaceAll("\n", "\r\n"),
  );
});

function workflowWithScalarDecoys({ nested = false, actual = false } = {}) {
  const decoy = nested
    ? "      - name: Inert\n        env:\n          DECOY: |\n            - name: Set GHCR image name\n              run: " + IMAGE_ASSIGNMENT + "\n        run: echo inert\n"
    : "    env:\n      DECOY: |\n        - name: Set GHCR image name\n          run: " + IMAGE_ASSIGNMENT + "\n";
  return "name: Docker\njobs:\n" + ["build-and-push", "build-and-push-cloud"].map((job) =>
    "  " + job + ":\n"
    + (nested ? "    steps:\n" + decoy : decoy + "    steps:\n")
    + (actual ? IMAGE_STEP : nested ? "" : "      - run: echo inert\n")
  ).join("");
}

for (const nested of [false, true]) {
  test("scalar decoys cannot stand in for IMAGE steps: " + (nested ? "step env" : "job env"), () => {
    let spawned = 0;
    assert.throws(() => proveDockerImageLowercase(workflowWithScalarDecoys({ nested }), {
      spawn: (...args) => { spawned += 1; return spawnSync(...args); },
    }), /both publish jobs/);
    assert.equal(spawned, 0);
  });
}

test("scalar decoys are ignored when each real job has its own IMAGE step", () => {
  proveDockerImageLowercase(workflowWithScalarDecoys({ actual: true }));
});

function workflowWithNamedStepRunDecoy({ validRun = false } = {}) {
  return "name: Docker\njobs:\n" + ["build-and-push", "build-and-push-cloud"].map((job) =>
    "  " + job + ":\n    steps:\n      - name: Set GHCR image name\n"
    + "        env:\n          DECOY: |\n            run: " + (validRun ? "echo inert" : IMAGE_ASSIGNMENT) + "\n"
    + "        run: " + (validRun ? IMAGE_ASSIGNMENT : "echo inert") + "\n"
  ).join("");
}

test("direct run property ignores an env scalar that contains a fake IMAGE run", () => {
  let spawned = 0;
  assert.throws(() => proveDockerImageLowercase(workflowWithNamedStepRunDecoy(), {
    spawn: (...args) => { spawned += 1; return spawnSync(...args); },
  }), /must assign IMAGE with/);
  assert.equal(spawned, 0);
});

test("direct run property accepts the real IMAGE run despite an env run decoy", () => {
  proveDockerImageLowercase(workflowWithNamedStepRunDecoy({ validRun: true }));
});


const workflowLintCli = new URL("./lint-changed-workflows.mjs", import.meta.url);
function runCliForTest(repoRoot, file, checker) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path" || key.toLowerCase() === "paperclip_actionlint_bin") delete env[key];
  env.PATH = repoRoot;
  Object.assign(env, ephemeralChildEnv(repoRoot));
  if (checker) env.PAPERCLIP_ACTIONLINT_BIN = checker;
  return spawnSync(process.execPath, [fileURLToPath(workflowLintCli), "--file", file], {
    cwd: repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15000,
  });
}
test("CLI rejects missing default PATH checker for a non-Docker workflow", () => {
  withRepo({ ".github/workflows/valid.yml": VALID_WORKFLOW }, repoRoot => {
    const result = runCliForTest(repoRoot, ".github/workflows/valid.yml");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /actionlint was not found/);
  });
});
test("CLI validates good and rejects invalid workflow with real checker", { skip: ACTIONLINT_BIN ? false : ACTIONLINT_MISSING_SKIP }, () => {
  withRepo({ ".github/workflows/valid.yml": VALID_WORKFLOW, ".github/workflows/invalid.yml": INVALID_WORKFLOW }, repoRoot => {
    const good = runCliForTest(repoRoot, ".github/workflows/valid.yml", ACTIONLINT_BIN);
    const bad = runCliForTest(repoRoot, ".github/workflows/invalid.yml", ACTIONLINT_BIN);
    assert.equal(good.status, 0);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /actionlint failed with exit/);
  });
});

for (const style of [">", ">-", ">+"]) {
  test(`folded IMAGE scalar ${style} is rejected before any Bash launch`, () => {
    let spawned = 0;
    const workflow = dockerWorkflow().replaceAll("run: |", `run: ${style}`);
    assert.throws(() => proveDockerImageLowercase(workflow, {
      spawn: () => { spawned += 1; return { status: 0, stdout: "", stderr: "" }; },
    }), /folded run scalars are not supported/);
    assert.equal(spawned, 0);
  });
}

for (const style of ["|", "|-", "|+"]) {
  test(`literal IMAGE scalar ${style} retains the allowed assignment proof`, () => {
    let spawned = 0;
    proveDockerImageLowercase(dockerWorkflow().replaceAll("run: |", `run: ${style}`), {
      spawn: (...args) => { spawned += 1; return spawnSync(...args); },
    });
    assert.equal(spawned, 2);
  });
}