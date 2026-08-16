import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePrWorkflowTrigger } from "./check-pr-workflow-trigger.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");

test("the real PR workflow covers master and dev without a push event", () => {
  assert.deepEqual(validatePrWorkflowTrigger(realWorkflow), []);
});

test("the policy job must run the stable Vitest runner regression suite", () => {
  const broken = realWorkflow.replace(
    "./scripts/__tests__/run-vitest-stable-shard.test.mjs",
    "./scripts/__tests__/removed-stable-shard.test.mjs",
  );
  assert.notEqual(broken, realWorkflow, "negative fixture must remove the shard regression suite");
  assert.ok(
    validatePrWorkflowTrigger(broken).includes(
      "workflow policy tests are missing ./scripts/__tests__/run-vitest-stable-shard.test.mjs",
    ),
  );
});

test("removing dev fails for the exact missing-branch reason", () => {
  const broken = realWorkflow.replace(/^\s{6}- dev\s*$/m, "");
  assert.notEqual(broken, realWorkflow, "negative fixture must remove dev");
  assert.deepEqual(validatePrWorkflowTrigger(broken), ["pull_request.branches is missing dev"]);
});

test("adding a push event fails even when pull-request coverage remains", () => {
  const broken = realWorkflow.replace(/^on:\s*$/m, "on:\n  push:\n    branches:\n      - dev");
  assert.notEqual(broken, realWorkflow, "negative fixture must add push:dev");
  assert.ok(
    validatePrWorkflowTrigger(broken).includes(
      "workflow must not define a push event; dev validation is pull-request-only",
    ),
  );
});

test("a column-zero comment cannot hide a later event in the on block", () => {
  const broken = realWorkflow.replace(
    /^concurrency:\s*$/m,
    "# This comment does not close the on mapping.\n  push:\n    branches:\n      - dev\nconcurrency:",
  );
  assert.notEqual(broken, realWorkflow, "negative fixture must add a push after a comment");
  assert.ok(
    validatePrWorkflowTrigger(broken).includes(
      "workflow must not define a push event; dev validation is pull-request-only",
    ),
  );
});

test("quoted or whitespace-padded push keys cannot bypass the no-push policy", () => {
  for (const pushKey of ['"push":', "'push':", "push :"]) {
    const broken = realWorkflow.replace(/^on:\s*$/m, `on:\n  ${pushKey}\n    branches:\n      - dev`);
    assert.notEqual(broken, realWorkflow, `negative fixture must add ${pushKey}`);
    assert.ok(
      validatePrWorkflowTrigger(broken).includes(
        "workflow must not define a push event; dev validation is pull-request-only",
      ),
    );
  }
});

test("escaped and duplicate YAML keys fail closed instead of overriding the checked mapping", () => {
  const escapedPush = realWorkflow.replace(
    /^on:\s*$/m,
    'on:\n  "pu\\u0073h":\n    branches:\n      - dev',
  );
  const escapedFailures = validatePrWorkflowTrigger(escapedPush);
  assert.ok(
    escapedFailures.some((failure) => failure.includes("unsupported, encoded, or inline mapping key")),
    escapedFailures.join("\n"),
  );

  const duplicateEvent = realWorkflow.replace(
    /^  pull_request:\s*$/m,
    "  pull_request:\n    branches:\n      - master\n      - dev\n  pull_request:",
  );
  assert.ok(
    validatePrWorkflowTrigger(duplicateEvent).includes(
      "workflow must define exactly one plain pull_request event",
    ),
  );

  const duplicateBranches = realWorkflow.replace(
    /^    branches:\s*$/m,
    "    branches:\n      - master\n      - dev\n    branches:",
  );
  assert.ok(
    validatePrWorkflowTrigger(duplicateBranches).includes(
      "pull_request must define exactly one plain branches list",
    ),
  );

  const duplicateOn = `${realWorkflow}\non:\n  pull_request:\n    branches:\n      - master\n      - dev\n`;
  assert.ok(
    validatePrWorkflowTrigger(duplicateOn).includes(
      "workflow must define exactly one plain top-level on block",
    ),
  );

  const escapedOn = realWorkflow.replace(/^on:\s*$/m, '"o\\u006e":');
  const escapedOnFailures = validatePrWorkflowTrigger(escapedOn);
  assert.ok(
    escapedOnFailures.some((failure) => failure.includes("encoded top-level mapping key")),
    escapedOnFailures.join("\n"),
  );
});

