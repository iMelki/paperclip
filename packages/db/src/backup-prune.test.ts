import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneOldBackups } from "./backup-lib.js";

// Fixed "now" far from any month boundary so the tier cutoffs are unambiguous.
const NOW = new Date("2026-10-15T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };
const dirs: string[] = [];

function dir(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-prune-test-"));
  dirs.push(created);
  return created;
}

function touch(file: string, ageDays: number): void {
  const when = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, when, when);
}

/** One published dump plus the second hard link the preserve-all path leaves behind. */
function preserved(backupDir: string, name: string, ageDays: number): { final: string; partial: string } {
  const final = path.join(backupDir, name);
  const partial = `${final}.partial-${randomUUID()}`;
  fs.writeFileSync(partial, `dump ${name}`);
  fs.linkSync(partial, final);
  touch(partial, ageDays);
  return { final, partial };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("pruneOldBackups and preserve-all hard links", () => {
  it("removes the .partial-<uuid> hard link with its pruned backup so the inode is released", () => {
    const backupDir = dir();
    const expired = preserved(backupDir, "paperclip-20200101-000000.sql.gz", 400);
    const recent = preserved(backupDir, "paperclip-20261014-000000.sql.gz", 1);
    expect(fs.statSync(expired.final).nlink).toBe(2);

    expect(pruneOldBackups(backupDir, retention, "paperclip")).toBe(1);

    expect(fs.existsSync(expired.final)).toBe(false);
    expect(fs.existsSync(expired.partial)).toBe(false);
    expect(fs.existsSync(recent.final)).toBe(true);
    expect(fs.existsSync(recent.partial)).toBe(true);
    expect(fs.statSync(recent.final).nlink).toBe(2);
  });

  it("keeps the partial link of every backup that retention keeps", () => {
    const backupDir = dir();
    const keptWeekly = preserved(backupDir, "paperclip-20260928-000000.sql.gz", 17);
    expect(pruneOldBackups(backupDir, retention, "paperclip")).toBe(0);
    expect(fs.existsSync(keptWeekly.final)).toBe(true);
    expect(fs.existsSync(keptWeekly.partial)).toBe(true);
  });

  it("removes only the partial links of the pruned backup within a week bucket", () => {
    const backupDir = dir();
    // 2026-09-29 and 2026-09-30 fall in the same ISO week; only the newest is kept.
    const older = preserved(backupDir, "paperclip-20260929-000000.sql.gz", 16);
    const newer = preserved(backupDir, "paperclip-20260930-000000.sql.gz", 15);
    expect(pruneOldBackups(backupDir, retention, "paperclip")).toBe(1);
    expect(fs.existsSync(older.final) || fs.existsSync(older.partial)).toBe(false);
    expect(fs.existsSync(newer.final) && fs.existsSync(newer.partial)).toBe(true);
  });

  it("deletes an orphaned partial only beyond every retention tier and never lets it displace a real backup", () => {
    const backupDir = dir();
    const realBackup = path.join(backupDir, "paperclip-20260928-000000.sql.gz");
    fs.writeFileSync(realBackup, "real");
    touch(realBackup, 17);
    // Newer than the real weekly backup and in the same week: must not displace it.
    const failedNewer = path.join(backupDir, `paperclip-20260929-000000.sql.gz.partial-${randomUUID()}`);
    fs.writeFileSync(failedNewer, "failed staging");
    touch(failedNewer, 16);
    const failedAncient = path.join(backupDir, `paperclip-20190101-000000.sql.gz.partial-${randomUUID()}`);
    fs.writeFileSync(failedAncient, "failed staging, ancient");
    touch(failedAncient, 2000);

    expect(pruneOldBackups(backupDir, retention, "paperclip")).toBe(1);

    expect(fs.existsSync(realBackup)).toBe(true);
    expect(fs.existsSync(failedNewer)).toBe(true);
    expect(fs.existsSync(failedAncient)).toBe(false);
  });

  it("leaves other prefixes and non-uuid look-alike names untouched", () => {
    const backupDir = dir();
    const other = preserved(backupDir, "other-20200101-000000.sql.gz", 400);
    const lookalike = path.join(backupDir, "paperclip-20200101-000000.sql.gz.partial-notes");
    fs.writeFileSync(lookalike, "operator file");
    touch(lookalike, 400);
    expect(pruneOldBackups(backupDir, retention, "paperclip")).toBe(0);
    expect(fs.existsSync(other.final) && fs.existsSync(other.partial)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(true);
  });
});
