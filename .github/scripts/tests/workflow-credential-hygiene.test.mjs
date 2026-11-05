import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Policy for issue #235: every actions/checkout step sets
// persist-credentials: false, and every workflow has a top-level
// permissions block. Checkouts in jobs where a later step needs git auth
// are listed here with the reason.
const CHECKOUT_ALLOWLIST = new Map([
  ['release.yml:publish_canary', 'pushes the canary release tag with git push origin refs/tags/...'],
  ['release.yml:publish_stable', 'pushes the stable release tag with git push origin refs/tags/...'],
  ['refresh-lockfile.yml:refresh', 'commits the refreshed lockfile and runs git push to the bot branch'],
]);

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();

const indentOf = (line) => line.length - line.trimStart().length;

// Returns [{ file, job, lines }] for every actions/checkout step.
export function findCheckouts(file, text) {
  const lines = text.split('\n');
  const out = [];
  let inJobs = false;
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) inJobs = line.startsWith('jobs:');
    const jobMatch = inJobs && line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) job = jobMatch[1];
    const m = line.match(/^(\s*)(- )?uses:\s*actions\/checkout@/);
    if (!m) continue;
    // Step keys sit at this indent; the step ends at the next "- " at the
    // step-list indent or at anything shallower.
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    let start = i;
    while (start > 0 && !lines[start].trimStart().startsWith('- ')) start--;
    const listIndent = indentOf(lines[start]);
    let end = i + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() !== '' && (indentOf(l) < keyIndent || (indentOf(l) === listIndent && l.trimStart().startsWith('- ')))) break;
      end++;
    }
    out.push({ file, job, lines: lines.slice(start, end) });
  }
  return out;
}

const all = workflowFiles.map((file) => ({ file, text: readFileSync(join(workflowsDir, file), 'utf8') }));
const checkouts = all.flatMap(({ file, text }) => findCheckouts(file, text));

test('workflows directory has checkout steps to check', () => {
  assert.ok(checkouts.length > 0);
});

for (const { file, text } of all) {
  test(`${file} has a top-level permissions block`, () => {
    assert.match(text, /^permissions:/m, `${file} has no top-level permissions: block`);
  });
}

for (const c of checkouts) {
  const key = `${c.file}:${c.job}`;
  test(`checkout in ${key} sets persist-credentials: false or is allowlisted`, () => {
    if (CHECKOUT_ALLOWLIST.has(key)) return;
    assert.ok(
      c.lines.some((l) => /^\s*persist-credentials:\s*false\s*$/.test(l)),
      `${key}: actions/checkout must set persist-credentials: false (or add it to CHECKOUT_ALLOWLIST with a reason)`,
    );
  });
}

test('every allowlist entry matches a real checkout whose job runs git push', () => {
  for (const [key, reason] of CHECKOUT_ALLOWLIST) {
    assert.ok(reason.length > 0);
    const [file, job] = key.split(':');
    assert.ok(checkouts.some((c) => c.file === file && c.job === job), `${key} has no checkout; drop it from the allowlist`);
    const text = all.find((w) => w.file === file).text;
    const jobBody = text.split(new RegExp(`^  ${job}:\\s*$`, 'm'))[1].split(/^  [A-Za-z0-9_-]+:\s*$/m)[0];
    assert.match(jobBody, /git push/, `${key} no longer runs git push; drop it from the allowlist`);
  }
});