test("the exact secret range and gate regression list cannot be removed", () => {
  const noRange = realWorkflow.replace(
    '"${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}"',
    "--history",
  );
  assert.notEqual(noRange, realWorkflow, "negative fixture must replace the exact range");
  const rangeFailures = validatePrWorkflowTrigger(noRange);
  assert.ok(rangeFailures.includes("workflow must scan the exact pull-request base.sha..head.sha range"));
  assert.ok(rangeFailures.includes("workflow must not use the known-red complete-history secret scan"));

  const missingTest = realWorkflow.replace("./scripts/run-pre-push-tests.test.mjs", "");
  assert.notEqual(missingTest, realWorkflow, "negative fixture must remove a gate regression");
  assert.ok(
    validatePrWorkflowTrigger(missingTest).includes(
      "workflow policy tests are missing ./scripts/run-pre-push-tests.test.mjs",
    ),
  );
});

test("required policy tests may be reordered and split across unmasked node steps", () => {
  const reordered = realWorkflow
    .replace("./scripts/check-no-git-push-source.test.mjs", "__SOURCE_TEST__")
    .replace("./scripts/check-no-git-push.test.mjs", "./scripts/check-no-git-push-source.test.mjs")
    .replace("__SOURCE_TEST__", "./scripts/check-no-git-push.test.mjs");
  const regrouped = reordered
    .replace(/^\s{10}\.\/scripts\/git-push-scan-integrity\.test\.mjs\r?$/m, "")
    .replace(
      /^      - name: Validate PR workflow trigger policy\r?$/m,
      "      - name: Test scan integrity independently\n" +
        "        run: node --test ./scripts/git-push-scan-integrity.test.mjs\n\n" +
        "      - name: Validate PR workflow trigger policy",
    );
  assert.notEqual(regrouped, realWorkflow, "fixture must reorder and regroup policy tests");
  assert.deepEqual(validatePrWorkflowTrigger(regrouped), []);
});

test("comments, conditional steps, and masked test commands cannot impersonate active gates", () => {
  const commentedRange = realWorkflow.replace(
    /^\s{10}node scripts\/verify-gitleaks\.mjs --range$/m,
    "          # node scripts/verify-gitleaks.mjs --range",
  );
  assert.ok(
    validatePrWorkflowTrigger(commentedRange).includes(
      "workflow must scan the exact pull-request base.sha..head.sha range",
    ),
  );

  const conditionalRange = realWorkflow.replace(
    /^        run: >-\s*$/m,
    "        if: false\n        run: >-",
  );
  assert.ok(
    validatePrWorkflowTrigger(conditionalRange).includes(
      "workflow must scan the exact pull-request base.sha..head.sha range",
    ),
  );

  const commentedTest = realWorkflow.replace(
    "          ./scripts/run-pre-push-tests.test.mjs",
    "          # ./scripts/run-pre-push-tests.test.mjs",
  );
  assert.ok(
    validatePrWorkflowTrigger(commentedTest).includes(
      "workflow policy tests are missing ./scripts/run-pre-push-tests.test.mjs",
    ),
  );

  const maskedTest = realWorkflow.replace(
    "          ./scripts/run-pre-push-tests.test.mjs",
    "          ./scripts/run-pre-push-tests.test.mjs||true",
  );
  const maskedFailures = validatePrWorkflowTrigger(maskedTest);
  assert.ok(
    maskedFailures.includes(
      "workflow policy tests are missing ./scripts/run-pre-push-tests.test.mjs",
    ),
    maskedFailures.join("\n"),
  );

  const duplicateRun = realWorkflow.replace(
    /^        run: >-\s*$/m,
    '        run: >-\n          node scripts/verify-gitleaks.mjs --range\n          "${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}"\n        "run": echo skipped',
  );
  assert.ok(
    validatePrWorkflowTrigger(duplicateRun).includes(
      "workflow must scan the exact pull-request base.sha..head.sha range",
    ),
  );
});

