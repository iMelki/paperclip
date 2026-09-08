import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const devRunnerPath = new URL("../dev-runner.ts", import.meta.url);
const source = readFileSync(devRunnerPath, "utf8");

function functionBody(name) {
  const signatureIndex = source.indexOf(`async function ${name}(`);
  assert.notEqual(signatureIndex, -1, `expected ${name} in dev-runner.ts`);

  const parametersStart = source.indexOf("(", signatureIndex);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") parameterDepth -= 1;
    if (parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }

  assert.notEqual(parametersEnd, -1, `expected ${name} parameter list`);
  const bodyStart = source.indexOf("{", parametersEnd);
  assert.notEqual(bodyStart, -1, `expected ${name} body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }

  assert.fail(`unterminated ${name} body`);
}

test("runPnpm uses hidden piped stdio for Windows while preserving capture and forwarding", () => {
  const body = functionBody("runPnpm");

  assert.match(body, /const isWindows = process\.platform === "win32";/);
  assert.match(
    body,
    /const actualStdio:[\s\S]*?= isWindows\s*\? \["ignore", "pipe", "pipe"\]\s*:\s*requestedStdio;/,
  );
  assert.match(body, /stdio: actualStdio,/);
  assert.match(body, /windowsHide: isWindows,/);
  assert.match(body, /detached: false,/);
  assert.match(body, /spawned\.stdout\.pipe\(stdout, \{ end: false \}\);/);
  assert.match(body, /spawned\.stderr\.pipe\(stderr, \{ end: false \}\);/);
  assert.match(body, /stdoutBuffer\.append\(chunk\);/);
  assert.match(body, /stderrBuffer\.append\(chunk\);/);
});

test("startServerChild keeps the Windows server descendant hidden, piped, forwarded, and owned", () => {
  const body = functionBody("startServerChild");

  assert.match(body, /const isWindows = process\.platform === "win32";/);
  assert.match(
    body,
    /const serverStdio:[\s\S]*?= isWindows\s*\? \["ignore", "pipe", "pipe"\]\s*:\s*"inherit";/,
  );
  assert.match(body, /stdio: serverStdio,/);
  assert.match(body, /windowsHide: isWindows,/);
  assert.match(body, /detached: false,/);
  assert.match(body, /if \(isWindows\) \{/);
  assert.match(body, /child\.stdout\?\.pipe\(stdout, \{ end: false \}\);/);
  assert.match(body, /child\.stderr\?\.pipe\(stderr, \{ end: false \}\);/);
});
