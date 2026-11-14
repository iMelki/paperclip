import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createEphemeralDir } from "./lib/ephemeral-scratch.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require("./check-forbidden-tokens-core.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15000,
  maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
const noUser = {
  userInfo: () => {
    throw new Error("no user");
  },
};

test("the confirmed Cloud service account is not inferred as a personal token", () => {
  for (const source of ["USER", "LOGNAME", "USERNAME"]) {
    assert.deepEqual(core.resolveDynamicForbiddenTokens({ [source]: " AgEnT " }, noUser), []);
  }
  assert.deepEqual(core.resolveDynamicForbiddenTokens({}, { userInfo: () => ({ username: "agent" }) }), []);
});

test("service-account inference preserves actual and near-matching operator names", () => {
  assert.deepEqual(core.resolveDynamicForbiddenTokens({
    USER: "agent", LOGNAME: "synthetic-operator", USERNAME: "agent-operator",
  }, { userInfo: () => ({ username: "ops-agent" }) }), [
    "synthetic-operator", "agent-operator", "ops-agent",
  ]);
});

test("dynamic usernames shorter than 4 characters are not tokens", () => {
  for (const name of ["a", "pc", "bob", "box"]) {
    assert.deepEqual(
      core.resolveDynamicForbiddenTokens({ USER: name }, noUser),
      [],
      name,
    );
  }
});

test("generic dynamic usernames are not tokens, in any case", () => {
  for (const name of ["box", "root", "ubuntu", "runner", "user", "admin", "node", "UBUNTU", "Node"]) {
    assert.deepEqual(
      core.resolveDynamicForbiddenTokens({ USER: ` ${name} ` }, noUser),
      [],
      name,
    );
  }
  assert.deepEqual(
    core.resolveDynamicForbiddenTokens({}, { userInfo: () => ({ username: "ubuntu" }) }),
    [],
  );
});

test("a non-generic username of at least 4 characters stays a dynamic token", () => {
  assert.deepEqual(core.resolveDynamicForbiddenTokens({
    USER: "sampleuser", USERNAME: "pc", LOGNAME: "ubuntu",
  }, noUser), ["sampleuser"]);
});

test("private and tracked tokens stay substrings when the same spelling is ignored as a username", (t) => {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "forbiddentest" });
  git(root, "init", "-q");
  const privateFile = path.join(root, "private.txt");
  const trackedFile = path.join(root, "tracked.txt");
  writeFileSync(privateFile, "box\n");
  writeFileSync(trackedFile, "ubuntu\n");
  const scan = core.resolveForbiddenTokenScan([trackedFile, privateFile], { USER: "ubuntu", USERNAME: "box" }, noUser);
  assert.deepEqual(scan.wordBoundaryTokens, []);
  assert.deepEqual(scan.tokens, ["ubuntu", "box"]);
  writeFileSync(path.join(root, "notes.txt"), "sandbox checkbox ubuntu-latest\n");
  git(root, "add", "notes.txt");
  assert.equal(
    core.runForbiddenTokenCheck({
      repoRoot: root,
      tokens: scan.tokens,
      wordBoundaryTokens: scan.wordBoundaryTokens,
      log: () => {},
      error: () => {},
    }),
    1,
    "private and tracked spellings must still match inside longer words",
  );
});

