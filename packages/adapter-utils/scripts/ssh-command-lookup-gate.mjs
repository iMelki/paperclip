#!/usr/bin/env node
// Exact, shell-free source gate for the SSH executable-discovery boundary.
// Parses with vite parseSync (oxc ESTree), the same parser the
// embedded-postgres timeout policy uses. TypeScript 7 no longer ships the
// classic compiler API (ts.createSourceFile), so the gate cannot use it.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
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
const WRAPPER_TYPES = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
]);

async function loadParseSync() {
  // vite is not a dependency of adapter-utils; resolve the workspace copy the
  // server package (and the embedded-postgres policy test) already uses.
  const anchors = [
    path.join(repoRoot, "server", "package.json"),
    path.join(repoRoot, "package.json"),
    path.join(packageRoot, "package.json"),
  ];
  for (const anchor of anchors) {
    let resolved;
    try {
      resolved = createRequire(anchor).resolve("vite");
    } catch {
      continue;
    }
    const vite = await import(pathToFileURL(resolved).href);
    if (typeof vite.parseSync === "function") return vite.parseSync;
  }
  throw new Error("vite parseSync is not available");
}

function isNode(value) {
  return value !== null && typeof value === "object" && typeof value.type === "string";
}

function forEachChild(node, visit) {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item);
    } else if (isNode(value)) {
      visit(value);
    }
  }
}

function isStringLiteral(node) {
  return node.type === "Literal" && typeof node.value === "string";
}

function isNoSubstitutionTemplate(node) {
  return node.type === "TemplateLiteral" && node.expressions.length === 0;
}

function quasiText(quasi) {
  return quasi.value.cooked ?? quasi.value.raw;
}

function unwrapExpression(node) {
  if (WRAPPER_TYPES.has(node.type)) return unwrapExpression(node.expression);
  return node;
}

function collectAliases(program) {
  const aliases = new Map();
  const appendAlias = (name, target) => {
    const existing = aliases.get(name) ?? [];
    aliases.set(name, [...existing, target]);
  };
  const visit = (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
      appendAlias(node.id.name, node.init);
    }
    if (
      node.type === "ImportDeclaration" &&
      isStringLiteral(node.source) &&
      PROCESS_LAUNCHER_MODULES.has(node.source.value)
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue;
        const importedName = specifier.imported.name ?? specifier.imported.value;
        if (importedName !== specifier.local.name && PROCESS_LAUNCHERS.has(importedName)) {
          appendAlias(specifier.local.name, { type: "Identifier", name: importedName });
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(program);
  return aliases;
}

function resolveAlias(node, aliases, seen = new Set()) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type !== "Identifier" || seen.has(unwrapped.name)) return unwrapped;
  const targets = aliases.get(unwrapped.name);
  // Ambiguous same-name declarations can belong to different lexical scopes.
  // Declining to resolve them avoids inventing a shell/argv relationship.
  if (!targets || targets.length !== 1) return unwrapped;
  return resolveAlias(targets[0], aliases, new Set([...seen, unwrapped.name]));
}

function literalText(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (isStringLiteral(resolved)) return resolved.value;
  if (isNoSubstitutionTemplate(resolved)) return quasiText(resolved.quasis[0]);
  return null;
}

function isBinaryLike(node) {
  return node.type === "BinaryExpression" || node.type === "LogicalExpression";
}

function searchableText(node, aliases, sourceText) {
  const resolved = resolveAlias(node, aliases);
  if (isStringLiteral(resolved)) return resolved.value;
  if (resolved.type === "TemplateLiteral") {
    const parts = [];
    resolved.quasis.forEach((quasi, index) => {
      parts.push(quasiText(quasi));
      if (index < resolved.expressions.length) {
        parts.push(searchableText(resolved.expressions[index], aliases, sourceText));
      }
    });
    return parts.join("");
  }
  if (isBinaryLike(resolved)) {
    return `${searchableText(resolved.left, aliases, sourceText)}${searchableText(resolved.right, aliases, sourceText)}`;
  }
  if (typeof resolved.start === "number" && typeof resolved.end === "number") {
    return sourceText.slice(resolved.start, resolved.end);
  }
  return resolved.name ?? "";
}

function arrayElements(node, aliases) {
  const resolved = resolveAlias(node, aliases);
  if (resolved.type !== "ArrayExpression") return null;
  return resolved.elements.flatMap((element) => {
    if (!element) return [];
    if (element.type === "SpreadElement") return arrayElements(element.argument, aliases) ?? [];
    return [element];
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
  if (resolved.type === "Identifier") return resolved.name;
  if (
    resolved.type === "MemberExpression" &&
    !resolved.computed &&
    resolved.property.type === "Identifier"
  ) {
    return resolved.property.name;
  }
  return null;
}

function lineAndColumn(sourceText, offset) {
  const before = sourceText.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastNewline,
  };
}

export async function findUnsafeSshCommandLookups(sourceText, sourcePath = "ssh.ts") {
  const parseSync = await loadParseSync();
  const result = parseSync(path.basename(sourcePath).replace(/\.txt$/, ""), sourceText, {
    lang: "ts",
    sourceType: "module",
  });
  if (result.errors?.length) {
    // Fail closed: an unparseable boundary file cannot be proven shell-free.
    throw new Error(`parse failed for ${sourcePath}: ${result.errors[0].message}`);
  }
  const program = result.program;
  const aliases = collectAliases(program);
  const findings = [];

  const visit = (node) => {
    if (node.type === "CallExpression" && node.arguments.length >= 2) {
      const launcher = processLauncherName(node.callee, aliases);
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
          COMMAND_LOOKUP_PATTERN.test(searchableText(argument, aliases, sourceText)),
        );
        if (hasShellFlag && lookup) {
          const position = lineAndColumn(sourceText, node.start);
          const resolvedLookup = resolveAlias(lookup, aliases);
          const interpolated =
            (resolvedLookup.type === "TemplateLiteral" && resolvedLookup.expressions.length > 0) ||
            isBinaryLike(resolvedLookup);
          findings.push({
            line: position.line,
            column: position.column,
            reason: interpolated
              ? `interpolated command lookup passed to shell executable ${shell}`
              : `command lookup passed to shell executable ${shell}`,
          });
        }
      }
    }
    forEachChild(node, visit);
  };

  visit(program);
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
  const findings = await findUnsafeSshCommandLookups(source, sourcePath);
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
