import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildComment, findExistingComment } from '../run-quality-gates.mjs';

const contributingUrl = new URL('../../../CONTRIBUTING.md', import.meta.url);

test('buildComment: routes clean PRs to CodeRabbit or the Cursor fallback', () => {
  const comment = buildComment('contributor', [], []);

  assert.match(comment, /CodeRabbit/);
  assert.match(comment, /Cursor when CodeRabbit is unavailable/);
  assert.doesNotMatch(comment, /Greptile/);
  assert.match(comment, /maintainer approval/);
});

test('contributor policy keeps Greptile optional and rejects mandatory 5/5 claims', async () => {
  const policy = await readFile(contributingUrl, 'utf8');

  assert.match(policy, /Greptile is optional\./);
  assert.match(policy, /If CodeRabbit is unavailable, use Cursor Bugbot or Cursor review/);
  assert.doesNotMatch(policy, /Greptile(?: score)? is 5\/5/i);
  assert.doesNotMatch(policy, /must achieve a \*\*5\/5 Greptile score\*\*/);
});

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});