test("dynamic usernames match whole words and ignore substring hits", (t) => {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "forbiddentest" });
  git(root, "init", "-q");
  const embedded = path.join(root, "embedded.txt");
  const whole = path.join(root, "whole.txt");
  writeFileSync(embedded, "sandbox checkbox sampleuserdocs\n");
  writeFileSync(whole, "clean\n");
  git(root, "add", "embedded.txt", "whole.txt");
  const env = { USER: "sampleuser" };
  const scan = core.resolveForbiddenTokenScan([], env, noUser);
  assert.deepEqual(scan.wordBoundaryTokens, ["sampleuser"]);
  const check = () => core.runForbiddenTokenCheck({
    repoRoot: root,
    tokens: scan.tokens,
    wordBoundaryTokens: scan.wordBoundaryTokens,
    log: () => {},
    error: () => {},
  });
  assert.equal(check(), 0, "sampleuser inside sampleuserdocs must not match");
  writeFileSync(whole, "the sampleuser host\n");
  assert.equal(check(), 1, "a whole-word username must match");
  writeFileSync(whole, "SAMPLEUSER-latest\n");
  assert.equal(check(), 1, "a hyphen is a word boundary and the match is case-insensitive");
  writeFileSync(whole, "clean\n");
  assert.equal(check(), 0);

  assert.equal(core.hasWordBoundaryMatch("sandbox checkbox", "box"), false);
  assert.equal(core.hasWordBoundaryMatch("a box of parts", "box"), true);
  assert.equal(core.hasWordBoundaryMatch("Sand pit", "sand"), true);
  assert.equal(core.hasWordBoundaryMatch("sandbox", "sand"), false);
});

test("explicit service-account and structural tokens still block real tracked content", (t) => {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "forbiddentest" });
  git(root, "init", "-q");
  const privateFile = path.join(root, ".git", "hooks", "forbidden-tokens.txt");
  const trackedFile = path.join(root, "structural-patterns.txt");
  writeFileSync(privateFile, "agent\n");
  writeFileSync(trackedFile, "synthetic-structural-pattern\n");
  const tokens = core.resolveForbiddenTokens([privateFile, trackedFile], { USER: "agent" }, noUser);
  assert.deepEqual(tokens, ["agent", "synthetic-structural-pattern"]);
  const check = () => core.runForbiddenTokenCheck({ repoRoot: root, tokens, log: () => {}, error: () => {} });
  const content = path.join(root, "tracked.md");
  writeFileSync(content, "agent\n");
  git(root, "add", "tracked.md");
  assert.equal(check(), 1, "explicit private spelling must still block");
  writeFileSync(content, "synthetic-structural-pattern\n");
  assert.equal(check(), 1, "structural patterns must still block");
  writeFileSync(content, "non-sensitive example\n");
  assert.equal(check(), 0, "restored clean content must pass with both tokens retained");
});

test("generic account handling does not turn scan errors into clean results", () => {
  for (const status of [128, null]) {
    assert.equal(core.runForbiddenTokenCheck({
      repoRoot, tokens: ["synthetic-private-token"], grep: () => ({ status, stdout: "" }),
      log: () => {}, error: () => {},
    }), 1);
  }
});

// ---------------------------------------------------------------------------
// Tokens are literals, not regexes.
//
// Tokens used to reach `git grep` as a BASIC REGEX, so the pattern searched was not
// the pattern written. Both directions were reproduced against this repo.
// ---------------------------------------------------------------------------

// Fail-CLOSED direction. A Windows path prefix ends in a backslash, which as a regex
// is `fatal: ... Trailing backslash` -> git exits 128 -> the fail-closed branch then
// blocks every commit in the repo until the token is removed.
test("a token ending in a backslash does not abort git", () => {
  const backslash = String.fromCharCode(92);
  const token = `C:${backslash}Users${backslash}`;

  const result = core.gitGrepToken({ token, repoRoot });

  assert.notEqual(result.status, 128, "trailing backslash must not abort the scan");
  assert.ok([0, 1].includes(result.status), `expected 0 or 1, got ${result.status}`);
});

