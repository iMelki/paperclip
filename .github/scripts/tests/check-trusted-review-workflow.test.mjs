import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTrustedReviewWorkflow,
  createPolicyContract,
  verifyPolicyContract,
} from '../check-trusted-review-workflow.mjs';

const workflowPath = fileURLToPath(new URL('../../workflows/commitperclip-review.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const policyPaths = [
  '.github/scripts/check-fork-dependency-policy.mjs',
  '.github/scripts/fetch-pr-files.mjs',
  '.github/scripts/get-bot-token.mjs',
];
const trustedPolicySources = Object.fromEntries(policyPaths.map((path) => [
  path,
  readFileSync(new URL(`../../../${path}`, import.meta.url)),
]));

function mustReject(mutated, expectedReason) {
  const result = checkTrustedReviewWorkflow(mutated);
  assert.equal(result.passed, false, 'mutated workflow must fail the contract');
  assert.ok(result.errors.some((reason) => expectedReason.test(reason)), result.errors.join('\n'));
}

test('accepts the trusted checkout and unmasked contract-check ordering', () => {
  assert.deepEqual(checkTrustedReviewWorkflow(workflow), { passed: true, errors: [] });
});

test('accepts an identical base-ref policy contract', () => {
  const contract = createPolicyContract(trustedPolicySources);
  assert.deepEqual(Object.keys(contract.files).sort(), [...policyPaths].sort());
  assert.deepEqual(verifyPolicyContract(contract, trustedPolicySources), { passed: true, errors: [] });
});

test('rejects drift in every file in the base-ref policy closure', () => {
  const contract = createPolicyContract(trustedPolicySources);
  for (const path of policyPaths) {
    const drifted = {
      ...trustedPolicySources,
      [path]: Buffer.from(`${trustedPolicySources[path]}\n// drift fixture\n`),
    };
    const result = verifyPolicyContract(contract, drifted);
    assert.equal(result.passed, false, `${path} drift must be rejected`);
    assert.ok(result.errors[0].includes(path), result.errors[0]);
  }
});

test('rejects an incomplete or malformed trusted policy contract', () => {
  const result = verifyPolicyContract({ version: 1, files: {} }, trustedPolicySources);
  assert.equal(result.passed, false);
  assert.match(result.errors[0], /incomplete shape/);
});

test('rejects checking out pull request head code', () => {
  mustReject(
    workflow.replace('${{ github.workflow_sha }}', '${{ github.event.pull_request.head.sha }}'),
    /first checkout ref/,
  );
});

test('rejects checkout from an explicit fork repository', () => {
  const forkRepository = workflow.replace(
    '          ref: ${{ github.workflow_sha }}',
    '          repository: ${{ github.event.pull_request.head.repo.full_name }}\n          ref: ${{ github.workflow_sha }}',
  );
  mustReject(forkRepository, /trusted current repository/);
});

test('rejects a merge ref in place of the trusted pull request base SHA', () => {
  mustReject(
    workflow.replace('${{ github.event.pull_request.base.sha }}', 'refs/pull/${{ github.event.pull_request.number }}/merge'),
    /second checkout ref/,
  );
});

test('rejects a missing base checkout', () => {
  const missingBaseCheckout = workflow.replace(
    /\n      - name: Checkout trusted pull request base[\s\S]*?(?=\n      - name: Dependency Review)/,
    '',
  );
  mustReject(missingBaseCheckout, /exactly two checkout steps/);
});

test('rejects an extra checkout step', () => {
  const extraCheckout = workflow.replace(
    '      - name: Set up Node\n',
    '      - name: Unexpected checkout\n        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n        with:\n          ref: ${{ github.workflow_sha }}\n\n      - name: Set up Node\n',
  );
  mustReject(extraCheckout, /exactly two checkout steps/);
});

test('rejects an inline extra checkout step', () => {
  const extraInlineCheckout = workflow.replace(
    '      - name: Set up Node\n',
    '      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n        with:\n          ref: ${{ github.workflow_sha }}\n      - name: Set up Node\n',
  );
  mustReject(extraInlineCheckout, /exactly two checkout steps/);
});

test('rejects a mutable checkout action tag', () => {
  mustReject(
    workflow.replace('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', 'actions/checkout@v7'),
    /full commit SHA/,
  );
});

test('rejects a checker masked on fork pull requests', () => {
  const maskedChecker = workflow.replace(
    '      - name: Verify trusted workflow and record policy contract\n        id: policy-contract\n        run:',
    '      - name: Verify trusted workflow and record policy contract\n        id: policy-contract\n        if: ${{ !github.event.repository.fork }}\n        run:',
  );
  mustReject(maskedChecker, /conditionally skipped/);
});

test('rejects a missing base-ref policy parity check', () => {
  const missingParity = workflow.replace(
    /\n      - name: Verify base policy matches trusted contract\n[\s\S]*?(?=\n      - name: Dependency Review)/,
    '',
  );
  mustReject(missingParity, /verify the base-ref policy/);
});

test('rejects a base policy parity check masked on forks', () => {
  const maskedParity = workflow.replace(
    '      - name: Verify base policy matches trusted contract\n        run:',
    '      - name: Verify base policy matches trusted contract\n        if: ${{ !github.event.repository.fork }}\n        run:',
  );
  mustReject(maskedParity, /conditionally skipped/);
});

test('rejects a fork dependency gate disabled or run for non-forks', () => {
  const disabledForkPolicy = workflow.replace(
    'if: ${{ github.event.repository.fork }}\n        run: node .github/scripts/check-fork-dependency-policy.mjs',
    'if: ${{ !github.event.repository.fork }}\n        run: node .github/scripts/check-fork-dependency-policy.mjs',
  );
  mustReject(disabledForkPolicy, /enabled only for fork/);
});

test('rejects a job-level fork condition that skips the trusted gate', () => {
  const forkSkippedJob = workflow.replace(
    '  review:\n    runs-on: ubuntu-latest\n',
    '  review:\n    if: ${{ !github.event.repository.fork }}\n    runs-on: ubuntu-latest\n',
  );
  mustReject(forkSkippedJob, /review job must not be conditionally skipped/);
});

test('rejects a contract check configured to continue after failure', () => {
  for (const value of ['true', '${{ github.event.repository.fork }}']) {
    const ignoredFailure = workflow.replace(
      '        run: node .github/scripts/check-trusted-review-workflow.mjs --record-policy-contract "$RUNNER_TEMP"\n',
      `        run: node .github/scripts/check-trusted-review-workflow.mjs --record-policy-contract "$RUNNER_TEMP"\n        continue-on-error: ${value}\n`,
    );
    mustReject(ignoredFailure, /must not allow errors to continue/);
  }
  const quotedKey = workflow.replace(
    '        run: node .github/scripts/check-trusted-review-workflow.mjs --record-policy-contract "$RUNNER_TEMP"\n',
    '        run: node .github/scripts/check-trusted-review-workflow.mjs --record-policy-contract "$RUNNER_TEMP"\n        "continue-on-error": false\n',
  );
  mustReject(quotedKey, /must not allow errors to continue/);
});

test('rejects a base policy verification configured to continue after failure', () => {
  const ignoredFailure = workflow.replace(
    '        run: node "${{ steps.policy-contract.outputs.contract_dir }}/check-trusted-review-workflow.mjs" --verify-policy-contract "${{ steps.policy-contract.outputs.contract_dir }}/policy-contract.json"\n',
    '        run: node "${{ steps.policy-contract.outputs.contract_dir }}/check-trusted-review-workflow.mjs" --verify-policy-contract "${{ steps.policy-contract.outputs.contract_dir }}/policy-contract.json"\n        continue-on-error: ${{ github.event.repository.fork }}\n',
  );
  mustReject(ignoredFailure, /base policy contract verification must not allow errors to continue/);
});

test('rejects a broader GitHub token permission set', () => {
  const broaderPermissions = workflow.replace('  contents: read\n', '  contents: write\n');
  mustReject(broaderPermissions, /least-privilege set/);
});
