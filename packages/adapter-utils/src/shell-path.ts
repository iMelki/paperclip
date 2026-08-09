import path from "node:path";

const WINDOWS_ABSOLUTE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

export function isWindowsAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_RE.test(value) || value.startsWith("\\\\");
}

export function toShellPath(value: string): string {
  const match = WINDOWS_ABSOLUTE_PATH_RE.exec(value);
  if (!match) {
    return value;
  }

  const [, drive, rest] = match;
  return `/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
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
