import path from "node:path";

const WINDOWS_ABSOLUTE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;
const WINDOWS_UNC_PATH_RE = /^\\\\([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/;

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_RE.test(value) || value.startsWith("\\\\");
}

export function toShellPath(value: string): string {
  const match = WINDOWS_ABSOLUTE_PATH_RE.exec(value);
  if (match) {
    const [, drive, rest] = match;
    return `/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
  }

  if (!value.startsWith("\\\\")) {
    return value;
  }

  const uncMatch = WINDOWS_UNC_PATH_RE.exec(value);
  if (!uncMatch || uncMatch[1] === "?" || uncMatch[1] === ".") {
    throw new Error(`Unsupported Windows network or device path for POSIX shell: ${value}`);
  }

  const [, server, share, rest] = uncMatch;
  const suffix = rest == null ? "" : `/${rest.replace(/\\/g, "/")}`;
  return `//${server}/${share}${suffix}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function shellQuotePath(value: string): string {
  return shellQuote(toShellPath(value));
}

export function joinPortablePath(root: string, ...segments: string[]): string {
  return isWindowsAbsolutePath(root)
    ? path.win32.join(root, ...segments)
    : path.posix.join(root, ...segments);
}

export function dirnamePortablePath(value: string): string {
  return isWindowsAbsolutePath(value)
    ? path.win32.dirname(value)
    : path.posix.dirname(value);
}
