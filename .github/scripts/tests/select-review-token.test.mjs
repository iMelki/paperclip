import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewToken } from '../select-review-token.mjs';

test('forks use the workflow token without an upstream App secret', () => {
  assert.deepEqual(selectReviewToken({
    isFork: 'true',
    githubToken: 'github-fixture',
  }), {
    source: 'github-token',
    value: 'github-fixture',
  });
});

test('non-forks retain the commitperclip App token', () => {
  assert.deepEqual(selectReviewToken({
    isFork: 'false',
    githubToken: 'github-fixture',
    commitperclipToken: 'app-fixture',
  }), {
    source: 'commitperclip-app',
    value: 'app-fixture',
  });
});

test('forks fail closed without the workflow token', () => {
  assert.throws(
    () => selectReviewToken({ isFork: 'true' }),
    /GITHUB_TOKEN is required/,
  );
});

test('non-forks fail closed without the App token', () => {
  assert.throws(
    () => selectReviewToken({ isFork: 'false', githubToken: 'github-fixture' }),
    /COMMITPERCLIP_TOKEN is required/,
  );
});

test('unknown repository topology fails closed', () => {
  assert.throws(
    () => selectReviewToken({ isFork: 'unknown', githubToken: 'github-fixture' }),
    /IS_FORK must be exactly/,
  );
});

test('tokens containing line breaks cannot reach GitHub outputs', () => {
  assert.throws(
    () => selectReviewToken({ isFork: 'true', githubToken: 'bad\ntoken' }),
    /must not contain line breaks/,
  );
});
