import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_ROOTS = [
  path.join(REPO_ROOT, "server/src/__tests__"),
  path.join(REPO_ROOT, "cli/src/__tests__"),
  path.join(REPO_ROOT, "packages/db/src"),
];

function listTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") return listTestFiles(entryPath);
    if (entry.isFile() && entry.name.endsWith(".test.ts")) return [entryPath];
    return [];
  });
}

describe("embedded Postgres setup timeout policy", () => {
  it("keeps legacy 20-second setup hooks on the shared platform-aware timeout", () => {
    const violations: string[] = [];
    let sharedPolicyHookCount = 0;

    for (const testFile of TEST_ROOTS.flatMap(listTestFiles)) {
      const sourceText = readFileSync(testFile, "utf8");
      const sourceFile = ts.createSourceFile(
        testFile,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const inspect = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "beforeAll" &&
          node.arguments[0]?.getText(sourceFile).includes(
            "await startEmbeddedPostgresTestDatabase",
          )
        ) {
          const timeoutText = node.arguments[1]?.getText(sourceFile) ?? "";
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const relativePath = path.relative(REPO_ROOT, testFile).split(path.sep).join("/");

          if (timeoutText === "20_000") {
            violations.push(`${relativePath}:${line}`);
          } else if (timeoutText === "EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS") {
            sharedPolicyHookCount += 1;
          }
        }
        ts.forEachChild(node, inspect);
      };

      inspect(sourceFile);
    }

    expect(violations).toEqual([]);
    expect(sharedPolicyHookCount).toBeGreaterThanOrEqual(125);
  });
});
