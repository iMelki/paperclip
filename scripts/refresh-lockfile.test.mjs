import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/refresh-lockfile.yml', import.meta.url), 'utf8');
const prWorkflow = readFileSync(new URL('../.github/workflows/pr.yml', import.meta.url), 'utf8');
const bash = process.env.BASH_BIN || 'bash';
const baseExpression = workflow.match(/BASE: \$\{\{ (.+) \}\}/)?.[1];
const refExpression = workflow.match(/ref: \$\{\{ (.+) \}\}/)?.[1];
const prs = [
  { headRefName: 'chore/refresh-lockfile-dev', baseRefName: 'master', owner: 'example', id: 1 },
  { headRefName: 'chore/refresh-lockfile-master', baseRefName: 'dev', owner: 'example', id: 2 },
  { headRefName: 'chore/refresh-lockfile-dev', baseRefName: 'dev', owner: 'other-owner', id: 3 },
  { headRefName: 'chore/refresh-lockfile-dev', baseRefName: 'dev', owner: 'example', id: 4 },
].map(({ owner, id, ...pr }) => ({
  ...pr, headRepositoryOwner: { login: owner }, url: `https://github.com/example/paperclip/pull/${id}`,
}));

function step(source, name) {
  const marker = `      - name: ${name}\n`;
  assert.ok(source.includes(marker), `missing workflow step: ${name}`);
  return source.split(marker)[1].split('\n      - name:')[0];
}

function shell(name) {
  const body = step(workflow, name).split('        run: |\n')[1];
  assert.ok(body, `missing shell body: ${name}`);
  return body.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
}

function resolve(expression, inputs = {}, github = {}) {
  assert.ok(expression, 'missing workflow expression');
  return runInNewContext(expression, { inputs, github }, { timeout: 1000 });
}

// Execute the actual workflow shell with writes intercepted by Bash functions.
// jq evaluates the actual owner filter; no GitHub call or git mutation is made.
const stubs = `
log_call() { { printf '%s' "$1"; shift; printf '\\t%s' "$@"; printf '\\n'; } >> "$TEST_TRACE"; }
git() {
  log_call git "$@"
  case "$1" in
    diff) return "$TEST_CHANGED" ;;
    status) printf '%s' "$TEST_STATUS" ;;
    check-ref-format) command git "$@" ;;
  esac
}
gh() {
  log_call gh "$@"
  local operation="$2" head="" base="" query="."
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head) head="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --jq) query="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "$operation" = list ]; then
    printf '%s' "$TEST_PRS" | jq --arg head "$head" --arg base "$base" \\
      '[.[] | select(($head == "" or .headRefName == $head) and ($base == "" or .baseRefName == $base))]' | \\
      jq -r "$query"
  elif [ "$operation" = create ]; then
    cat > "$TEST_BODY"
    printf '%s\\n' 'https://github.com/example/paperclip/pull/5'
  else
    return 99
  fi
}
`;

function dryRun(name, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'refresh-lockfile-'));
  const tracePath = path.join(root, 'trace.tsv');
  const outputPath = path.join(root, 'output.txt');
  writeFileSync(tracePath, '');
  writeFileSync(outputPath, '');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail'], {
    input: `${stubs}\n${shell(name)}`,
    encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env, BASE: options.base || 'dev', REPO_OWNER: 'example',
      GITHUB_OUTPUT: outputPath, TEST_TRACE: tracePath, TEST_BODY: path.join(root, 'body.md'),
      TEST_PRS: JSON.stringify(options.prs ?? prs), TEST_CHANGED: String(options.changed ?? 1),
      TEST_STATUS: options.status || '',
    },
  });
  assert.ifError(result.error);
  return {
    ...result, trace: readFileSync(tracePath, 'utf8'), output: readFileSync(outputPath, 'utf8'),
  };
}

test('manual inputs default to dev; the push trigger remains master only', () => {
  for (const name of ['ref', 'base']) {
    assert.match(workflow, new RegExp(`      ${name}:\\n(?:.*\\n)*?        default: dev\\n        type: string`));
  }
  assert.match(workflow, /push:\n    branches:\n      - master\n  workflow_dispatch:/);
  assert.equal(resolve(baseExpression, { base: 'dev' }), 'dev');
  assert.equal(resolve(refExpression, { ref: 'dev' }), 'dev');
  assert.equal(resolve(baseExpression), 'master');
  assert.equal(resolve(refExpression, {}, { sha: 'push-commit-sha' }), 'push-commit-sha');
});

