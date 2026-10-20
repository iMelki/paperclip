import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { isMainModule } from "./is-main-module.mjs";

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function qualifyPnpmPackage(manifestPath, expectedVersion, explicitCli = null) {
  const resolvedManifest = realpathSync(manifestPath);
  const root = path.dirname(resolvedManifest);
  const manifestBytes = readFileSync(resolvedManifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.name !== "pnpm" || manifest.version !== expectedVersion) {
    throw new Error(`pnpm package does not match project-required ${expectedVersion}`);
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pnpm;
  if (typeof bin !== "string" || !bin || /[\0\r\n]/u.test(bin) || /^[A-Za-z]:/u.test(bin) ||
      bin.split(/[\\/]/u).includes("..") || path.isAbsolute(bin) || path.win32.isAbsolute(bin)) {
    throw new Error("pnpm manifest has no safe relative CLI bin");
  }
  const lexicalCli = path.resolve(root, bin);
  if (!inside(root, lexicalCli)) throw new Error("pnpm CLI escapes its package");
  const cli = realpathSync(lexicalCli);
  if (!inside(root, cli) || !statSync(cli).isFile()) throw new Error("pnpm CLI is not a contained regular file");
  if (explicitCli !== null && realpathSync(explicitCli) !== cli) {
    throw new Error("explicit pnpm CLI does not match the package bin");
  }
  return {
    version: manifest.version, cli, manifest: resolvedManifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
  };
}

function manifestForCli(cli) {
  // pnpm's documented manifest bin is normally bin/pnpm.cjs. Inspect only the
  // nearest two ancestors; never scan directories or accept an unrelated JSON.
  const real = realpathSync(cli);
  for (const root of [path.dirname(real), path.dirname(path.dirname(real))]) {
    const manifest = path.join(root, "package.json");
    try { if (statSync(manifest).isFile()) return manifest; } catch { /* next bounded ancestor */ }
  }
  throw new Error("pnpm CLI has no adjacent package manifest");
}

export function resolvePnpmCli({ repoRoot, selectedCommand, explicitCli = null, env = process.env }) {
  const project = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[0-9a-fA-F]+)?$/u.exec(project.packageManager ?? "");
  if (!match) throw new Error("project packageManager must declare an exact pnpm version");
  const expected = match[1];
  if (explicitCli !== null) {
    if (!path.isAbsolute(explicitCli)) throw new Error("explicit pnpm CLI must be absolute");
    // An invalid explicit binding is a refusal, not permission to use a fallback.
    return qualifyPnpmPackage(manifestForCli(explicitCli), expected, explicitCli);
  }
  const candidates = [];
  try { candidates.push(createRequire(path.join(repoRoot, "package.json")).resolve("pnpm/package.json")); } catch { /* not locally installed */ }
  if (selectedCommand) {
    if (!path.isAbsolute(selectedCommand)) throw new Error("selected pnpm command path must be absolute");
    const selectedDirectory = path.dirname(realpathSync(selectedCommand));
    try { candidates.push(manifestForCli(selectedCommand)); } catch { /* a native/CMD shim is metadata only */ }
    candidates.push(path.join(selectedDirectory, ".tools", "pnpm", expected, "node_modules", "pnpm", "package.json"));
    candidates.push(path.join(selectedDirectory, "node_modules", "pnpm", "package.json"));
  }
  if (env.npm_execpath && path.isAbsolute(env.npm_execpath)) {
    try { candidates.push(manifestForCli(env.npm_execpath)); } catch { /* ambient metadata is not authority */ }
  }
  for (const manifest of [...new Set(candidates)]) {
    try { return qualifyPnpmPackage(manifest, expected); } catch { /* no version switching or install */ }
  }
  throw new Error(`project-required pnpm ${expected} CLI is not installed at a qualified candidate; supply an explicit installed CLI`);
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = { "--repo-root": "repoRoot", "--selected-command": "selectedCommand", "--pnpm-cli": "explicitCli" }[args[index]];
      const value = args[index + 1];
      if (!key || !value || value.startsWith("--") || options[key] !== undefined) throw new Error("invalid pnpm resolver arguments");
      options[key] = value;
    }
    if (!options.repoRoot || !path.isAbsolute(options.repoRoot)) throw new Error("absolute --repo-root is required");
    console.log(JSON.stringify(resolvePnpmCli(options)));
  } catch (error) {
    console.error(`pnpm CLI selection failed: ${error.message}`);
    process.exitCode = 2;
  }
}
