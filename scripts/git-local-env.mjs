import { spawnSync } from "node:child_process";

export function resolveGitLocalEnvironmentVariableNames({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
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
