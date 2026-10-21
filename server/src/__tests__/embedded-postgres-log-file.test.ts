import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEmbeddedPostgresLogFile } from "../embedded-postgres-log-file.js";

describe("resolveEmbeddedPostgresLogFile", () => {
  const root = path.resolve("/srv/paperclip");

  it("uses the default logs directory when it is outside the data directory", () => {
    expect(resolveEmbeddedPostgresLogFile(path.join(root, "db"), path.join(root, "logs"))).toBe(
      path.join(root, "logs", "postgres.log"),
    );
    expect(resolveEmbeddedPostgresLogFile(path.join(root, "db"), path.join(root, "db-logs"))).toBe(
      path.join(root, "db-logs", "postgres.log"),
    );
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
});
