import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

for (const base of ['dev', 'master', 'release/stable']) {
  test(`passes for the refresh bot with a branch matching base ${base}`, () => {
    assert.equal(checkLockfile(
      makeFiles(['pnpm-lock.yaml']), 'github-actions[bot]', `chore/refresh-lockfile-${base}`, base
    ).passed, true);
  });
}

for (const [author, branch, base] of [
  ['someuser', 'chore/refresh-lockfile-dev', 'dev'],
  ['github-actions[bot]', 'chore/refresh-lockfile-master', 'dev'],
  ['github-actions[bot]', 'chore/refresh-lockfile-dev-extra', 'dev'],
  ['github-actions[bot]', 'chore/refresh-lockfile-dev', ''],
]) {
  test(`rejects refresh branch ${branch} for ${author} on base ${base || '(missing)'}`, () => {
    const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), author, branch, base);
    assert.equal(result.passed, false);
    assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
  });
}
