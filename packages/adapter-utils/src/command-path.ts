import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export interface ResolveCommandPathOptions {
  platform?: NodeJS.Platform;
  access?: (candidate: string, mode: number) => Promise<void>;
  stat?: (candidate: string) => Promise<{ isFile: () => boolean }>;
  fallbackEnv?: NodeJS.ProcessEnv;
}

// Microsoft documents this order as the default PATHEXT contract. Keep the
// extensionless fallback below for native executables and compatibility with
// the previous resolver. Source: learn.microsoft.com/windows-server/
// administration/windows-commands/start (PATHEXT remarks).
const DEFAULT_WINDOWS_PATHEXT =
  ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
const DEFAULT_POSIX_PATH = "/usr/bin:/bin";

function readEnvValue(
  env: NodeJS.ProcessEnv,
  name: "PATH" | "PATHEXT",
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  // Node sorts Windows environment keys and passes the first
  // case-insensitive match to a child process. Mirror that deterministic rule.
  const matchingKey = Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === name);
  return matchingKey ? env[matchingKey] : undefined;
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (readEnvValue(env, "PATHEXT", "win32") ?? DEFAULT_WINDOWS_PATHEXT)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isPathLikeCommand(command: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
  }
  return command.includes("/");
}

async function isAccessibleCommandPath(
  candidate: string,
  accessMode: number,
  access: (candidate: string, mode: number) => Promise<void>,
  stat: (candidate: string) => Promise<{ isFile: () => boolean }>,
): Promise<boolean> {
  try {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isFile()) return false;
    await access(candidate, accessMode);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommandPath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: ResolveCommandPathOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const access = options.access ?? fs.access;
  const stat = options.stat ?? fs.stat;
  const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;

  if (isPathLikeCommand(command, platform)) {
    const candidate = pathApi.isAbsolute(command) ? command : pathApi.resolve(cwd, command);
    return (await isAccessibleCommandPath(candidate, accessMode, access, stat))
      ? candidate
      : null;
  }

  const configuredPath = readEnvValue(env, "PATH", platform);
  // Node uses the current process PATH when a supplied Windows child env omits
  // PATH. fallbackEnv keeps that behavior deterministic in cross-platform tests.
  const fallbackPath =
    platform === "win32"
      ? readEnvValue(options.fallbackEnv ?? process.env, "PATH", platform)
      : DEFAULT_POSIX_PATH;
  const pathValue = configuredPath ?? fallbackPath ?? "";
  // An empty PATH segment denotes the current directory on POSIX. Resolving
  // every segment against cwd also preserves relative PATH entries.
  const directories = pathValue.split(pathApi.delimiter);
  const extensions =
    platform === "win32" && pathApi.extname(command).length === 0
      ? [...windowsPathExts(env), ""]
      : [""];

  for (const directory of directories) {
    const resolvedDirectory = pathApi.isAbsolute(directory)
      ? directory
      : pathApi.resolve(cwd, directory);
    for (const extension of extensions) {
      const candidate = pathApi.join(resolvedDirectory, `${command}${extension}`);
      if (await isAccessibleCommandPath(candidate, accessMode, access, stat)) return candidate;
    }
  }

  return null;
}
