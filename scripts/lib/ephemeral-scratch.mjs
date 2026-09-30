#!/usr/bin/env node
// Canonical primitive: ephemeral scratch directories and files.
//
// DOCTRINE -- conform at the producer, do not enumerate at the consumer.
// A sweeper that keeps an allow-list of each producer's naming quirk fails
// silently and without bound: the next producer added is invisible to it, and
// nobody finds out until an unrelated symptom (a full disk, an unswept secret)
// surfaces. The 2026-08-13 workspace survey measured that failure exactly:
// ONE sweeper, covering ONE prefix (`paperclip-`), in ONE root, for
// DIRECTORIES ONLY, against 1,171 distinct scratch-prefix literals across
// 1,523 files in 28 areas -- 30.4 GB / 984,265 files in %LOCALAPPDATA%\Temp,
// 212 roots of it carrying live-shaped secret material.
//
// The fix is one convention at creation time, so a single rule covers every
// producer, present and future:
//
//     eph-<owner>-<purpose>-<YYYYMMDDTHHMMSSZ>-<rand6>
//
// `eph-` is the load-bearing token. One glob (`eph-*`) matches every
// conforming producer forever. Everything else the sweeper finds is REPORTED
// as non-conforming rather than ignored, which is what turns an invisible
// producer into a visible one.
//
// Companion surfaces:
//   PowerShell : shared/tools/EphemeralScratch.psm1
//   Sweeper    : shared/tools/Invoke-EphemeralScratchSweep.ps1
//   Doctrine   : shared/skills/ephemeral-scratch-convention/SKILL.md
//   Ratchet    : git-toolkit health check `ratchet-ephemeral-scratch`
//
// GH: iMelki/agent-settings #586, iMelki/paperclip #56
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EPHEMERAL_PREFIX = "eph-";

/**
 * The single rule the sweeper matches. Fields are lowercase alphanumeric so
 * `-` is an unambiguous separator and the name can be parsed back apart.
 *   owner   - the repo/tool that created it (attribution when it leaks)
 *   purpose - what it held (a human can triage without opening it)
 *   stamp   - UTC creation time ENCODED IN THE NAME, so age survives a failed
 *             stat() and a filesystem with no reliable birthtime
 *   unique  - collision suffix
 */
export const EPHEMERAL_NAME_PATTERN =
  /^eph-([a-z0-9]{2,24})-([a-z0-9]{2,32})-(\d{8}T\d{6}Z)-([a-z0-9]{6})$/;

const SLUG_PATTERN = /^[a-z0-9]+$/;

function assertSlug(value, field, min, max) {
  const slug = String(value ?? "");
  if (!SLUG_PATTERN.test(slug) || slug.length < min || slug.length > max) {
    throw new TypeError(
      `ephemeral-scratch: ${field} must be ${min}-${max} lowercase alphanumeric ` +
        `characters (no separators); got ${JSON.stringify(value)}`,
    );
  }
  return slug;
}

/** UTC stamp in the exact shape EPHEMERAL_NAME_PATTERN expects. */
export function ephemeralStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * The root every conforming producer must use.
 *
 * The survey established that %TEMP%, %TMP% and %LOCALAPPDATA%\Temp are ONE
 * path, and that os.tmpdir() / [IO.Path]::GetTempPath() /
 * tempfile.gettempdir() all resolve there. S:\tmp is reached only by
 * hand-written paths, which is why it accumulated whole repo worktrees rather
 * than harness fixtures. So: always the runtime temp root, never a literal.
 */
export function ephemeralRoot() {
  return os.tmpdir();
}

/**
 * Six lowercase-alphanumeric characters.
 *
 * Deliberately NOT mkdtemp's suffix: mkdtemp draws from a mixed-case alphabet,
 * so `mkdtempSync(prefix)` yields names like `...-rE86on` that fail this
 * module's own grammar. The two halves of this primitive disagreed on exactly
 * that during the promotion self-test -- the Node half produced a name the
 * PowerShell half rejected. One grammar or no grammar.
 */
