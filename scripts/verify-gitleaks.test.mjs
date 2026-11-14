import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createEphemeralDir } from "./lib/ephemeral-scratch.mjs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("./verify-gitleaks.mjs", import.meta.url));

function createFakeGitleaks({ version = "8.30.1", scanExit = 0 } = {}) {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "gitleakstest" });
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
      'console.log("synthetic scanner output");',
      'console.error("synthetic scanner diagnostic");',
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
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL",
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
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const result = verify(["--range", `${base}..${head}`], fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(fake.argsLog, "utf8").trim(),
    `git --redact --verbose --exit-code 2 --log-opts=${base}..${head} .`,
  );
});

test("rejects the removed local-remote outgoing mode before starting gitleaks", () => {
  const fake = createFakeGitleaks();
  const result = verify(["--outgoing", "b".repeat(40), "--remote", "origin"], fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /exactly one scan mode/);
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

test("retains scanner output on successful and failed scans", () => {
  for (const scanExit of [0, 2, 7]) {
    const result = verify("--staged", createFakeGitleaks({ scanExit }));
    assert.match(result.stdout, /synthetic scanner output/);
    assert.match(result.stderr, /synthetic scanner diagnostic/);
  }
});

test("fails closed when the scanner executable cannot start", () => {
  const fake = createFakeGitleaks();
  fake.binary = join(fake.prefix[0], "missing-executable");
  const result = verify("--staged", fake);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /required but could not be started/);
});