// Fail-OPEN direction. An unescaped dot matches any character, so a `first.last`
// username silently scans for a different string than the one it was given.
test("a dot in a token does not match any character", () => {
  // The repo contains the hyphenated module name but never the dotted spelling. Both
  // spellings are assembled at run time so this file does not become a match for its
  // own probe -- a fixture that matches itself proves nothing in either direction.
  const stem = ["test", "shell"];

  const dotted = core.gitGrepToken({ token: stem.join("."), repoRoot });
  assert.equal(dotted.status, 1, "the dotted spelling must not match anything");
  assert.equal(dotted.stdout.trim(), "");

  // Control: the assertion above is only meaningful if this same call shape CAN report
  // a match. A scan that can never match anything proves nothing.
  const control = core.gitGrepToken({ token: stem.join("-"), repoRoot });
  assert.equal(control.status, 0, "control token must be found");
  assert.notEqual(control.stdout.trim(), "");
});

// ---------------------------------------------------------------------------
// Private token list resolution in a linked worktree.
//
// resolveRepoPaths() used `git rev-parse --git-dir`, which in a LINKED WORKTREE
// returns .git/worktrees/<name> -- a directory git never creates a hooks/ subdirectory
// in. The private list therefore resolved to a path that cannot exist,
// readForbiddenTokensFile() returned [] for the missing file, and every private
// pattern was silently skipped in every worktree while the check still printed a clean
// result. This builds a real repository and a real linked worktree.
// ---------------------------------------------------------------------------
test("the private token list is found from inside a linked worktree", (t) => {
  const forbiddenValue = "example-forbidden-name";
  const root = createEphemeralDir({ owner: "paperclip", purpose: "forbiddentest" });
  const mainDir = path.join(root, "main");
  const worktreeDir = path.join(root, "worktree");

  mkdirSync(mainDir);
  git(mainDir, "init", "-q", "-b", "main");
  git(mainDir, "config", "user.email", "proof@example.invalid");
  git(mainDir, "config", "user.name", "proof");
  writeFileSync(path.join(mainDir, "leaky.md"), `tracked content containing ${forbiddenValue}\n`);
  git(mainDir, "add", "-A");
  git(mainDir, "commit", "-q", "-m", "seed");
  git(mainDir, "worktree", "add", "-q", "-b", "feature", worktreeDir);

  // Deliver the private list exactly where the resolver documents it.
  const commonGitDir = git(mainDir, "rev-parse", "--git-common-dir").trim();
  const hooksDir = path.resolve(mainDir, commonGitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path.join(hooksDir, "forbidden-tokens.txt"), `# private\n${forbiddenValue}\n`);

  const checkFrom = (cwd) => {
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      const paths = core.resolveRepoPaths();
      const tokens = core.resolveForbiddenTokens(paths.tokensFiles, {}, noUser);
      const exitCode = core.runForbiddenTokenCheck({
        repoRoot: paths.repoRoot,
        tokens,
        log: () => {},
        error: () => {},
      });
      return { paths, tokens, exitCode };
    } finally {
      process.chdir(previous);
    }
  };

  const fromWorktree = checkFrom(worktreeDir);
  const fromMain = checkFrom(mainDir);

  // Both checkouts must land on the SAME private list -- that is the whole point.
  assert.equal(fromWorktree.paths.tokensFile, fromMain.paths.tokensFile);
  assert.ok(
    !fromWorktree.paths.tokensFile.includes("worktrees"),
    "must not resolve into .git/worktrees/<name>",
  );
  assert.ok(existsSync(fromWorktree.paths.tokensFile), "resolved private list must exist");

  // The leak must be blocked from inside the worktree.
  assert.ok(fromWorktree.tokens.includes(forbiddenValue));
  assert.equal(fromWorktree.exitCode, 1);

  // Control: the block must come from the value being present, not from the check
  // refusing everything. Remove it and the same worktree must pass.
  writeFileSync(path.join(worktreeDir, "leaky.md"), "nothing sensitive here\n");
  git(worktreeDir, "add", "-A");
  git(worktreeDir, "commit", "-q", "-m", "scrub");

  const scrubbed = checkFrom(worktreeDir);
  assert.ok(scrubbed.tokens.includes(forbiddenValue), "the token is still loaded");
  assert.equal(scrubbed.exitCode, 0, "a clean worktree must pass");
});

