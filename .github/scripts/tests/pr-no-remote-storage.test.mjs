import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../../workflows/pr.yml", import.meta.url), "utf8");
const eligibility = "github.repository != '' && github.repository != 'iMelki/paperclip' && toJSON(github.event.repository.fork) == 'false'";
const jobNames = ["secret-scan", "policy", "typecheck_release_registry", "general_tests",
  "daytona_plugin_tests", "verify", "build", "verify_serialized_server", "canary_dry_run", "e2e_shards", "e2e"];
const steps = (text) => text.split(/(?=^      - name: )/m).slice(1)
  .map((block) => block.split(/^  [\w-]+:\s*$/m)[0]);
const condition = (step) => step.match(/^        if: (.+)$/m)?.[1].trim();

function validate(text) {
  const errors = [];
  const blocks = steps(text);
  const nodes = blocks.filter((step) => /uses: actions\/setup-node@/.test(step));
  if (nodes.length !== 8 || nodes.some((step) => !/^          package-manager-cache: false\s*$/m.test(step))) {
    errors.push("every setup-node step must disable automatic caching");
  }
  if (/^\s+cache:|uses: actions\/cache(?:\/|@)/m.test(text)) errors.push("explicit remote cache is forbidden");
  const storage = blocks.filter((step) => /uses: actions\/(upload|download)-artifact@/.test(step));
  if (storage.length !== 9) errors.push("expected nine explicitly guarded storage steps");
  for (const step of storage) {
    const guard = condition(step);
    const suffix = step.includes("download-artifact@")
      ? " && needs.policy.outputs.lockfile_regenerated == '1'"
      : step.includes("name: pr-lockfile") ? " && steps.regen_lockfile.outputs.regenerated == '1'" : "";
    const prefix = step.includes("Upload Playwright report") ? "always() && " : "";
    if (guard !== prefix + eligibility + suffix) errors.push("storage needs a positive typed non-fork guard");
    if (/continue-on-error:/.test(step)) errors.push("required lock transfer cannot ignore a missing artifact");
  }
  const jobs = [...text.matchAll(/^  ([\w-]+):\s*$/gm)].map((m) => m[1]).filter((name) => name !== "pull_request");
  if (JSON.stringify(jobs) !== JSON.stringify(jobNames)) errors.push("validation jobs changed");
  const runners = [...text.matchAll(/^    runs-on: (.+)$/gm)].map((m) => m[1].trim());
  if (runners.length !== 11 || runners.some((runner) => runner !== "ubuntu-latest")) errors.push("only standard ubuntu runners allowed");
  if ((text.match(/run: pnpm install --frozen-lockfile\s*$/gm) ?? []).length !== 6) errors.push("frozen installs must remain active");
  for (const command of ["pnpm run typecheck:build-gaps", "pnpm run test:release-registry",
    "pnpm test:run:general", "pnpm test:run:serialized", "pnpm build", "pnpm run test:e2e $specs",
    "./scripts/release.sh canary --skip-verify --dry-run"]) {
    if (!text.includes(command)) errors.push(`missing validation command: ${command}`);
  }
  const regen = blocks.find((step) => step.includes("id: regen_lockfile")) ?? "";
  if (!regen.includes(`ALLOW_REMOTE_LOCKFILE: \u0024{{ ${eligibility} }}`)) errors.push("regeneration permission must use the same typed guard");
  for (const required of ["set -euo pipefail", "git ls-files --error-unmatch pnpm-lock.yaml",
    "if ! git diff --exit-code -- pnpm-lock.yaml; then", "Commit the canonical pnpm 9.15.4 lockfile before retrying",
    'echo "regenerated=0" >> "$GITHUB_OUTPUT"']) {
    if (!regen.includes(required)) errors.push(`missing committed-lock requirement: ${required}`);
  }
  return errors;
}

