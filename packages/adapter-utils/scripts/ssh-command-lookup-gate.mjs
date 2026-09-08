#!/usr/bin/env node
// Exact, shell-free source gate for the SSH executable-discovery boundary.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultSourcePath = path.join(packageRoot, "src", "ssh.ts");
const SHELL_BASENAMES = new Set([
  "ash",
  "ash.exe",
  "bash",
  "bash.exe",
  "dash",
  "dash.exe",
  "ksh",
  "ksh.exe",
  "sh",
  "sh.exe",
  "zsh",
  "zsh.exe",
]);
const PROCESS_LAUNCHERS = new Set([
  "execFileText",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
const PROCESS_LAUNCHER_MODULES = new Set([
  "node:child_process",
  "child_process",
  "./process.js",
]);
const COMMAND_LOOKUP_PATTERN = /\b(?:command\s+-v|which)\b/;

function unwrapExpression(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function collectAliases(sourceFile) {
  const aliases = new Map();
  const appendAlias = (name, target) => {
    const existing = aliases.get(name) ?? [];
    aliases.set(name, [...existing, target]);
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      appendAlias(node.name.text, node.initializer);
    }
    if (ts.isImportSpecifier(node) && node.propertyName) {
      const importDeclaration = node.parent.parent.parent;
      const moduleName =
        ts.isImportDeclaration(importDeclaration) &&
        ts.isStringLiteral(importDeclaration.moduleSpecifier)
          ? importDeclaration.moduleSpecifier.text
          : null;
      if (
        moduleName &&
        PROCESS_LAUNCHER_MODULES.has(moduleName) &&
        PROCESS_LAUNCHERS.has(node.propertyName.text)
      ) {
        appendAlias(node.name.text, node.propertyName);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function resolveAlias(node, aliases, seen = new Set()) {
  const unwrapped = unwrapExpression(node);
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped.text)) return unwrapped;
  const targets = aliases.get(unwrapped.text);
  // Ambiguous same-name declarations can belong to different lexical scopes.
  // Declining to resolve them avoids inventing a shell/argv relationship.
  if (!targets || targets.length !== 1) return unwrapped;
  return resolveAlias(targets[0], aliases, new Set([...seen, unwrapped.text]));
}

function literalText(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) {
    return resolved.text;
  }
  return null;
}

function searchableText(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) {
    return resolved.text;
  }
  if (ts.isTemplateExpression(resolved)) {
    return [
      resolved.head.text,
      ...resolved.templateSpans.flatMap((span) => [
        searchableText(span.expression, aliases),
        span.literal.text,
      ]),
    ].join("");
  }
  if (ts.isBinaryExpression(resolved)) {
    return `${searchableText(resolved.left, aliases)}${searchableText(resolved.right, aliases)}`;
  }
  return resolved.getText();
}

function arrayElements(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (!ts.isArrayLiteralExpression(resolved)) return null;
  return resolved.elements.flatMap((element) => {
    if (ts.isSpreadElement(element)) return arrayElements(element.expression, aliases) ?? [];
    return ts.isExpression(element) ? [element] : [];
  });
}

function shellBasename(value) {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isShellCommandFlag(value) {
  return value === "--command" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(value);
}

function processLauncherName(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (ts.isIdentifier(resolved)) return resolved.text;
  if (ts.isPropertyAccessExpression(resolved)) return resolved.name.text;
  return null;
}

export function findUnsafeSshCommandLookups(sourceText, sourcePath = "ssh.ts") {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const aliases = collectAliases(sourceFile);
  const findings = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const launcher = processLauncherName(node.expression, aliases);
      const shell = literalText(node.arguments[0], aliases);
      const argv = arrayElements(node.arguments[1], aliases);
      if (
        launcher &&
        PROCESS_LAUNCHERS.has(launcher) &&
        shell &&
        SHELL_BASENAMES.has(shellBasename(shell)) &&
        argv
      ) {
        const hasShellFlag = argv.some((argument) =>
          isShellCommandFlag(literalText(argument, aliases) ?? ""),
        );
        const lookup = argv.find((argument) =>
          COMMAND_LOOKUP_PATTERN.test(searchableText(argument, aliases)),
        );
        if (hasShellFlag && lookup) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const resolvedLookup = resolveAlias(lookup, aliases);
          const interpolated =
            ts.isTemplateExpression(resolvedLookup) || ts.isBinaryExpression(resolvedLookup);
          findings.push({
            line: position.line + 1,
            column: position.character + 1,
            reason: interpolated
              ? `interpolated command lookup passed to shell executable ${shell}`
              : `command lookup passed to shell executable ${shell}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function sourcePathFromArgs(args) {
  if (args.length === 0) return defaultSourcePath;
  if (args.length === 2 && args[0] === "--source") return path.resolve(args[1]);
  throw new Error("usage: ssh-command-lookup-gate.mjs [--source <path>]");
}

async function main() {
  const sourcePath = sourcePathFromArgs(process.argv.slice(2));
  const source = await readFile(sourcePath, "utf8");
  const findings = findUnsafeSshCommandLookups(source, sourcePath);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `SSH_COMMAND_LOOKUP_UNSAFE ${sourcePath}:${finding.line}:${finding.column} ${finding.reason}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`SSH_COMMAND_LOOKUP_SAFE ${sourcePath}\n`);
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`SSH_COMMAND_LOOKUP_GATE_ERROR ${message}\n`);
  process.exitCode = 2;
});
