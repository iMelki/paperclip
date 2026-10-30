import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../../workflows/commitperclip-review.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');
const lines = workflow.split('\n').filter((line) => !line.trim().startsWith('#'));

test('commitperclip-review.yml never triggers on pull_request_target', () => {
  assert.ok(
    !lines.some((line) => line.includes('pull_request_target')),
    'commitperclip-review.yml must not use pull_request_target; use pull_request',
  );
});

test('commitperclip-review.yml triggers on pull_request', () => {
  assert.ok(
    lines.some((line) => /^\s{2}pull_request:\s*$/.test(line)),
    'commitperclip-review.yml must trigger on pull_request',
  );
});

test('commitperclip-review.yml only checks out the base sha', () => {
  assert.match(workflow, /^\s+ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/m);
  assert.ok(!/^\s+ref: \$\{\{ github\.event\.pull_request\.head\./m.test(workflow));
});

test('commitperclip-review.yml skips the secret token step for fork-head PRs', () => {
  const sameRepo = "github.event.pull_request.head.repo.full_name == github.repository";
  const tokenStep = workflow.split('- name: ').find((step) => step.startsWith('Generate commitperclip token'));
  assert.ok(tokenStep, 'token step present');
  assert.ok(tokenStep.includes(sameRepo), 'token step must be gated to same-repo PRs');
});

test('every uses: line in commitperclip-review.yml is pinned to a full sha', () => {
  for (const line of workflow.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l))) {
    assert.match(line, /@[0-9a-f]{40}(\s|$)/, line);
  }
});
