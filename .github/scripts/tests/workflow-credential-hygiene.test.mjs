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
  ['release.yml:publish_nightly', 'pushes the nightly release tag with git push origin refs/tags/...'],
  ['release.yml:publish_beta', 'pushes the beta release tag with git push origin refs/tags/...'],
  ['release.yml:draft_stable_notes', 'force-pushes the machine-owned release-notes branch with git push -f origin'],
  ['release.yml:publish_stable', 'pushes the stable release tag with git push origin refs/tags/...'],
  ['release.yml:canonicalize_stable_notes', 'force-pushes the canonicalization branch with git push -f origin'],
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

// Manual E2E keeps its existing opt-in provider behavior, but installation,
// build and the default skip-LLM step must not receive the provider key.
// These are structural regression checks for this workflow, not a YAML parser
// or proof of runner isolation / provider availability.
function manualE2EStep(text, name) {
  const marker = '      - name: ' + name + '\n';
  assert.equal(text.split(marker).length - 1, 1, 'expected one ' + name + ' step');
  const start = text.indexOf(marker);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/^      - /m);
  return marker + (next === -1 ? rest : rest.slice(0, next));
}

function assertManualE2ESecretBoundary(text) {
  assert.match(text, /^  workflow_dispatch:\n    inputs:\n      skip_llm:\n        description: [^\n]+\n        type: boolean\n        default: true$/m);
  const defaultStep = manualE2EStep(text, 'Run e2e tests without provider credentials');
  const optInStep = manualE2EStep(text, 'Run e2e tests with explicit LLM opt-in');
  assert.match(defaultStep, /^        if: \$\{\{ inputs\.skip_llm \}\}$/m);
  assert.match(optInStep, /^        if: \$\{\{ !inputs\.skip_llm \}\}$/m);
  for (const step of [defaultStep, optInStep]) {
    assert.match(step, /^        run: pnpm run test:e2e$/m);
    assert.match(step, /^          PAPERCLIP_PLAYWRIGHT_CHANNEL: "chrome"$/m);
  }
  assert.match(optInStep, /^        env:\n          ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}$/m);
  assert.doesNotMatch(text.replace(optInStep, ''), /ANTHROPIC_API_KEY/);
  assert.equal((text.match(/secrets\.ANTHROPIC_API_KEY/g) ?? []).length, 1);
  // The input remains the job's existing skip flag; this change only narrows
  // secret delivery, and does not claim every test consumes that flag.
  assert.match(text, /^      PAPERCLIP_E2E_SKIP_LLM: \$\{\{ inputs\.skip_llm && 'true' \|\| 'false' \}\}$/m);
}

const manualE2EWorkflow = all.find(({ file }) => file === 'e2e.yml').text;

test('manual E2E provides the provider key only to the explicit LLM opt-in step', () => {
  assertManualE2ESecretBoundary(manualE2EWorkflow);
});

const e2eBoundaryRegressions = [
  ['default opt-in', '        default: true', '        default: false'],
  ['job-level key', '    env:\n', '    env:\n      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n'],
  ['setup-step key', '      - run: pnpm build', '      - run: pnpm build\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'],
  ['default-step key', '      - name: Run e2e tests without provider credentials\n        if: ${{ inputs.skip_llm }}\n        env:\n', '      - name: Run e2e tests without provider credentials\n        if: ${{ inputs.skip_llm }}\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n'],
  ['unguarded opt-in', '        if: ${{ !inputs.skip_llm }}\n', ''],
  ['always opt-in', '        if: ${{ !inputs.skip_llm }}', '        if: ${{ always() }}'],
  ['reversed default', '        if: ${{ inputs.skip_llm }}', '        if: ${{ !inputs.skip_llm }}'],
  ['removed opt-in command', '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n          PAPERCLIP_PLAYWRIGHT_CHANNEL: "chrome"\n        run: pnpm run test:e2e', '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n          PAPERCLIP_PLAYWRIGHT_CHANNEL: "chrome"\n        run: echo skipped'],
];

for (const [label, before, after] of e2eBoundaryRegressions) {
  test('manual E2E secret boundary rejects ' + label, () => {
    const broken = manualE2EWorkflow.replace(before, after);
    assert.notEqual(broken, manualE2EWorkflow, 'negative fixture must change actual workflow');
    assert.throws(() => assertManualE2ESecretBoundary(broken), assert.AssertionError);
  });
}
