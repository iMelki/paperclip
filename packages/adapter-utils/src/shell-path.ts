const WINDOWS_ABSOLUTE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

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