// Evaluate only the small expression subset actually used by these nine guards.
// This is an inert fixture evaluation, not a claim to run GitHub's expression engine.
function evaluate(expression, repository, fork, regenerated = "1") {
  const replacements = new Map([
    ["toJSON(github.event.repository.fork)", JSON.stringify(fork ?? null)],
    ["github.repository", repository],
    ["needs.policy.outputs.lockfile_regenerated", regenerated],
    ["steps.regen_lockfile.outputs.regenerated", regenerated],
  ]);
  let source = expression.replaceAll("always()", "true");
  for (const [key, value] of replacements) source = source.replaceAll(key, JSON.stringify(String(value).toLowerCase()));
  source = source.replace(/'[^']*'/g, (literal) => literal.toLowerCase());
  const grammar = source.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  assert.match(grammar, /^[\s"&|!=()true]+$/, "unrecognized expression syntax");
  source = source.replaceAll("!=", "!==").replace(/(?<!!)==/g, "===");
  return vm.runInNewContext(source, Object.create(null), { timeout: 50 });
}

test("real workflow disables fork storage while retaining validation", () => {
  assert.deepEqual(validate(workflow), []);
});

for (const [label, edit, expected] of [
  ["automatic caching", (s) => s.replace("package-manager-cache: false", "package-manager-cache: true"), "every setup-node"],
  ["explicit cache", (s) => s.replace("package-manager-cache: false", "cache: pnpm"), "explicit remote cache"],
  ["loose fork metadata", (s) => s.replaceAll("toJSON(github.event.repository.fork) == 'false'", "!github.event.repository.fork"), "positive typed"],
  ["missing artifact fallback", (s) => s.replace("uses: actions/download-artifact@", "continue-on-error: true\n        uses: actions/download-artifact@"), "cannot ignore"],
  ["missing lock comparison", (s) => s.replace("if ! git diff --exit-code -- pnpm-lock.yaml; then", "if false; then"), "committed-lock"],
  ["missing frozen install", (s) => s.replace("run: pnpm install --frozen-lockfile", "run: pnpm install"), "frozen installs"],
  ["larger runner", (s) => s.replace("runs-on: ubuntu-latest", "runs-on: larger-runner"), "standard ubuntu"],
]) {
  test(`negative control rejects ${label}`, () => {
    const broken = edit(workflow);
    assert.notEqual(broken, workflow);
    assert.ok(validate(broken).some((error) => error.includes(expected)));
  });
}

for (const fork of [true, false, null, undefined, "", "false", "true", 0, 1, [], {}]) {
  test(`owned fork and malformed metadata never permit storage: ${JSON.stringify(fork)}`, () => {
    for (const step of steps(workflow).filter((s) => /uses: actions\/(upload|download)-artifact@/.test(s))) {
      assert.equal(evaluate(condition(step), "iMelki/paperclip", fork), false);
      assert.equal(evaluate(condition(step), "", fork), false);
      assert.equal(evaluate(condition(step), "upstream/paperclip", fork), fork === false);
    }
  });
}

test("non-fork lock transfer requires a successful regenerated-lock output", () => {
  for (const step of steps(workflow).filter((s) => /uses: actions\/(upload|download)-artifact@/.test(s) && s.includes("name: pr-lockfile"))) {
    for (const output of ["0", "", "false"]) assert.equal(evaluate(condition(step), "upstream/paperclip", false, output), false);
  }
});

const regenStep = steps(workflow).find((step) => step.includes("id: regen_lockfile"));
const regenScript = regenStep.split("        run: |\n")[1]?.split(/\n      #/)[0]
  .split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n")
  .replaceAll("${{ github.event.pull_request.base.sha }}", "base")
  .replaceAll("${{ github.event.pull_request.head.sha }}", "head");

for (const [name, allow, drift, tracked, installExit, expected] of [
  ["committed canonical lock", "false", "0", "0", "0", 0],
  ["uncommitted lock regeneration", "false", "1", "0", "0", 1],
  ["unknown permission", "", "1", "0", "0", 1],
  ["untracked lock", "false", "0", "1", "0", 1],
  ["failed dependency resolution", "false", "0", "0", "7", 7],
  ["explicit non-fork transfer", "true", "1", "0", "0", 0],
]) {
  test(`actual regeneration shell with inert commands: ${name}`, () => {
    assert.ok(regenScript?.includes("pnpm install --lockfile-only"));
    const fixture = mkdtempSync(path.join(tmpdir(), "paperclip-pr-storage-"));
    const output = path.join(fixture, "github-output");
    const mock = 'git() { if [ "$1" = "ls-files" ]; then return "$TRACKED"; elif [ "$2" = "--name-only" ]; then echo package.json; else return "$DRIFT"; fi; }; pnpm() { return "$INSTALL_EXIT"; };\n';
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", mock + regenScript], {
      encoding: "utf8", windowsHide: true, timeout: 15000, killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ALLOW_REMOTE_LOCKFILE: allow, DRIFT: drift, TRACKED: tracked,
        INSTALL_EXIT: installExit, GITHUB_OUTPUT: output.replaceAll("\\", "/") },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected === 0) assert.equal(readFileSync(output, "utf8").trim(), `regenerated=${allow === "true" ? "1" : "0"}`);
    if (drift === "1" && allow !== "true") assert.match(result.stdout, /Commit the canonical pnpm 9.15.4 lockfile/);
  });
}
