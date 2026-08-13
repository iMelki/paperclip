import fs from "node:fs";
import path from "node:path";

interface TestShellResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
}

function readWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const match = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function windowsPathEntries(env: NodeJS.ProcessEnv): string[] {
  const value = readWindowsEnv(env, "PATH");
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function addUniqueWindowsPath(paths: string[], candidate: string | undefined): void {
  if (!candidate) return;
  const normalized = path.win32.normalize(candidate);
  if (!paths.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    paths.push(normalized);
  }
}

function collectGitRootsFromPath(
  entries: string[],
  existsSync: (candidate: string) => boolean,
): string[] {
  const roots: string[] = [];
  for (const entry of entries) {
    if (!existsSync(path.win32.join(entry, "git.exe"))) continue;
    let ancestor = path.win32.normalize(entry);
    for (let depth = 0; depth < 4; depth += 1) {
      addUniqueWindowsPath(roots, ancestor);
      const parent = path.win32.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return roots;
}

function addKnownGitRoots(roots: string[], env: NodeJS.ProcessEnv): void {
  const programFiles = readWindowsEnv(env, "ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = readWindowsEnv(env, "ProgramFiles(x86)");
  const localAppData = readWindowsEnv(env, "LOCALAPPDATA");
  const userProfile = readWindowsEnv(env, "USERPROFILE");

  addUniqueWindowsPath(roots, path.win32.join(programFiles, "Git"));
  addUniqueWindowsPath(roots, programFilesX86 && path.win32.join(programFilesX86, "Git"));
  addUniqueWindowsPath(roots, localAppData && path.win32.join(localAppData, "Programs", "Git"));
  addUniqueWindowsPath(
    roots,
    userProfile && path.win32.join(userProfile, "scoop", "apps", "git", "current"),
  );
}

export function resolveTestShellCommand(
  command: string,
  options: TestShellResolutionOptions = {},
): string {
  if (command !== "sh" && command !== "bash") {
    return command;
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return command === "bash" ? "/bin/bash" : "/bin/sh";
  }

  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const pathEntries = windowsPathEntries(env);
  const roots = collectGitRootsFromPath(pathEntries, existsSync);
  addKnownGitRoots(roots, env);

  for (const root of roots) {
    // Git's launcher under bin/ seeds /usr/bin and /mingw64/bin for non-login
    // shells. Invoking usr/bin/sh.exe directly inherits the Windows PATH as-is,
    // which leaves core tools such as mkdir, rm, and base64 undiscoverable.
    const candidate = path.win32.join(root, "bin", `${command}.exe`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const entry of pathEntries) {
    const candidate = path.win32.join(entry, `${command}.exe`);
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Unable to locate a usable Git for Windows ${command}.exe launcher. ` +
      "Install Git for Windows or add its cmd directory to PATH.",
  );
}

export function resolveTestScriptSpawn(command: string): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:c|m)?js$/i.test(command)) {
    return { command: process.execPath, args: [command] };
  }
  return { command, args: [] };
}
