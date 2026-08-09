#!/usr/bin/env node
// Self-healing sweep for stale `paperclip-*` test temp directories (#33).
//
// Test fixtures create per-run directories under os.tmpdir() and rely on
// happy-path teardown to remove them. Any run that is killed, times out, or
// aborts mid-cascade leaks its directories permanently — observed at 6,447
// dirs / 8.4 GB (2026-08-06) and again at 4,208 dirs two days later. This
// sweep runs at test-runner startup so every run self-heals the host.
//
// Safety properties:
// - only directories whose name starts with `paperclip-` are considered
// - anything matching /host-validation/ is preserved (live evidence, see #33)
// - a directory is stale only when BOTH its creation and last-write times are
//   older than the age cutoff, so an old-but-active directory is never removed
// - removal failures (EBUSY from a live process handle) are skipped, not fatal
import { readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_AGE_HOURS = 6;
const PRESERVE_PATTERN = /host-validation/i;

function resolveMaxAgeHours(override) {
  const fromEnv = Number.parseFloat(process.env.PAPERCLIP_TEST_TEMP_MAX_AGE_HOURS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_MAX_AGE_HOURS;
}

export function cleanStaleTestTempDirs(options = {}) {
  const log = options.log ?? (() => {});
  if (process.env.PAPERCLIP_TEST_TEMP_SWEEP === "0") {
    log("stale temp sweep disabled via PAPERCLIP_TEST_TEMP_SWEEP=0");
    return { removed: 0, kept: 0, preserved: 0, failed: 0, disabled: true };
  }
  const maxAgeHours = resolveMaxAgeHours(options.maxAgeHours);
  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const tmpDir = os.tmpdir();
  let removed = 0;
  let kept = 0;
  let preserved = 0;
  let failed = 0;

  let entries;
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { removed, kept, preserved, failed, disabled: false };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-")) continue;
    if (PRESERVE_PATTERN.test(entry.name)) {
      preserved += 1;
      continue;
    }
    const fullPath = path.join(tmpDir, entry.name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    // Stale only when neither created nor written since the cutoff.
    const newestActivityMs = Math.max(stats.birthtimeMs || 0, stats.mtimeMs || 0);
    if (newestActivityMs >= cutoffMs) {
      kept += 1;
      continue;
    }
    try {
      rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  log(
    `stale temp sweep (> ${maxAgeHours}h): removed ${removed}, kept ${kept} recent, `
    + `preserved ${preserved}, ${failed} busy/failed`,
  );
  return { removed, kept, preserved, failed, disabled: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const overrideArg = Number.parseFloat(process.argv[2] ?? "");
  cleanStaleTestTempDirs({
    maxAgeHours: Number.isFinite(overrideArg) ? overrideArg : undefined,
    log: (message) => console.log(`[clean-stale-test-temp] ${message}`),
  });
}
