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
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
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
  const localNames = new Set(names.map((name) => name.toUpperCase()));
  for (const name of Object.keys(sanitized)) {
    if (localNames.has(name.toUpperCase()) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i.test(name)) {
      delete sanitized[name];
    }
  }
  return sanitized;
}
