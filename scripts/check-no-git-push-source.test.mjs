import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOW_MARKER,
  GIT_PUSH_PATTERN,
  findGitPushOffenses,
} from "./check-no-git-push-source.mjs";

test("regex matches common git push forms but ignores unrelated pushes", () => {
  for (const source of ["git push", "GIT PUSH", "git  push origin master", "git-push", "git_push"]) {
    assert.ok(GIT_PUSH_PATTERN.test(source), source);
  }
  for (const source of ["args.push('git')", "notes.push('git remote')", "pushed", "git fetch"]) {
    assert.ok(!GIT_PUSH_PATTERN.test(source), source);
  }
});

test("bare invocations are detected and attributed to the right line", () => {
  const stringOffense = findGitPushOffenses('await exec("git push origin master");\n');
  assert.equal(stringOffense.length, 1);
  assert.equal(stringOffense[0].lineNumber, 1);
  const bareOffense = findGitPushOffenses("const ready = true;\ngit push origin main\n");
  assert.equal(bareOffense.length, 1);
  assert.equal(bareOffense[0].lineNumber, 2);
});

test("real comments are ignored and quotes inside them cannot hide later code", () => {
  assert.deepEqual(
    findGitPushOffenses("// no `git push`, no fetch from any origin.\nconst x = 1;\n"),
    [],
  );
  const offenses = findGitPushOffenses("// unmatched quote ' is comment text\nexec(\"git push origin main\");\n");
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 2);
  assert.deepEqual(
    findGitPushOffenses('const path = "C:\\\\"; // git push origin master\nconst y = 2;\n'),
    [],
  );
});

test("astral characters do not shift comment ranges or later offense lines", () => {
  const source = [
    `// ${ALLOW_MARKER}: one reviewed mirror`,
    "// 🚀 comment after the marker",
    'exec("git push origin main");',
    "",
  ].join("\n");
  assert.deepEqual(
    findGitPushOffenses(source).map(({ lineNumber }) => lineNumber),
    [3],
  );
});

test("only a standalone preceding marker with a reason grants one exemption", () => {
  const trailing = `exec("git push origin master"); // ${ALLOW_MARKER}: mirror\n`;
  assert.equal(findGitPushOffenses(trailing).length, 1);
  const valid = `// ${ALLOW_MARKER}: reviewed mirror\nexec("git push origin master");\n`;
  assert.deepEqual(findGitPushOffenses(valid), []);
  const twoPushes = `// ${ALLOW_MARKER}: reviewed mirror\nexec("git push a"); exec("git push b");\n`;
  assert.equal(findGitPushOffenses(twoPushes).length, 1);
});

test("markers inside strings, commands, templates, or without reasons do not exempt", () => {
  const fixtures = [
    `const marker = "${ALLOW_MARKER}: fake";\nexec("git push origin main");\n`,
    `exec("echo ${ALLOW_MARKER}: fake && git push origin main");\n`,
    `// ${ALLOW_MARKER}:\nexec("git push origin main");\n`,
    `const command = \`\n// ${ALLOW_MARKER}: fake\ngit push origin main\n\`;\n`,
  ];
  for (const source of fixtures) assert.ok(findGitPushOffenses(source).length >= 1, source);
});

test("spawn and execFile arrays work across lines and nested long values", () => {
  const longPadding = `nested([${JSON.stringify("]".repeat(1300))}]),`;
  const fixtures = [
    `spawn("git", ["push", "origin", "main"]);\n`,
    `execFile('git', ['push', '--tags']);\n`,
    `spawn("git", [\n  "push", "origin", "main"\n]);\n`,
    `execFile("git", [\n  "-C", repo, "push", "origin"\n]);\n`,
    `spawn("git", [${longPadding} "push", "origin"]);\n`,
  ];
  for (const source of fixtures) assert.ok(findGitPushOffenses(source).length > 0, source);
});

test("shell forms cover options, git.exe, relative paths, and platform continuations", () => {
  const fixtures = [
    { path: "adapter.ts", source: 'exec("git -C repo push origin main");\n' },
    { path: "adapter.ts", source: 'exec("git.exe push origin main");\n' },
    { path: "adapter.ts", source: "exec('C:\\\\Program\\ Files\\Git\\cmd\\git.exe -C repo push origin main');\n" },
    { path: "adapter.sh", source: "tools/git push origin main\n" },
    { path: "adapter.sh", source: "git '-C' repo push origin main\n" },
    { path: "adapter.sh", source: "git \\\n push origin main\n" },
    { path: "adapter.ps1", source: "git `\n push origin main\n" },
  ];
  for (const fixture of fixtures) {
    assert.ok(
      findGitPushOffenses(fixture.source, { relativePath: fixture.path }).length > 0,
      `${fixture.path}: ${fixture.source}`,
    );
  }
});