function uniqueSuffix() {
  let out = "";
  while (out.length < 6) out += Math.random().toString(36).slice(2).replace(/[^a-z0-9]/g, "");
  return out.slice(0, 6);
}

/** Build a conforming name, complete with its unique suffix. */
export function ephemeralName({ owner, purpose, date, unique } = {}) {
  const ownerSlug = assertSlug(owner, "owner", 2, 24);
  const purposeSlug = assertSlug(purpose, "purpose", 2, 32);
  const suffix = unique ?? uniqueSuffix();
  return `${EPHEMERAL_PREFIX}${ownerSlug}-${purposeSlug}-${ephemeralStamp(date)}-${suffix}`;
}

/** True when `name` is governed by the convention (and therefore sweepable). */
export function isEphemeralName(name) {
  return EPHEMERAL_NAME_PATTERN.test(String(name ?? ""));
}

/** Parse a conforming name back into its fields, or null if non-conforming. */
export function parseEphemeralName(name) {
  const match = EPHEMERAL_NAME_PATTERN.exec(String(name ?? ""));
  if (!match) return null;
  const [, owner, purpose, stamp, unique] = match;
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const createdAt = new Date(iso);
  return {
    owner,
    purpose,
    unique,
    createdAt: Number.isNaN(createdAt.getTime()) ? null : createdAt,
  };
}

/**
 * Create an ephemeral scratch DIRECTORY. This is the call that replaces every
 * hand-rolled `mkdtempSync(path.join(os.tmpdir(), "whatever-"))`.
 */
export function createEphemeralDir({ owner, purpose, root, date } = {}) {
  const base = root ?? ephemeralRoot();
  mkdirSync(base, { recursive: true });
  // Non-recursive mkdir is the exclusive-create primitive: it throws EEXIST
  // rather than silently sharing a directory, so this keeps mkdtemp's
  // collision guarantee while keeping mkdtemp's mixed-case alphabet out.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dir = path.join(base, ephemeralName({ owner, purpose, date }));
    try {
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("ephemeral-scratch: could not create a unique scratch directory in 8 attempts");
}

/**
 * Create an ephemeral scratch FILE at the temp root.
 *
 * Loose files exist because production code writes them: the survey found 61
 * `health-<ts>.txt` files written by openai-proxy's codex provider on a normal
 * request path, plus 2,904 loose files / 104.2 MB total -- all structurally
 * invisible to a sweeper that tests `entry.isDirectory()` first. Naming them
 * by the same convention is what brings them into scope.
 */
export function createEphemeralFile({ owner, purpose, ext, root, contents, date } = {}) {
  const base = root ?? ephemeralRoot();
  mkdirSync(base, { recursive: true });
  const suffix = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : "";
  const file = path.join(base, `${ephemeralName({ owner, purpose, date })}${suffix}`);
  writeFileSync(file, contents ?? "", { flag: "wx" });
  return file;
}

/**
 * Environment for a child process that should write ALL its temp output inside
 * `dir` -- i.e. one sweepable root per run instead of scattered siblings.
 *
 * THIS IS THE CONTAINMENT BUG FIX. paperclip's run-vitest-stable.mjs set only
 * TMPDIR, which is POSIX-only: on Windows, Node resolves os.tmpdir() from
 * TEMP -> TMP -> %SystemRoot%\temp and ignores TMPDIR entirely. Python DOES
 * honour TMPDIR, so a mixed-runtime harness half-contained itself and a design
 * meant to yield ONE root per run produced 3,181 siblings instead. Set all
 * three or contain nothing.
 */
export function ephemeralChildEnv(dir) {
  if (!dir) throw new TypeError("ephemeral-scratch: ephemeralChildEnv requires a directory");
  mkdirSync(dir, { recursive: true });
  return { TEMP: dir, TMP: dir, TMPDIR: dir };
}

export default {
  EPHEMERAL_PREFIX,
  EPHEMERAL_NAME_PATTERN,
  createEphemeralDir,
  createEphemeralFile,
  ephemeralChildEnv,
  ephemeralName,
  ephemeralRoot,
  ephemeralStamp,
  isEphemeralName,
  parseEphemeralName,
};