// ---------------------------------------------------------------------------
// Tracked list delivery.
//
// hooks/forbidden-tokens.txt exists in no checkout and nothing creates it, so the
// static-pattern path was dead: only the dynamically resolved username was ever
// scanned. The tracked list is the delivery path a clone actually carries.
// ---------------------------------------------------------------------------
test("the tracked list is read in addition to the private one", () => {
  const previous = process.cwd();
  try {
    process.chdir(repoRoot);
    const paths = core.resolveRepoPaths();

    assert.equal(paths.trackedTokensFile, path.resolve(repoRoot, "scripts/forbidden-tokens.txt"));
    assert.ok(existsSync(paths.trackedTokensFile), "the tracked list must ship in the repo");
    assert.deepEqual(paths.tokensFiles, [paths.trackedTokensFile, paths.tokensFile]);
  } finally {
    process.chdir(previous);
  }
});

// Proves the mechanism is live rather than merely present.
test("patterns are loaded from a tracked list file", (t) => {
  const dir = createEphemeralDir({ owner: "paperclip", purpose: "forbiddentest" });

  const trackedFile = path.join(dir, "forbidden-tokens.txt");
  const missingPrivateFile = path.join(dir, "does-not-exist.txt");
  writeFileSync(trackedFile, "# header\nstructural-pattern\n\n# trailing comment\n");

  const tokens = core.resolveForbiddenTokens([trackedFile, missingPrivateFile], {}, noUser);

  // The absent private file contributes nothing and must not break the read.
  assert.deepEqual(tokens, ["structural-pattern"]);
});

// The list must not be a finding of itself, or adding any pattern would block every
// commit by matching the line that declares it.
test("the tracked list is excluded from its own scan", () => {
  // A phrase that appears in the tracked list and nowhere else in the tree, assembled
  // at run time so this test file is not itself a match for it.
  const selfOnly = ["DEFER", "one", "placeholder", "in"].join(" ").replace("DEFER ", "DEFER - ");

  const result = core.gitGrepToken({ token: selfOnly, repoRoot });
  assert.equal(result.status, 1, "the tracked list must be excluded from the scan");

  // Control: the same string IS present on disk, so a status of 1 above means
  // "excluded", not "the string was never there".
  const onDisk = readFileSync(path.resolve(repoRoot, "scripts/forbidden-tokens.txt"), "utf8");
  assert.ok(onDisk.includes(selfOnly), "control: the phrase is really in the tracked list");
});

