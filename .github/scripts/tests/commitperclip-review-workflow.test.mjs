// Guards the commitperclip review workflow against losing the private
// security-advisory gate (dropped once during the #133 upstream sync).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, "../../workflows/commitperclip-review.yml");
const workflow = readFileSync(workflowPath, "utf8");

test("grants security-events: write so the gate can open private draft advisories", () => {
  assert.match(workflow, /^permissions:\n(?:  .+\n)*  security-events: write\n/m);
});

test("runs the security gate script with the bot token and PR context", () => {
  const step = workflow.match(/- name: Run security gates\n([\s\S]*?)(?=\n      - name: |\n?$)/);
  assert.ok(step, "Run security gates step is missing");
  const body = step[1];
  assert.match(body, /run: node \.github\/scripts\/check-pr-security\.mjs/);
  assert.match(body, /GH_TOKEN: \$\{\{ steps\.token\.outputs\.value \}\}/);
  assert.match(body, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(body, /timeout-minutes: 3/);
});

test("runs the security gate before the quality-gate failure step", () => {
  const gate = workflow.indexOf("- name: Run security gates");
  const fail = workflow.indexOf("- name: Fail if quality gates failed");
  assert.ok(gate > 0 && fail > gate);
});

test("pins every action to a full commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) {
    assert.match(ref, /^[^@\s]+@[0-9a-f]{40}$/, `not SHA-pinned: ${ref}`);
  }
});
