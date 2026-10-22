import { realpathSync } from "node:fs";
import path from "node:path";

function isInside(parent: string, child: string): boolean {
  const win = process.platform === "win32";
  const rel = path.relative(win ? parent.toLowerCase() : parent, win ? child.toLowerCase() : child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * `target` with symlinks and junctions resolved. A path that does not exist yet is resolved
 * through its nearest existing ancestor, so a log directory that is created later still
 * lands where it will physically be.
 */
function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const pending: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Where the embedded PostgreSQL server log goes. The log must stay outside the data
 * directory (Windows pg_ctl keeps it open, so crash recovery cannot fsync it there), but a
 * custom data directory can be an ancestor of the default logs directory. In that case the
 * log moves to a sibling of the data directory instead of blocking startup.
 */
export function resolveEmbeddedPostgresLogFile(dataDir: string, logsDir: string): string {
  // Compared by physical location: a data directory that is a symlink or junction to a
  // directory containing the logs directory is still the same tree.
  const data = canonicalPath(dataDir);
  const preferred = path.join(canonicalPath(logsDir), "postgres.log");
  if (!isInside(data, preferred)) return preferred;
  return path.join(path.dirname(data), `${path.basename(data)}-postgres.log`);
}
