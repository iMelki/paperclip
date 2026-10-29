// End-to-end run of check-pr-security.mjs with a stubbed GitHub API in which
// the draft-advisory POST returns 403 "Resource not accessible by integration",
// as it does for the workflow GITHUB_TOKEN on a fork. The flags must still be
// listed in the job log and in the security-review check run, the matched
// secret text must never be printed, and the script must exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../check-pr-security.mjs', import.meta.url));

// The stub replaces globalThis.fetch before the script loads. It records each
// request as one JSON line in the capture file.
const STUB_SOURCE = `
import { appendFileSync } from 'node:fs';
const capturePath = process.env.FAKE_GH_CAPTURE;
const prFiles = JSON.parse(process.env.FAKE_GH_FILES);
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const path = u.pathname;
  appendFileSync(capturePath, JSON.stringify({ method, path, body: init.body ?? null }) + '\\n');
  const reply = (status, value) => new Response(JSON.stringify(value), { status });
  if (path.includes('/contents/')) return reply(200, {});
  if (/\\/pulls\\/\\d+\\/files$/.test(path)) return reply(200, u.searchParams.get('page') === '1' ? prFiles : []);
  if (/\\/pulls\\/\\d+$/.test(path)) {
    return reply(200, { number: 4242, title: 'Stub PR', head: { sha: 'feedface' }, base: { ref: 'dev' } });
  }
  if (path.endsWith('/security-advisories') && method === 'GET') return reply(200, []);
  if (path.endsWith('/security-advisories') && method === 'POST') {
    return reply(403, { message: 'Resource not accessible by integration' });
  }
  if (path.endsWith('/check-runs') && method === 'POST') return reply(201, { id: 1 });
  return reply(404, { message: 'Not Found' });
};
`;

function runScriptWithStub(prFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-security-403-'));
  try {
    const stubPath = join(dir, 'stub-fetch.mjs');
    const capturePath = join(dir, 'capture.jsonl');
    writeFileSync(stubPath, STUB_SOURCE);
    writeFileSync(capturePath, '');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stubPath).href, SCRIPT], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        GH_TOKEN: 'stub-token',
        GH_REPO: 'example/repo',
        PR_NUMBER: '4242',
        FAKE_GH_CAPTURE: capturePath,
        FAKE_GH_FILES: JSON.stringify(prFiles),
      },
    });
    const requests = readFileSync(capturePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, requests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('advisory POST 403: flags are still listed in the log and the check run, without the secret text', () => {
  // Built at run time so no secret-shaped literal is in this file.
  const sentinel = 'SENTINEL'.repeat(3);
  const prFiles = [
    { filename: '.github/workflows/pr.yml', status: 'modified', patch: '+ on: push' },
    { filename: 'src/config.ts', status: 'modified', patch: `+const apiToken = "${sentinel}"` },
    { filename: 'server/src/routes/agents.ts', status: 'modified', patch: '+// change' },
  ];
  const expected = [
    'ci-tampering .github/workflows/pr.yml',
    'secret-scan src/config.ts (pattern: High-entropy secret)',
    'sensitive-path server/src/routes/agents.ts',
  ];

  const run = runScriptWithStub(prFiles);
  const output = `${run.stdout}\n${run.stderr}`;

  for (const description of expected) {
    assert.ok(
      run.stderr.includes(`[security]   - ${description}`),
      `job log must list "${description}"; stderr was:\n${run.stderr}`,
    );
  }
  assert.ok(!output.includes(sentinel), 'job log must never contain the matched secret text');

  const advisoryPost = run.requests.find(r => r.method === 'POST' && r.path.endsWith('/security-advisories'));
  assert.ok(advisoryPost, 'the script must still try to file the draft advisory');

  const checkRun = run.requests.find(r => r.method === 'POST' && r.path.endsWith('/check-runs'));
  assert.ok(checkRun, 'the security-review check run must be posted after the advisory 403');
  const body = JSON.parse(checkRun.body);
  assert.equal(body.name, 'security-review');
  assert.equal(body.conclusion, 'neutral');
  for (const description of expected) {
    assert.ok(body.output.summary.includes(description), `check-run summary must list "${description}"`);
  }
  assert.match(body.output.summary, /could not be filed/);
  assert.ok(!checkRun.body.includes(sentinel), 'check-run body must never contain the matched secret text');

  assert.equal(run.status, 0, `script must keep its exit-0 contract; stderr was:\n${run.stderr}`);
});

test('no flags: the check run passes and nothing calls the advisory API', () => {
  const run = runScriptWithStub([{ filename: 'README.md', status: 'modified', patch: '+docs' }]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.requests.some(r => r.path.includes('/security-advisories')));
  const checkRun = run.requests.find(r => r.method === 'POST' && r.path.endsWith('/check-runs'));
  assert.equal(JSON.parse(checkRun.body).conclusion, 'success');
});
