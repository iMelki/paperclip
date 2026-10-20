import { spawnSync } from "node:child_process";
import { resolveNativeExecutable } from "./gate-child.mjs";

export function resolveGitLocalEnvironmentVariableNames({
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  gitExecutable = resolveNativeExecutable("git", { env }),
} = {}) {
  const result = spawn(gitExecutable, ["rev-parse", "--local-env-vars"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 128 * 1024,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    throw new Error(`Failed to enumerate Git repository-local environment variables: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = `${result.stderr ?? ""}`.trim();
    throw new Error(
      details
        ? `Failed to enumerate Git repository-local environment variables: ${details}`
        : `Failed to enumerate Git repository-local environment variables (exit ${result.status ?? "unknown"}).`,
    );
  }

  return [
    ...new Set(
      `${result.stdout ?? ""}`
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

export function sanitizeGitLocalEnvironment(env, names) {
  const sanitized = { ...env };
  for (const name of names) {
    delete sanitized[name];
  }
  return sanitized;
}