test("language-aware lexing cannot hide pushes behind URLs, division, or regex literals", () => {
  assert.equal(
    findGitPushOffenses("curl https://example.test && git push origin main\n", { relativePath: "adapter.sh" }).length,
    1,
  );
  assert.equal(
    findGitPushOffenses('value = total // 2; run("git push origin main")\n', { relativePath: "adapter.py" }).length,
    1,
  );
  assert.equal(
    findGitPushOffenses(String.raw`const matcher = /\/\//; exec("git push origin main");`, { relativePath: "adapter.ts" }).length,
    1,
  );
  assert.equal(
    findGitPushOffenses('const ratio = total\n  / divisor;\nexec("git push origin main");\n', { relativePath: "adapter.ts" }).length,
    1,
  );
});

test("PowerShell escaping keeps fake markers inside strings and finds the real command", () => {
  const multiline = [
    '$payload = "start `"',
    `# ${ALLOW_MARKER}: fake`,
    '"; git push origin main',
    '',
  ].join("\n");
  assert.equal(findGitPushOffenses(multiline, { relativePath: "adapter.ps1" }).length, 1);

  const sameLine = '$payload = "quoted`" # still string"; git push origin main\n';
  assert.equal(findGitPushOffenses(sameLine, { relativePath: "adapter.ps1" }).length, 1);

  const literalBackslash = "$path = 'C:\\'; git push origin main\n";
  assert.equal(findGitPushOffenses(literalBackslash, { relativePath: "adapter.ps1" }).length, 1);

  const hereString = [
    '$payload = @"',
    'text " quote',
    `# ${ALLOW_MARKER}: fake`,
    '# $(git push origin main)',
    '"@',
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(hereString, { relativePath: "adapter.ps1" }).length, 1);

  const indentedFakeClose = [
    '$payload = @"',
    '  "@',
    '# $(git push origin main)',
    '"@',
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(indentedFakeClose, { relativePath: "adapter.ps1" }).length, 1);
});