test("Unicode case folding keeps match and neighbor offsets aligned", () => {
  assert.equal(core.hasWordBoundaryMatch("İ alpha", "alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("i\u0307alpha", "İalpha"), true);
  assert.equal(core.hasWordBoundaryMatch("İalphadocs", "İalpha"), false);
  assert.equal(core.hasWordBoundaryMatch("xalpha", "alpha"), false);
  assert.equal(core.hasWordBoundaryMatch("alpha_", "alpha"), false);
  assert.equal(core.hasWordBoundaryMatch("alpha-latest", "alpha"), true);
});

test("dynamic filtering requests text while literal and default producer calls retain their contract", () => {
  const originalArgv = ["grep", "-inF", "--no-color", "--", "alpha", "--", ":!pnpm-lock.yaml", ":!.git", ":!scripts/forbidden-tokens.txt"];
  for (const dynamic of [true, false]) {
    let observed;
    const exit = core.runForbiddenTokenCheck({
      repoRoot: "/inert-fixture", tokens: ["alpha"], wordBoundaryTokens: dynamic ? ["alpha"] : [],
      grep: (request) => {
        assert.equal(request.textOutput, dynamic);
        const result = core.gitGrepToken({ ...request, exec: (exe, argv) => {
          assert.equal(exe, "git");
          observed = Array.from(argv);
          return dynamic ? "1:alphadocs\n" : "file.txt:1:alphadocs\n";
        } });
        assert.equal(Object.hasOwn(result, "textOutput"), dynamic);
        if (dynamic) assert.equal(result.textOutput, true);
        return result;
      }, log: () => {}, error: () => {},
    });
    assert.equal(exit, dynamic ? 0 : 1);
    assert.deepEqual(observed, dynamic ? ["grep", "--text", "-h", "--no-column", "--no-heading", "--no-break", ...originalArgv.slice(1)] : originalArgv);
  }
  let defaultArgv;
  const result = core.gitGrepToken({ token: "alpha", repoRoot: "/inert-fixture", exec: (_exe, argv) => {
    defaultArgv = Array.from(argv);
    return "file.txt:1:alpha\n";
  } });
  assert.deepEqual(defaultArgv, originalArgv);
  assert.equal(Object.hasOwn(result, "textOutput"), false);
});

test("unclassified positive output is never discarded as an embedded dynamic hit", () => {
  for (const stdout of [
    "Binary file fixture.bin matches\n",
    "Binary file notes:1:alphadocs.bin matches\n",
    "Avis alphadocs.bin\n",
    "file.txt:1:alphadocs\n",
    "alphadocs\n",
  ]) {
    assert.equal(core.runForbiddenTokenCheck({
      repoRoot: "/inert-fixture", tokens: ["alpha"], wordBoundaryTokens: ["alpha"],
      grep: () => ({ status: 0, stdout }), log: () => {}, error: () => {},
    }), 1, stdout);
  }
});

test("empty positive output and failed probes stay unverified", () => {
  for (const status of [0, 128, null]) {
    assert.equal(core.runForbiddenTokenCheck({
      repoRoot: "/inert-fixture", tokens: ["alpha"], wordBoundaryTokens: ["alpha"],
      grep: () => ({ status, stdout: "" }), log: () => {}, error: () => {},
    }), 1);
  }
});

test("original ASCII boundary policy survives non-ASCII lowercase neighbors", () => {
  assert.equal(core.hasWordBoundaryMatch("alphaİ", "alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("Kalpha", "alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("alphai", "alpha"), false);
  assert.equal(core.hasWordBoundaryMatch("kalpha", "alpha"), false);
});

test("original offset mapping handles expansion astral and contextual casing", () => {
  assert.equal(core.hasWordBoundaryMatch("İ alpha", "alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("i\u0307alpha", "İalpha"), true);
  assert.equal(core.hasWordBoundaryMatch("😀alpha", "alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("𐐀alpha", "𐐨alpha"), true);
  assert.equal(core.hasWordBoundaryMatch("a𐐀alpha", "𐐨alpha"), false);
  assert.equal(core.hasWordBoundaryMatch("İ ALPHAΟΣ", "alphaος"), true);
  assert.equal(core.hasWordBoundaryMatch("xALPHAΟΣ", "alphaος"), false);
  assert.equal(core.hasWordBoundaryMatch("aaaaaa aaaa", "aaaa"), true);
});

test("dynamic findings never print matched payload token path or terminal controls", () => {
  for (const trusted of [true, false]) {
    const output = [];
    const payload = "SYNTHETIC_SECRET_MARKER\0\u001b[31m /SYNTHETIC_PRIVATE_PATH alpha\u007f";
    const exit = core.runForbiddenTokenCheck({
      repoRoot: "/inert-fixture", tokens: ["alpha"], wordBoundaryTokens: ["alpha"],
      grep: (request) => trusted
        ? core.gitGrepToken({ ...request, exec: () => `file.txt:1:${payload}\n` })
        : { status: 0, stdout: `Binary notice ${payload}\n` },
      log: (message) => output.push(message), error: (message) => output.push(message),
    });
    assert.equal(exit, 1);
    const joined = output.join("\n");
    for (const forbidden of ["SYNTHETIC_SECRET_MARKER", "SYNTHETIC_PRIVATE_PATH", "file.txt", "alpha", "\0", "\u001b", "\u007f"]) {
      assert.equal(joined.includes(forbidden), false);
    }
    assert.equal(output.length, 3);
  }
});

test("dynamic diagnostics are fixed bounded while literal findings retain output", () => {
  const dynamicOutput = [];
  const tokens = ["alpha", "bravo", "charlie"];
  assert.equal(core.runForbiddenTokenCheck({
    repoRoot: "/inert-fixture", tokens, wordBoundaryTokens: tokens,
    grep: (request) => core.gitGrepToken({ ...request, exec: () => `file.txt:1:${request.token}\n`.repeat(20) }),
    log: (message) => dynamicOutput.push(message), error: (message) => dynamicOutput.push(message),
  }), 1);
  assert.equal(dynamicOutput.length, 3);
  assert.equal(dynamicOutput.filter((message) => message === "  A dynamic forbidden-token finding was detected.").length, 1);
  for (const token of tokens) assert.equal(dynamicOutput.join("\n").includes(token), false);
  const literalOutput = [];
  assert.equal(core.runForbiddenTokenCheck({
    repoRoot: "/inert-fixture", tokens: ["alpha"],
    grep: () => ({ status: 0, stdout: "file.txt:1:alphadocs\n" }),
    log: () => {}, error: (message) => literalOutput.push(message),
  }), 1);
  assert.ok(literalOutput.includes("  file.txt:1:alphadocs"));
});

// Production-shaped regressions use real Git and retained private fixtures.
function fixture(name, content) {
  const root = createEphemeralDir({ owner: "paperclip", purpose: "forbiddengit" });
  git(root, "init");
  writeFileSync(path.join(root, name), content);
  git(root, "add", "--", name);
  return root; // Retained private fixture; no deletion or external remote.
}
function scan(root, dynamic = true) {
  return core.runForbiddenTokenCheck({ repoRoot: root, tokens: ["alpha"],
    wordBoundaryTokens: dynamic ? ["alpha"] : [], log: () => {}, error: () => {} });
}
test("real Git ignores token in filename and embedded dynamic contents", () => {
  const root = fixture("alpha-file.txt", "alphadocs\n");
  assert.equal(scan(root), 0);
  assert.equal(scan(root, false), 1);
});
test("real Git catches standalone dynamic token after expanding Unicode case", () => {
  const root = fixture("unicode.txt", "İ alphadocs\nİ alpha\n");
  assert.equal(scan(root), 1);
});
test("real Git preserves embedded Unicode-prefix nonfinding", () => {
  const root = fixture("unicode-alpha.txt", "İ alphadocs\n");
  assert.equal(scan(root), 0);
});
test("real Git framing overrides color, column, heading and break config", () => {
  const root = fixture("alpha-colon.txt", "prefix:alphadocs\n");
  for (const [key, value] of [["color.grep", "always"], ["grep.column", "true"],
    ["grep.heading", "true"], ["grep.break", "true"]]) git(root, "config", key, value);
  const result = core.gitGrepToken({ token: "alpha", repoRoot: root, textOutput: true });
  assert.equal(result.stdout, "1:prefix:alphadocs\n");
  assert.equal(scan(root), 0);
  writeFileSync(path.join(root, "alpha-colon.txt"), "prefix:alpha\n");
  assert.equal(scan(root), 1);
});
test("real Git binary NUL remains blocking instead of being silently filtered", () => {
  const root = fixture("binary.bin", Buffer.from("prefix\0alpha\0tail\n"));
  assert.equal(scan(root), 1);
});
test("real Git no-match succeeds but missing repository fails closed", () => {
  const root = fixture("safe.txt", "no forbidden value\n");
  assert.equal(scan(root), 0);
  assert.equal(scan(path.join(root, "missing")), 1);
});
