#!/usr/bin/env node
/**
 * check-forbidden-tokens.mjs
 *
 * Scans the codebase for forbidden tokens before publishing to npm.
 * Mirrors the git pre-commit hook logic, but runs against the full
 * working tree (not just staged changes).
 *
 * Token list: .git/hooks/forbidden-tokens.txt (one per line, # comments ok).
 * If the file is missing, the check still uses the active local username when
 * available. Dynamic usernames match on word boundaries. Names shorter than 4
 * characters, and the generic account names agent, box, root, ubuntu, runner,
 * user, admin, and node, are not dynamic tokens. Private and tracked lists
 * stay literal substrings. If username detection fails, the check degrades
 * gracefully.
 *
 * CHECK_FORBIDDEN_TOKENS_IGNORE_USERNAMES is a per-machine setting for shared or
 * generic accounts only (#265). It holds exact account names (comma, semicolon,
 * or whitespace separated; case-insensitive; no wildcards). A listed name is not
 * used as a dynamic token. Private and tracked lists are not affected. Each run
 * that ignores a name prints a count-only warning on stderr.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import core from "./check-forbidden-tokens-core.cjs";

export const {
  readForbiddenTokensFile,
  resolveDynamicForbiddenTokens,
  resolveForbiddenTokens,
  resolveRepoPaths,
  runForbiddenTokenCheck,
} = core;

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  core.runCli();
}
