import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("./verify-gitleaks.mjs", import.meta.url));

function createFakeGitleaks({ version = "8.30.1", scanExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paperclip-gitleaks-test-"));
  const argsLog = join(root, "args.log");
  const shim = join(root, "fake-gitleaks.mjs");
  writeFileSync(
    shim,
    [
      'import { appendFileSync } from "node:fs";',
      'const [command, ...args] = process.argv.slice(2);',
      'if (command === "version") {',
      `  console.log(${JSON.stringify(version)});`,
      "  process.exit(0);",
      "}",
      `appendFileSync(${JSON.stringify(argsLog)}, [command, ...args].join(" ") + "\\n");`,
      `process.exit(${scanExit});`,
    ].join("\n"),
  );

  return { argsLog, binary: process.execPath, prefix: [shim] };
}

function verify(mode, fake) {
  const modeArgs = Array.isArray(mode) ? mode : [mode];
  return spawnSync(process.execPath, [verifier, ...modeArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PAPERCLIP_GITLEAKS_BIN: fake.binary,
      PAPERCLIP_GITLEAKS_BIN_ARGS_JSON: JSON.stringify(fake.prefix),
    },
    windowsHide: true,
  });
}

test("runs the exact staged pre-commit command", () => {
  const fake = createFakeGitleaks();
  const result = verify("--staged", fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(fake.argsLog, "utf8").trim(),
    "git --redact --verbose --exit-code 2 --pre-commit --staged .",
  );
});

test("runs the complete history command", () => {
  const fake = createFakeGitleaks();
  const result = verify("--history", fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(fake.argsLog, "utf8").trim(),
    "git --redact --verbose --exit-code 2 --log-opts=--all .",
  );
});

test("runs the exact pull-request commit range without scanning all history", () => {
  const fake = createFakeGitleaks();
  const base = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const head = base;
  const result = verify(["--range", `${base}..${head}`], fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(fake.argsLog, "utf8").trim(),
    `git --redact --verbose --exit-code 2 --log-opts=-m ${base}..${head} .`,
  );
});

test("rejects the removed local-remote outgoing mode before starting gitleaks", () => {
  const fake = createFakeGitleaks();
  const result = verify(["--outgoing", "b".repeat(40), "--remote", "origin"], fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /exactly one scan mode/);
});

test("refuses a range whose commits are not in the checkout", () => {
  const fake = createFakeGitleaks();
  const result = verify(["--range", `${"a".repeat(40)}..${"b".repeat(40)}`], fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /not available in this checkout/);
});

test("rejects an incomplete or non-object-id range before starting gitleaks", () => {
  const fake = createFakeGitleaks();
  const result = verify(["--range", "dev..topic"], fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /full hexadecimal base and head object ids/);
});

test("fails before scanning when the binary version is not pinned", () => {
  const fake = createFakeGitleaks({ version: "8.30.0" });
  const result = verify("--staged", fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /version mismatch/i);
});

test("distinguishes findings from scanner infrastructure errors", () => {
  const finding = verify("--history", createFakeGitleaks({ scanExit: 2 }));
  assert.equal(finding.status, 2);
  assert.match(finding.stderr, /found potential secrets/i);

  const toolError = verify("--history", createFakeGitleaks({ scanExit: 7 }));
  assert.equal(toolError.status, 3);
  assert.match(toolError.stderr, /tool\/runtime error/i);
});

// Real-scanner proof for the range mode. Runs only when the pinned binary is
// supplied (CI sets it); the fake-scanner tests above cover argument wiring.
const realGitleaks = process.env.PAPERCLIP_GITLEAKS_REAL_BIN?.trim();

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createRangeFixture() {
  const repo = mkdtempSync(join(tmpdir(), "paperclip-gitleaks-range-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  const commit = (file, text, message) => {
    writeFileSync(join(repo, file), text);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  const base = commit("README.md", "clean\n", "base");
  // Assembled at run time so this file never contains a scannable literal.
  const fixtureSecret = ["n8Zk3vQ2xT9p", "Lw4Rb7YcHd1s", "Ue6JfGm0Xa5V", "b2Nq"].join("");
  const leaked = commit("config.txt", `${"api"}_${"key"} = "${fixtureSecret}"\n`, "adds a secret");
  const head = commit("notes.md", "still clean\n", "after the secret");
  return { repo, base, leaked, head };
}

function createMergeFixture() {
  const repo = mkdtempSync(join(tmpdir(), "paperclip-gitleaks-range-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  const commit = (file, text, message) => {
    writeFileSync(join(repo, file), text);
    git(repo, "add", file);
    git(repo, "commit", "-q", "-m", message);
  };
  commit("README.md", "clean\n", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "topic");
  commit("topic.md", "clean topic\n", "topic work");
  git(repo, "checkout", "-q", "main");
  commit("main.md", "clean main\n", "main work");
  // The secret exists only in the merge commit's own diff.
  git(repo, "merge", "--no-ff", "--no-commit", "topic");
  const fixtureSecret = ["n8Zk3vQ2xT9p", "Lw4Rb7YcHd1s", "Ue6JfGm0Xa5V", "b2Nq"].join("");
  writeFileSync(join(repo, "merged.txt"), `${"api"}_${"key"} = "${fixtureSecret}"\n`);
  git(repo, "add", "merged.txt");
  git(repo, "commit", "-q", "-m", "merge topic");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

function verifyReal(repo, range) {
  return spawnSync(process.execPath, [verifier, "--range", range], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PAPERCLIP_GITLEAKS_BIN: realGitleaks },
    windowsHide: true,
  });
}

test("real Gitleaks: a secret inside the range is caught", { skip: !realGitleaks }, () => {
  const { repo, base, head } = createRangeFixture();
  const result = verifyReal(repo, `${base}..${head}`);
  assert.equal(result.status, 2, result.stderr);
});

test("real Gitleaks: a secret added only inside a merge commit is caught", { skip: !realGitleaks }, () => {
  const { repo, base, head } = createMergeFixture();
  const result = verifyReal(repo, `${base}..${head}`);
  assert.equal(result.status, 2, result.stderr);
});

test("real Gitleaks: a secret outside the range is not scanned", { skip: !realGitleaks }, () => {
  const { repo, leaked, head } = createRangeFixture();
  const result = verifyReal(repo, `${leaked}..${head}`);
  assert.equal(result.status, 0, result.stderr);
});

test("real Gitleaks: an unknown commit id fails closed", { skip: !realGitleaks }, () => {
  const { repo, head } = createRangeFixture();
  const result = verifyReal(repo, `${"0".repeat(40)}..${head}`);
  assert.notEqual(result.status, 0, "an unreadable range must not pass");
});
