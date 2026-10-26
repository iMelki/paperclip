import { createHash } from "node:crypto";
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
  const data = path.resolve(dataDir);
  // One file per data directory: two instances can share a log directory (PAPERCLIP_LOG_DIR), and
  // on Windows a shared name would be a file one instance's pg_ctl holds open.
  const identity = canonicalPath(dataDir);
  const instance = createHash("sha256")
    .update(process.platform === "win32" ? identity.toLowerCase() : identity)
    .digest("hex")
    .slice(0, 8);
  const preferred = path.join(path.resolve(logsDir), `postgres-${instance}.log`);
  // Compared by physical location: a data directory that is a symlink or junction to a
  // directory containing the logs directory is still the same tree. Only the comparison uses
  // the resolved form; the returned path keeps the caller's spelling, because the native
  // resolver can rewrite a drive-letter path (mapped drive, folder redirection) to a UNC path
  // that the patched dependency refuses.
  if (!isInside(identity, canonicalPath(preferred))) return preferred;
  return path.join(path.dirname(data), `${path.basename(data)}-postgres.log`);
}
