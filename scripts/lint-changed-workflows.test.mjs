import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  const steps = Array.from({ length: jobs }, () => step).join("");
  return `name: Docker
jobs:
  build-and-push:
${steps}      - name: Docker meta
        with:
          images: ${images}
`;
}

function withRepo(files, fn) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-workflow-lint-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

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

test("resolveActionlintCommand skips only when PAPERCLIP_ACTIONLINT_BIN is unset", () => {
  assert.deepEqual(resolveActionlintCommand({}), {
    command: "actionlint",
    skipWhenMissing: true,
  });
  assert.deepEqual(resolveActionlintCommand({ PAPERCLIP_ACTIONLINT_BIN: "  " }), {
    command: "actionlint",
    skipWhenMissing: true,
  });
  assert.deepEqual(resolveActionlintCommand({ PAPERCLIP_ACTIONLINT_BIN: "/opt/actionlint" }), {
    command: "/opt/actionlint",
    skipWhenMissing: false,
  });
});

test("runActionlint skips a missing default binary and fails closed otherwise", () => {
  const logs = [];
  const skipped = runActionlint([".github/workflows/docker.yml"], {
    repoRoot: "/tmp",
    command: "actionlint",
    skipWhenMissing: true,
    log: (message) => logs.push(message),
    spawn: () => ({ error: Object.assign(new Error("not found"), { code: "ENOENT" }) }),
  });
  assert.deepEqual(skipped, { skipped: true });
  assert.match(logs.join("\n"), /SKIP: actionlint is not on PATH and PAPERCLIP_ACTIONLINT_BIN is unset/);
  assert.match(logs.join("\n"), /does not download actionlint/);

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
          assert.deepEqual(args, ["-oneline", "-color", "never", ".github/workflows/docker.yml"]);
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