test("job defaults, continue-on-error, custom shells, and missing validations fail closed", () => {
  for (const maskingConfig of [
    "    continue-on-error: true",
    "    defaults:\n      run:\n        shell: bash {0} || true",
  ]) {
    const broken = realWorkflow.replace(/^  policy:\s*$/m, `  policy:\n${maskingConfig}`);
    assert.ok(
      validatePrWorkflowTrigger(broken).includes(
        "policy job must run unconditionally without custom defaults",
      ),
    );
  }

  const hostileSecretShell = realWorkflow.replace(
    /^        run: >-\s*$/m,
    "        shell: bash {0} || true\n        run: >-",
  );
  assert.ok(
    validatePrWorkflowTrigger(hostileSecretShell).includes(
      "workflow must scan the exact pull-request base.sha..head.sha range",
    ),
  );

  const hostileTestShell = realWorkflow.replace(
    "        run: node --test ./scripts/check-pr-workflow-trigger.test.mjs",
    "        shell: bash {0} || true\n        run: node --test ./scripts/check-pr-workflow-trigger.test.mjs",
  );
  assert.ok(
    validatePrWorkflowTrigger(hostileTestShell).includes(
      "workflow policy tests are missing ./scripts/check-pr-workflow-trigger.test.mjs",
    ),
  );

  for (const hostileStepConfig of [
    "        working-directory: ./shadow-policy",
    "        env:\n          NODE_OPTIONS: --require=./shadow-policy.cjs",
  ]) {
    const broken = realWorkflow.replace(
      "        run: node ./scripts/check-no-git-push.mjs",
      `${hostileStepConfig}\n        run: node ./scripts/check-no-git-push.mjs`,
    );
    assert.notEqual(broken, realWorkflow, "negative fixture must add hostile step execution context");
    assert.ok(
      validatePrWorkflowTrigger(broken).includes(
        "workflow policy validation is missing active command: node ./scripts/check-no-git-push.mjs",
      ),
      hostileStepConfig,
    );
  }

  for (const opener of ["if: false", "continue-on-error: true", "shell: bash"]) {
    const broken = realWorkflow.replace(
      "      - name: Validate PR workflow trigger policy",
      `      - ${opener}`,
    );
    assert.notEqual(broken, realWorkflow, `negative fixture must put ${opener} on the step opener`);
    assert.ok(
      validatePrWorkflowTrigger(broken).includes(
        "workflow policy validation is missing active command: node ./scripts/check-pr-workflow-trigger.mjs",
      ),
      `expected opener ${opener} to mask the required command`,
    );
  }

  const missingValidation = realWorkflow.replace(
    "        run: node ./scripts/check-no-git-push.mjs",
    "        run: echo skipped",
  );
  assert.ok(
    validatePrWorkflowTrigger(missingValidation).includes(
      "workflow policy validation is missing active command: node ./scripts/check-no-git-push.mjs",
    ),
  );
});

test("global and required-job execution context cannot replace the validated tools", () => {
  for (const topLevelConfig of [
    "env:\n  NODE_OPTIONS: --require=./shadow-policy.cjs\n",
    "defaults:\n  run:\n    working-directory: ./shadow-policy\n",
  ]) {
    const broken = realWorkflow.replace(/^jobs:\s*$/m, `${topLevelConfig}\njobs:`);
    assert.notEqual(broken, realWorkflow, "negative fixture must inject top-level execution context");
    assert.ok(
      validatePrWorkflowTrigger(broken).some((failure) =>
        failure.startsWith("workflow must not define top-level")),
      topLevelConfig,
    );
  }

  for (const { job, hostileConfig } of [
    { job: "secret-scan", hostileConfig: "    env:\n      NODE_OPTIONS: --require=./shadow-secret.cjs" },
    { job: "policy", hostileConfig: "    container: attacker.invalid/policy:latest" },
    { job: "policy", hostileConfig: "    services:\n      node:\n        image: attacker.invalid/node:latest" },
  ]) {
    const broken = realWorkflow.replace(new RegExp(`^  ${job}:\\s*$`, "m"), `  ${job}:\n${hostileConfig}`);
    assert.notEqual(broken, realWorkflow, `negative fixture must inject ${job} execution context`);
    assert.ok(
      validatePrWorkflowTrigger(broken).some((failure) =>
        failure.startsWith(`${job} job contains unsupported execution keys:`)),
      hostileConfig,
    );
  }

  const selfHosted = realWorkflow.replace(
    /^(  secret-scan:[\s\S]*?)^    runs-on: ubuntu-latest$/m,
    "$1    runs-on: self-hosted",
  );
  assert.notEqual(selfHosted, realWorkflow, "negative fixture must replace the secret-scan runner");
  assert.ok(
    validatePrWorkflowTrigger(selfHosted).includes(
      "secret-scan job must run exactly once on ubuntu-latest",
    ),
  );

  const duplicateRunner = realWorkflow.replace(
    /^(  secret-scan:[\s\S]*?^    runs-on: ubuntu-latest)$/m,
    "$1\n    runs-on: self-hosted",
  );
  assert.notEqual(duplicateRunner, realWorkflow, "negative fixture must duplicate a job key");
  assert.ok(
    validatePrWorkflowTrigger(duplicateRunner).includes(
      "secret-scan job must not define duplicate keys: runs-on",
    ),
  );

  const missingSecretDependency = realWorkflow.replace(
    "    needs: [secret-scan]",
    "    needs: [build]",
  );
  assert.notEqual(
    missingSecretDependency,
    realWorkflow,
    "negative fixture must replace the policy dependency",
  );
  assert.ok(
    validatePrWorkflowTrigger(missingSecretDependency).includes(
      "policy job must depend exactly on secret-scan",
    ),
  );
});
