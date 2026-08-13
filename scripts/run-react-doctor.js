import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MIN_SCORE = 95;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const uiDir = path.resolve(repoRoot, "ui");

/**
 * Git exports `GIT_DIR` (and `GIT_INDEX_FILE`) to every hook, but deliberately
 * does not export `GIT_WORK_TREE`. When `GIT_DIR` is set and `GIT_WORK_TREE` is
 * not, Git treats the *current working directory* as the top of the work tree.
 * We run React Doctor with `cwd: ui/`, so inside a pre-commit hook Git decides
 * the repository root is `ui/` instead of the real root. Every tracked path then
 * reads as deleted, the root `.gitignore` falls outside the mis-detected work
 * tree, and `ui/node_modules/**` turns into hundreds of untracked `package.json`
 * / `tsconfig.json` entries. React Doctor's `--staged` pre-flight sees those as
 * config divergence and aborts with "Cannot scan staged files while
 * configuration differs between the index and worktree" — a false positive that
 * only ever reproduces inside the hook, never standalone.
 *
 * Pinning `GIT_WORK_TREE` to the real repository root makes the child see the
 * same repository the hook is committing to. `GIT_DIR` and `GIT_INDEX_FILE` are
 * left untouched, so React Doctor still reads the authoritative staged index
 * (including the temporary index Git builds for `git commit -a`). This keeps the
 * divergence gate fully armed: a genuine index/worktree config mismatch still
 * fails the commit.
 */
const childEnv = { ...process.env };
if (childEnv.GIT_DIR && !childEnv.GIT_WORK_TREE) {
  childEnv.GIT_WORK_TREE = repoRoot.replace(/\\/g, "/");
}

console.log("Running React Doctor for Paperclip UI...");

const result = spawnSync("npx", ["-y", "react-doctor@latest", "--staged"], {
  cwd: uiDir,
  env: childEnv,
  maxBuffer: MAX_BUFFER_BYTES,
  stdio: ["inherit", "pipe", "pipe"],
  shell: true,
});

if (result.error) {
  console.error("Failed to start React Doctor:", result.error);
  process.exit(1);
}

const stdout = result.stdout ? result.stdout.toString() : "";
const stderr = result.stderr ? result.stderr.toString() : "";
const output = [stdout, stderr].filter(Boolean).join("\n");
const normalizedOutput = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

process.stdout.write(stdout);
process.stderr.write(stderr);

if (/No staged source files found\./i.test(normalizedOutput)) {
  console.log("\nReact Doctor skipped: no staged UI source files.");
  process.exit(0);
}

const scoreMatch = normalizedOutput.match(/(\d+)\s*\/\s*100/);
if (!scoreMatch) {
  console.error("\nCould not determine React Doctor score from output.");
  process.exit(1);
}

const score = parseInt(scoreMatch[1], 10);
console.log(`\nReact Doctor Score: ${score}/100`);

if (score < MIN_SCORE) {
  console.error(`\nReact Doctor score is too low (${score} < ${MIN_SCORE}).`);
  console.error("Please fix the reported issues before committing.");
  process.exit(1);
}

if (result.status === null) {
  const reason = result.signal ? `signal ${result.signal}` : "unknown termination";
  console.error(`\nReact Doctor exited unexpectedly (${reason}).`);
  process.exit(1);
}

process.exit(result.status ?? 1);