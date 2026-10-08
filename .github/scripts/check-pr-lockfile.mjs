#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch, prBase) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files, prAuthor, prBranch, prBase = '') {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && (
      prBranch === 'chore/refresh-lockfile' ||
      (prBase !== '' && prBranch === `chore/refresh-lockfile-${prBase}`)
    );

  return {
    passed: isRefreshBot,
    failures: isRefreshBot ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'Use the Refresh Lockfile workflow with the ref and base inputs set to the target branch.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(
    files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '', process.env.PR_BASE_REF ?? ''
  );
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
