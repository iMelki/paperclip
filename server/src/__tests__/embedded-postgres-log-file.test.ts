import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isPgCtlSafeLogPath, resolveEmbeddedPostgresLogFile } from "../embedded-postgres-log-file.js";

const PER_INSTANCE_LOG = /^postgres-[0-9a-f]{8}\.log$/;

describe("resolveEmbeddedPostgresLogFile", () => {
  const root = path.resolve("/srv/paperclip");
  const scratch: string[] = [];
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the default logs directory when it is outside the data directory", () => {
    const log = resolveEmbeddedPostgresLogFile(path.join(root, "db"), path.join(root, "logs"));
    expect(path.dirname(log)).toBe(path.join(root, "logs"));
    expect(path.basename(log)).toMatch(PER_INSTANCE_LOG);
    const other = resolveEmbeddedPostgresLogFile(path.join(root, "db"), path.join(root, "db-logs"));
    expect(path.dirname(other)).toBe(path.join(root, "db-logs"));
  });

  it("gives each data directory its own log file when instances share a log directory", () => {
    const logs = path.join(root, "logs");
    const first = resolveEmbeddedPostgresLogFile(path.join(root, "one"), logs);
    const second = resolveEmbeddedPostgresLogFile(path.join(root, "two"), logs);
    expect(first).not.toBe(second);
    expect(resolveEmbeddedPostgresLogFile(path.join(root, "one"), logs)).toBe(first);
  });

  it("moves the log beside the data directory when the data directory contains the logs directory", () => {
    const instance = path.join(root, "instances", "default");
    const log = resolveEmbeddedPostgresLogFile(instance, path.join(instance, "logs"));
    expect(log).toBe(path.join(root, "instances", "default-postgres.log"));
    expect(path.relative(instance, log).startsWith("..")).toBe(true);
    expect(resolveEmbeddedPostgresLogFile(root, path.join(root, "instances", "default", "logs"))).toBe(
      path.join(path.dirname(root), "paperclip-postgres.log"),
    );
  });

  it("compares physical locations when the data directory is a symlink to a tree that holds the logs", () => {
    const physical = tempDir("pg-log-physical-");
    mkdirSync(path.join(physical, "logs"));
    const alias = path.join(tempDir("pg-log-alias-"), "data");
    symlinkSync(physical, alias);
    const log = resolveEmbeddedPostgresLogFile(alias, path.join(physical, "logs"));
    expect(path.relative(realpathSync(physical), realpathSync(path.dirname(log))).startsWith("..")).toBe(true);
    expect(log).toBe(path.join(path.dirname(alias), "data-postgres.log"));
  });

  it("resolves a logs directory that does not exist yet through its existing ancestor", () => {
    const physical = tempDir("pg-log-future-");
    const alias = path.join(tempDir("pg-log-future-alias-"), "data");
    symlinkSync(physical, alias);
    const log = resolveEmbeddedPostgresLogFile(physical, path.join(alias, "logs"));
    expect(log).toBe(path.join(path.dirname(physical), `${path.basename(physical)}-postgres.log`));
  });

  it("returns the caller's spelling of the path, not the resolved one", () => {
    const physical = tempDir("pg-log-spelling-");
    const alias = path.join(tempDir("pg-log-spelling-alias-"), "logs");
    symlinkSync(physical, alias);
    const log = resolveEmbeddedPostgresLogFile(path.join(tmpdir(), "pg-log-spelling-data"), alias);
    expect(path.dirname(log)).toBe(alias);
    expect(path.basename(log)).toMatch(PER_INSTANCE_LOG);
  });

  it("falls back beside the data directory when the dependency cannot take the preferred path", () => {
    const data = path.join(root, "db");
    const logs = path.join(root, "A & B", "logs");
    const refuseAmpersand = (file: string) => !file.includes("&");
    expect(resolveEmbeddedPostgresLogFile(data, logs, refuseAmpersand)).toBe(path.join(root, "db-postgres.log"));
    expect(resolveEmbeddedPostgresLogFile(data, logs, () => true)).toContain("A & B");
    expect(resolveEmbeddedPostgresLogFile(data, path.join(root, "logs"), refuseAmpersand)).toMatch(
      new RegExp(`postgres-[0-9a-f]{8}\\.log$`),
    );
  });

  it.runIf(process.platform === "win32")("on Windows, a UNC or ampersand log directory falls back beside the data directory", () => {
    const data = "C:\\paperclip\\db";
    const sibling = "C:\\paperclip\\db-postgres.log";
    expect(resolveEmbeddedPostgresLogFile(data, "\\\\fileserver\\logs\\paperclip")).toBe(sibling);
    expect(resolveEmbeddedPostgresLogFile(data, "C:\\Logs & Diagnostics")).toBe(sibling);
    expect(path.dirname(resolveEmbeddedPostgresLogFile(data, "D:/Logs/paperclip"))).toBe("D:\\Logs\\paperclip");
  });
});

describe("isPgCtlSafeLogPath", () => {
  it("accepts absolute drive paths, including spaces, parentheses and apostrophes", () => {
    for (const ok of [
      "C:\\paperclip\\logs\\postgres-0123abcd.log",
      "d:/paperclip/logs/postgres-0123abcd.log",
      "C:\\Program Files (x86)\\Paperclip\\logs\\postgres.log",
      "C:\\Users\\O'Neil\\logs\\postgres.log",
    ]) {
      expect(isPgCtlSafeLogPath(ok), ok).toBe(true);
    }
  });

  it("rejects UNC paths, relative paths, metacharacters and extra colons", () => {
    for (const bad of [
      "\\\\fileserver\\logs\\postgres.log",
      "//fileserver/logs/postgres.log",
      "\\\\?\\C:\\logs\\postgres.log",
      "logs\\postgres.log",
      "C:logs\\postgres.log",
      "C:\\Logs & Diagnostics\\postgres.log",
      "C:\\logs\\100%\\postgres.log",
      "C:\\logs\\a!b\\postgres.log",
      "C:\\logs\\a|b\\postgres.log",
      "C:\\logs\\a<b>\\postgres.log",
      "C:\\logs\\a^b\\postgres.log",
      "C:\\logs\\a;b\\postgres.log",
      'C:\\logs\\a"b\\postgres.log',
      "C:\\logs\\a\nb\\postgres.log",
      "C:\\logs\\stream:ads\\postgres.log",
    ]) {
      expect(isPgCtlSafeLogPath(bad), bad).toBe(false);
    }
  });

  it("matches the patched dependency's own check", () => {
    const patch = readFileSync(
      path.join(fileURLToPath(new URL("../../..", import.meta.url)), "patches", "embedded-postgres@18.1.0-beta.16.patch"),
      "utf8",
    );
    for (const fragment of [
      "/^[A-Za-z]:[\\\\/]/.test(value)",
      "/[\\x00-\\x1f\\x7f\"%!&|<>^`;*?]/.test(value)",
      "value.slice(2).includes(':')",
    ]) {
      expect(patch).toContain(fragment);
    }
  });
});
