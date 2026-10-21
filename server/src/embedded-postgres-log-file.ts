import path from "node:path";

function isInside(parent: string, child: string): boolean {
  const win = process.platform === "win32";
  const rel = path.relative(win ? parent.toLowerCase() : parent, win ? child.toLowerCase() : child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Where the embedded PostgreSQL server log goes. The log must stay outside the data
 * directory (Windows pg_ctl keeps it open, so crash recovery cannot fsync it there), but a
 * custom data directory can be an ancestor of the default logs directory. In that case the
 * log moves to a sibling of the data directory instead of blocking startup.
 */
export function resolveEmbeddedPostgresLogFile(dataDir: string, logsDir: string): string {
  const preferred = path.resolve(logsDir, "postgres.log");
  const data = path.resolve(dataDir);
  if (!isInside(data, preferred)) return preferred;
  return path.join(path.dirname(data), `${path.basename(data)}-postgres.log`);
}
