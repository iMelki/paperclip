import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkForkDependencyPolicy,
  DEPENDENCY_APPROVAL_LABEL,
  isDependencyBearingPath,
} from '../check-fork-dependency-policy.mjs';

test('isDependencyBearingPath covers manifests, locks, and package patches', () => {
  for (const path of [
    'package.json',
    'packages/ui/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches/react.patch',
  ]) {
    assert.equal(isDependencyBearingPath(path), true, path);
  }
  assert.equal(isDependencyBearingPath('ui/src/App.tsx'), false);
});

test('passes when a PR does not change dependency-bearing files', () => {
  assert.deepEqual(checkForkDependencyPolicy([
    { filename: 'ui/src/App.tsx', status: 'modified' },
  ]), {
    passed: true,
    dependencyFiles: [],
    approvalLabel: DEPENDENCY_APPROVAL_LABEL,
  });
});

test('fails closed when a dependency-bearing file changes without approval', () => {
  const result = checkForkDependencyPolicy([
    { filename: 'packages/shared/package.json', status: 'modified' },
  ]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.dependencyFiles, ['packages/shared/package.json']);
  assert.match(result.reason, /dependency-review-approved/);
});

test('passes a dependency change only with the trusted approval label', () => {
  const result = checkForkDependencyPolicy(
    [{ filename: 'pnpm-lock.yaml', status: 'modified' }],
    [{ name: DEPENDENCY_APPROVAL_LABEL }],
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.dependencyFiles, ['pnpm-lock.yaml']);
});