test('checkout ref can differ from the base; concurrency is separated by base', () => {
  assert.equal(resolve(refExpression, { ref: 'agent/example/patch', base: 'dev' }), 'agent/example/patch');
  assert.equal(resolve(baseExpression, { ref: 'agent/example/patch', base: 'dev' }), 'dev');
  const group = workflow.match(/group: refresh-lockfile-\$\{\{ (.+) \}\}/)?.[1];
  assert.equal(resolve(group, { base: 'dev' }), 'dev');
  assert.equal(resolve(group), 'master');
});

test('dev refresh reuses only the matching head, base and repository owner', () => {
  const result = dryRun('Create or update pull request');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /git\tpush\t--force\torigin\tchore\/refresh-lockfile-dev/);
  assert.match(result.trace, /gh\tpr\tlist.*\t--head\tchore\/refresh-lockfile-dev\t--base\tdev/);
  assert.doesNotMatch(result.trace, /gh\tpr\tcreate/);
  assert.match(result.output, /pr_url=https:\/\/github.com\/example\/paperclip\/pull\/4/);
});

test('wrong-base, wrong-head and fork PRs cannot prevent creating a dev PR', () => {
  const result = dryRun('Create or update pull request', { prs: prs.slice(0, 3) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /gh\tpr\tcreate\t--head\tchore\/refresh-lockfile-dev\t--base\tdev/);
  assert.match(result.trace, /--body-file\t-/);
  assert.match(result.output, /pull\/5/);
});

test('master refresh still pushes and creates a PR targeting master', () => {
  const result = dryRun('Create or update pull request', { base: 'master', prs: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /git\tpush\t--force\torigin\tchore\/refresh-lockfile-master/);
  assert.match(result.trace, /gh\tpr\tcreate\t--head\tchore\/refresh-lockfile-master\t--base\tmaster/);
});

test('unchanged lockfile performs no push or PR operation', () => {
  const result = dryRun('Create or update pull request', { changed: 0 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.trace, /git\tpush|gh\tpr/);
  assert.equal(result.output, 'pr_url=\n');
});

test('invalid per-base branch is rejected before commit or push', () => {
  const result = dryRun('Create or update pull request', { base: 'invalid base' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a valid branch name/);
  assert.doesNotMatch(result.trace, /git\tcommit|git\tpush|gh\tpr/);
});

test('the existing file-change gate permits only a lockfile refresh', () => {
  const clean = dryRun('Fail on unexpected file changes', { status: ' M pnpm-lock.yaml\n' });
  assert.equal(clean.status, 0, clean.stderr);
  const broken = dryRun('Fail on unexpected file changes', {
    status: ' M pnpm-lock.yaml\n M package.json\n',
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /Unexpected files changed during lockfile refresh:[\s\S]*package.json/);
});

test('auto-merge remains master-only and requires a PR URL', () => {
  const condition = step(workflow, 'Enable auto-merge for lockfile PR').match(/if: (.+)/)?.[1];
  assert.ok(condition?.includes("env.BASE == 'master'"), 'dev refresh must not enable auto-merge');
  for (const [base, url, expected] of [['dev', 'url', false], ['master', 'url', true], ['master', '', false]]) {
    const value = runInNewContext(condition.replaceAll('upsert-pr', 'upsertPr'), {
      env: { BASE: base }, steps: { upsertPr: { outputs: { pr_url: url } } },
    });
    assert.equal(value, expected);
  }
});

test('PR policy accepts the exact bot branch and rejects mismatched base or author', () => {
  const condition = step(prWorkflow, 'Block manual lockfile edits')
    .split('        if: >-\n')[1].split('        run:')[0].trim();
  for (const [author, head, base, blocked] of [
    ['github-actions[bot]', 'chore/refresh-lockfile-dev', 'dev', false],
    ['github-actions[bot]', 'chore/refresh-lockfile-master', 'master', false],
    ['github-actions[bot]', 'chore/refresh-lockfile-master', 'dev', true],
    ['example', 'chore/refresh-lockfile-dev', 'dev', true],
    ['github-actions[bot]', 'chore/refresh-lockfile-dev-extra', 'dev', true],
    ['example', 'chore/refresh-lockfile', 'master', false],
    ['dependabot[bot]', 'dependabot/pkg', 'dev', false],
  ]) {
    const value = runInNewContext(condition, {
      github: { head_ref: head, base_ref: base, event: { pull_request: { user: { login: author } } } },
      format: (pattern, value) => pattern.replace('{0}', value),
    });
    assert.equal(value, blocked, `${author} ${head} -> ${base}`);
  }
});
