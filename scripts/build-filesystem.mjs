import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function resolveBuildPath(input, cwd) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Build paths must be non-empty strings");
  }

  const root = path.resolve(cwd);
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Build path must stay below the package directory: ${input}`);
  }
  return resolved;
}

export function copyBuildFile(source, destination, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = resolveBuildPath(source, cwd);
  const destinationPath = resolveBuildPath(destination, cwd);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  return destinationPath;
}

export function copyBuildTree(source, destination, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const sourcePath = resolveBuildPath(source, cwd);
  const destinationPath = resolveBuildPath(destination, cwd);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
  });
  return destinationPath;
}

export function removeBuildPath(target, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const targetPath = resolveBuildPath(target, cwd);
  rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  return targetPath;
}

export function executableMode(mode, platform = process.platform) {
  return platform === "win32" ? null : (mode & 0o777) | 0o111;
}

export function makeBuildFileExecutable(target, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const targetPath = resolveBuildPath(target, cwd);
  const stats = statSync(targetPath);
  if (!stats.isFile()) {
    throw new Error(`Executable build path must be a file: ${target}`);
  }

  const mode = executableMode(stats.mode, platform);
  if (mode !== null) chmodSync(targetPath, mode);
  return targetPath;
}

function requireArguments(command, args, minimum) {
  if (args.length < minimum) {
    throw new Error(`${command} requires at least ${minimum} path argument(s)`);
  }
}

function requirePairs(command, args) {
  if (args.length < 2 || args.length % 2 !== 0) {
    throw new Error(`${command} requires source/destination path pairs`);
  }
}

export function runBuildFilesystemCommand(argv, options = {}) {
  const [command, ...args] = argv;
  const cwd = options.cwd ?? process.cwd();

  switch (command) {
    case "copy-file":
      requirePairs(command, args);
      for (let index = 0; index < args.length; index += 2) {
        copyBuildFile(args[index], args[index + 1], { cwd });
      }
      return;
    case "copy-tree":
      requirePairs(command, args);
      for (let index = 0; index < args.length; index += 2) {
        copyBuildTree(args[index], args[index + 1], { cwd });
      }
      return;
    case "remove":
      requireArguments(command, args, 1);
      for (const target of args) removeBuildPath(target, { cwd });
      return;
    case "make-executable":
      requireArguments(command, args, 1);
      for (const target of args) makeBuildFileExecutable(target, { cwd });
      return;
    default:
      throw new Error(
        "Usage: build-filesystem.mjs <copy-file|copy-tree|remove|make-executable> <paths...>",
      );
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    runBuildFilesystemCommand(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[build-filesystem] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
