import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/commitperclip-review.yml", import.meta.url), "utf8");

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("fork repositories never require the upstream App private key", () => {
  assert.match(step("Generate commitperclip token"), /^        if: \$\{\{ !github\.event\.repository\.fork \}\}$/m);
});

test("both review gates select the workflow token for forks and the App token for upstream", () => {
  for (const name of ["Run quality gates", "Run security gates"]) {
    assert.match(step(name), /^          GH_TOKEN: \$\{\{ github\.event\.repository\.fork && github\.token \|\| steps\.token\.outputs\.value \}\}$/m);
  }
});

test("credential-handling scripts remain checked out from the trusted PR base", () => {
  const checkout = step("Checkout base branch (never PR code)");
  assert.match(checkout, /^          ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m);
  assert.match(checkout, /^          persist-credentials: false$/m);
  assert.doesNotMatch(workflow, /select-review-token\.mjs/);
});

test("Dependabot is refused before any token generation", () => {
  assert.ok(workflow.indexOf("- name: Refuse Dependabot PRs") < workflow.indexOf("- name: Generate commitperclip token"));
  const refusal = step("Refuse Dependabot PRs (read-only token, no gate signal)");
  assert.match(refusal, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  assert.match(refusal, /github\.actor == 'dependabot\[bot\]'/);
  assert.match(refusal, /exit 1/);
});
