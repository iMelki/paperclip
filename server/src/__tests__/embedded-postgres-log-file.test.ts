import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEmbeddedPostgresLogFile } from "../embedded-postgres-log-file.js";

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
});
