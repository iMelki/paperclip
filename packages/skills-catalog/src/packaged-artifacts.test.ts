import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function validatedPackageManagerCli(
  file: "npm" | "pnpm",
  candidate: string | undefined,
) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  const normalized = resolved.replaceAll("\\", "/").toLowerCase();
  const expectedSuffix =
    file === "npm"
      ? "/node_modules/npm/bin/npm-cli.js"
      : "/node_modules/pnpm/bin/pnpm.cjs";
  if (!normalized.endsWith(expectedSuffix)) return null;
  try {
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function resolvePnpmCliFromWrapper(wrapperPath: string) {
  if (!existsSync(wrapperPath)) return null;
  const wrapperDir = path.dirname(wrapperPath);
  const contents = readFileSync(wrapperPath, "utf8");
  const matches = contents.matchAll(
    /"([^"\r\n]*node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.cjs)"/gi,
  );
  for (const match of matches) {
    const rawPath = match[1];
    const candidate = /^%~dp0/i.test(rawPath)
      ? path.resolve(wrapperDir, rawPath.replace(/^%~dp0[\\/]?/i, ""))
      : path.resolve(wrapperDir, rawPath);
    const validated = validatedPackageManagerCli("pnpm", candidate);
    if (validated) return validated;
  }
  return null;
}

function resolveWindowsPackageManagerCli(file: "npm" | "pnpm") {
  const executableDir = path.dirname(process.execPath);
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  if (file === "npm") {
    const candidates = [
      process.env.npm_execpath,
      path.join(executableDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.resolve(
        executableDir,
        "..",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      ...pathEntries.flatMap((entry) => [
        path.join(entry, "node_modules", "npm", "bin", "npm-cli.js"),
        path.resolve(
          entry,
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ]),
    ];
    for (const candidate of candidates) {
      const validated = validatedPackageManagerCli("npm", candidate);
      if (validated) return validated;
    }
  } else {
    const fromEnvironment = validatedPackageManagerCli(
      "pnpm",
      process.env.npm_execpath,
    );
    if (fromEnvironment) return fromEnvironment;

    for (const entry of pathEntries) {
      const fromWrapper = resolvePnpmCliFromWrapper(
        path.join(entry, "pnpm.cmd"),
      );
      if (fromWrapper) return fromWrapper;
    }
  }

  throw new Error(`Could not resolve the ${file} JavaScript CLI on Windows`);
}

function packageManagerInvocation(file: "npm" | "pnpm", args: string[]) {
  if (process.platform !== "win32") return { file, args };

  // The Windows npm/pnpm shims are batch files, and cmd.exe would parse path
  // metacharacters a second time. Run the validated JavaScript CLI directly.
  return {
    file: process.execPath,
    args: [resolveWindowsPackageManagerCli(file), ...args],
  };
}

function readPackMetadata(packDestination: string) {
  const command = packageManagerInvocation(
    "npm",
    ["pack", "--json", "--pack-destination", packDestination],
  );
  const output = execFileSync(command.file, command.args, {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const metadata = JSON.parse(output);
  if (!Array.isArray(metadata) || metadata.length === 0 || typeof metadata[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output from ${packageRoot}: ${output}`);
  }
  return metadata[0] as { filename: string; files: Array<{ path: string }> };
}

describe("skills catalog package artifacts", () => {
  const cleanup: string[] = [];

  function createPackDestination() {
    const destination = mkdtempSync(
      path.join(tmpdir(), "paperclip skills & ^ catalog pack-"),
    );
    cleanup.push(destination);
    return destination;
  }

  afterEach(async () => {
    await Promise.all(cleanup.map((entry) => rm(entry, { force: true, recursive: true })));
    cleanup.length = 0;
  });

  it("passes package-manager arguments without a command shell", () => {
    const marker = "path with spaces & ^ metacharacters";
    for (const file of ["npm", "pnpm"] as const) {
      const command = packageManagerInvocation(file, [marker]);
      expect(command.args.at(-1)).toBe(marker);
      if (process.platform === "win32") {
        expect(command.file).toBe(process.execPath);
        expect(command.args[0]).toMatch(
          file === "npm" ? /npm-cli\.js$/i : /pnpm\.cjs$/i,
        );
      }

      const versionCommand = packageManagerInvocation(file, ["--version"]);
      const version = execFileSync(versionCommand.file, versionCommand.args, {
        cwd: packageRoot,
        encoding: "utf8",
      }).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("packs dist manifest and catalog files for npm artifact consumers", () => {
    let metadata = readPackMetadata(createPackDestination());

    if (!metadata.files.some((entry) => entry.path === "dist/generated/catalog.json")) {
      const command = packageManagerInvocation(
        "pnpm",
        ["--filter", "@paperclipai/skills-catalog", "build"],
      );
      execFileSync(command.file, command.args, {
        cwd: packageRoot,
        stdio: "ignore",
      });
      metadata = readPackMetadata(createPackDestination());
    }

    const paths = metadata.files.map((entry) => entry.path);

    expect(paths).toContain("dist/generated/catalog.json");
    expect(paths).toContain("generated/catalog.json");
    expect(paths).toContain("catalog/bundled/software-development/github-pr-workflow/SKILL.md");
    expect(paths).toContain("catalog/optional/browser/agent-browser/SKILL.md");
    expect(paths).toContain("package.json");
  }, 120_000);
});
