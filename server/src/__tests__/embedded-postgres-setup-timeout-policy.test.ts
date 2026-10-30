import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// TypeScript 7 no longer ships the classic compiler API (ts.createSourceFile,
// ts.ScriptTarget), so parse with the oxc parser that vite re-exports.
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function forEachChild(node: AstNode, visit: (child: AstNode) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) visit(item);
    } else if (isAstNode(value)) {
      visit(value);
    }
  }
}

function containsAwaitedCall(node: AstNode, calleeName: string): boolean {
  if (node.type === "AwaitExpression") {
    const argument = node.argument as AstNode | undefined;
    const callee = argument?.type === "CallExpression" ? (argument.callee as AstNode) : undefined;
    if (callee?.type === "Identifier" && callee.name === calleeName) return true;
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && containsAwaitedCall(child, calleeName)) found = true;
  });
  return found;
}

function argumentText(node: AstNode | undefined): string {
  if (!node) return "";
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal") return String(node.raw ?? node.value);
  return node.type;
}

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
      const { program } = parseSync(testFile, sourceText, { lang: "ts", sourceType: "module" });

      const inspect = (node: AstNode): void => {
        const callee = node.type === "CallExpression" ? (node.callee as AstNode) : undefined;
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        if (
          callee?.type === "Identifier" &&
          callee.name === "beforeAll" &&
          args[0] !== undefined &&
          containsAwaitedCall(args[0], "startEmbeddedPostgresTestDatabase")
        ) {
          const timeoutText = argumentText(args[1]);
          const line = sourceText.slice(0, node.start).split("\n").length;
          const relativePath = path.relative(REPO_ROOT, testFile).split(path.sep).join("/");

          if (timeoutText === "20_000") {
            violations.push(`${relativePath}:${line}`);
          } else if (timeoutText === "EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS") {
            sharedPolicyHookCount += 1;
          }
        }
        forEachChild(node, inspect);
      };

      inspect(program as unknown as AstNode);
    }

    expect(violations).toEqual([]);
    expect(sharedPolicyHookCount).toBeGreaterThanOrEqual(125);
  });
});