test("shell heredocs keep command-shaped body text visible even when quoted", () => {
  const expandable = [
    "cat <<EOF",
    "# $(git push origin main)",
    "EOF",
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(expandable, { relativePath: "adapter.sh" }).length, 1);

  const tabStripped = ["cat <<-EOF", "\t# $(git push origin main)", "\tEOF", ""].join("\n");
  assert.equal(findGitPushOffenses(tabStripped, { relativePath: "adapter.sh" }).length, 1);

  const literal = [
    "cat <<'EOF'",
    "# $(git push origin main)",
    "EOF",
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(literal, { relativePath: "adapter.sh" }).length, 1);

  const escapedOperator = ["printf '%s' \\<<EOF", "# $(git push origin main)", "EOF", ""].join("\n");
  assert.deepEqual(findGitPushOffenses(escapedOperator, { relativePath: "adapter.sh" }), []);

  const crlfAfterLiteral = ["cat <<'EOF'", "# literal git push", "EOF", "git push origin main", ""].join("\r\n");
  assert.equal(findGitPushOffenses(crlfAfterLiteral, { relativePath: "adapter.sh" }).length, 2);

  const concatenatedQuotedDelimiter = [
    "cat <<'E'OF",
    "# $(git push origin main)",
    "EOF",
    "git push origin main",
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(concatenatedQuotedDelimiter, { relativePath: "adapter.sh" }).length, 2);

  const continuedExpandable = ["cat <<\\", "EOF", "# $(git push origin main)", "EOF", ""].join("\n");
  assert.equal(findGitPushOffenses(continuedExpandable, { relativePath: "adapter.sh" }).length, 1);

  const ansiQuotedDelimiter = [
    "cat <<$'EOF'",
    "# $(git push origin main)",
    "EOF",
    "git push origin main",
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(ansiQuotedDelimiter, { relativePath: "adapter.sh" }).length, 2);

  const indexedArrayDoubleQuote = [`arr[1<<"2"]=x`, "git push origin main", "2]=x", ""].join("\n");
  assert.deepEqual(
    findGitPushOffenses(indexedArrayDoubleQuote, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [2],
  );

  const indexedArraySingleQuote = [`arr[1<<'2']=x`, "git push origin main", "2=x", ""].join("\n");
  assert.deepEqual(
    findGitPushOffenses(indexedArraySingleQuote, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [2],
  );

  const falseDelimiterMatchesPush = [
    "if false; then",
    `  arr[1<<'g''it pu''sh #']=x`,
    "fi",
    "git push #]=x",
    "",
  ].join("\n");
  assert.deepEqual(
    findGitPushOffenses(falseDelimiterMatchesPush, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [4],
  );

  const arithmeticShift = ['value=$((1 << "2" ))', "git push origin main", "2", ""].join("\n");
  assert.equal(findGitPushOffenses(arithmeticShift, { relativePath: "adapter.sh" }).length, 1);

  const arithmeticSubstitution = "value=$(( $(git push origin main) + 1 ))\n";
  assert.equal(findGitPushOffenses(arithmeticSubstitution, { relativePath: "adapter.sh" }).length, 1);

  const arithmeticCommentSubstitution = [
    "value=$(( $(",
    "  # ))",
    "  printf 1",
    ') + (1 << "2" ) ))',
    "git push origin main",
    "2",
    "",
  ].join("\n");
  assert.deepEqual(
    findGitPushOffenses(arithmeticCommentSubstitution, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [5],
  );

  const arithmeticQuotedSubstitution = [
    `value=$(( $(true '))'; echo 1) << "2" ))`,
    "git push origin main",
    "2",
    "",
  ].join("\n");
  assert.deepEqual(
    findGitPushOffenses(arithmeticQuotedSubstitution, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [2],
  );

  const arithmeticQuoteRemoval = [
    `value=$(( "(" "(" 1 ) ) << "2" ))`,
    "git push origin main",
    "2",
    "",
  ].join("\n");
  assert.deepEqual(
    findGitPushOffenses(arithmeticQuoteRemoval, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [2],
  );

  const legacyArithmeticShift = [`value=$[1 << "2"]`, "git push origin main", "2", ""].join("\n");
  assert.deepEqual(
    findGitPushOffenses(legacyArithmeticShift, { relativePath: "adapter.sh" }).map(({ lineNumber }) => lineNumber),
    [2],
  );
});

test("multiline data cannot spoof an exemption in YAML, Python, or batch", () => {
  const yaml = [
    "payload: |",
    `  # ${ALLOW_MARKER}: fake`,
    "run: git push origin main",
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(yaml, { relativePath: "adapter.yaml" }).length, 1);

  const python = [
    'payload = """text " quote',
    `# ${ALLOW_MARKER}: fake`,
    '"""; os.system("git push origin main")',
    "",
  ].join("\n");
  assert.equal(findGitPushOffenses(python, { relativePath: "adapter.py" }).length, 1);

  const batch = [
    'set "payload=start^',
    `REM ${ALLOW_MARKER}: fake`,
    '" & git push origin main',
    "",
  ].join("\r\n");
  assert.equal(findGitPushOffenses(batch, { relativePath: "adapter.cmd" }).length, 1);
});

test("quoted push and send-pack subcommands are rejected", () => {
  for (const { relativePath, source } of [
    { relativePath: "adapter.sh", source: 'git "push" origin main\n' },
    { relativePath: "adapter.sh", source: "git 'push' origin main\n" },
    { relativePath: "adapter.sh", source: "git send-pack origin refs/heads/main\n" },
    { relativePath: "adapter.sh", source: "git-send-pack origin refs/heads/main\n" },
    {
      relativePath: "adapter.ts",
      source: 'spawn("git", ["send-pack", "origin", "refs/heads/main"]);\n',
    },
  ]) {
    assert.equal(findGitPushOffenses(source, { relativePath }).length, 1, source);
  }
});

test("language-specific comment forms do not create false findings", () => {
  const fixtures = [
    { path: "adapter.py", source: "value = 1# do not git push origin main\n" },
    { path: "adapter.ps1", source: "$value = 1# do not git push origin main\n" },
    { path: "adapter.cmd", source: "REM do not git push origin main\r\n" },
    { path: "adapter.cmd", source: "@REM do not git push origin main\r\n" },
    { path: "adapter.bat", source: ":: do not git push origin main\r\n" },
    { path: "adapter.sh", source: "echo ok;# do not git push origin main\n" },
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(findGitPushOffenses(fixture.source, { relativePath: fixture.path }), []);
  }
});

test("shell single-quoted backslashes cannot keep later commands hidden", () => {
  const source = "value='C:\\'; git push origin main\n";
  assert.equal(findGitPushOffenses(source, { relativePath: "adapter.sh" }).length, 1);
});

test("command-shaped JavaScript regex literals are conservatively review-gated", () => {
  assert.equal(findGitPushOffenses("const forbidden = /git push/;\n", { relativePath: "adapter.ts" }).length, 1);
});
