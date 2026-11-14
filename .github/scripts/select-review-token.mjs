#!/usr/bin/env node
/**
 * Select the credential used by the trusted pull_request_target review.
 *
 * Upstream repositories keep the commitperclip GitHub App identity. Public
 * forks cannot inherit that App's private-key secret, so they use the
 * workflow-scoped GitHub token instead. Both paths fail closed when their
 * required credential is absent or unsafe to write to GITHUB_OUTPUT.
 */
import { fileURLToPath } from 'node:url';

function requireOutputSafeToken(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  if (/\r|\n/.test(value)) {
    throw new Error(`${name} must not contain line breaks.`);
  }
  return value;
}

export function selectReviewToken({ isFork, githubToken, commitperclipToken }) {
  if (isFork === 'true') {
    return {
      source: 'github-token',
      value: requireOutputSafeToken(githubToken, 'GITHUB_TOKEN'),
    };
  }

  if (isFork === 'false') {
    return {
      source: 'commitperclip-app',
      value: requireOutputSafeToken(commitperclipToken, 'COMMITPERCLIP_TOKEN'),
    };
  }

  throw new Error('IS_FORK must be exactly "true" or "false".');
}

function main() {
  const result = selectReviewToken({
    isFork: process.env.IS_FORK,
    githubToken: process.env.GITHUB_TOKEN,
    commitperclipToken: process.env.COMMITPERCLIP_TOKEN,
  });
  process.stdout.write(`source=${result.source}\nvalue=${result.value}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
