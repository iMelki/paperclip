import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMatchingEmbeddedPostgresDirectory, EmbeddedPostgresDirectoryIdentityError, readRunningEmbeddedPostgres } from "../embedded-postgres-reuse.js";

const { probe, warn } = vi.hoisted(() => ({ probe: vi.fn(), warn: vi.fn() }));
vi.mock("@paperclipai/db", () => ({ getPostgresDataDirectory: probe }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn } }));

describe("embedded PostgreSQL reuse identity", () => {
  let dataDir: string;
  let pidFile: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), "embedded-pg-identity-"));
    pidFile = join(dataDir, "postmaster.pid");
    probe.mockResolvedValue(dataDir);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  function writePid(pid: string = "4242", port = "55432") {
    writeFileSync(pidFile, `${pid}\n${dataDir}\n1700000000\n${port}\n\nlocalhost\n\nready\n`);
  }

  it("does not reuse a recycled PID owned by this Node process", async () => {
    writePid(String(process.pid));
    probe.mockResolvedValue(null); // The PostgreSQL port is closed, but the PID is alive.
    const original = readFileSync(pidFile, "utf8");

    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(process.kill).toHaveBeenCalledWith(process.pid, 0);
    expect(probe).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:55432/postgres");
    expect(warn).toHaveBeenCalledWith(
      { pid: process.pid, port: 55432 },
      expect.stringContaining("treating postmaster.pid as stale"),
    );
    expect(readFileSync(pidFile, "utf8")).toBe(original);
  });

  it("reuses a live PostgreSQL server with the matching data directory", async () => {
    writePid();
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: 4242, port: 55432 });
    expect(probe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("probes and reuses the recorded port when the configured port differs", async () => {
    writePid(String(process.pid), "55433\r");
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: process.pid, port: 55433 });
    expect(probe).toHaveBeenCalledWith("postgres://paperclip:paperclip@127.0.0.1:55433/postgres");
  });

  it("does not reuse a dead PID", async () => {
    writePid();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("checks PostgreSQL identity when PID liveness is inaccessible", async () => {
    writePid();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toEqual({ pid: 4242, port: 55432 });
  });

  it("does not reuse a missing PID file", async () => {
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1oops", "1.5", "9007199254740992"])("does not reuse invalid PID %s", async (pid) => {
    writePid(pid);
    expect(await readRunningEmbeddedPostgres(dataDir, 55432)).toBeNull();
    expect(process.kill).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses another PostgreSQL data directory and preserves the lock", async () => {
    writePid();
    const other = resolve(dataDir, "another-instance");
    mkdirSync(other);
    probe.mockResolvedValue(other);
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("data directory belongs to another instance");
    expect(existsSync(pidFile)).toBe(true);
  });

  it.each(["0", "65536", "55432oops"])("refuses invalid recorded port %s without discarding the lock", async (port) => {
    writePid(String(process.pid), port);
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("invalid port");
    expect(existsSync(pidFile)).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["present", "EPERM", "EIO"].flatMap((liveness) =>
    [null, "database system is starting up", "permission denied"].map((failure) => ({ liveness, failure })),
  ))(
    "refuses a live foreign PID when the identity query is unavailable: $liveness / $failure", async ({ liveness, failure }) => {
      writePid();
      const original = readFileSync(pidFile, "utf8");
      if (liveness !== "present") vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("process lookup unavailable"), { code: liveness });
      });
      if (failure === null) probe.mockResolvedValue(null);
      else probe.mockRejectedValue(new Error(failure));
      await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects.toThrow("identity could not be verified");
      expect(readFileSync(pidFile, "utf8")).toBe(original);
    },
  );
  it("reuses the actual directory through a native junction or symlink", async () => {
    writePid();
    const alias = `${dataDir}-alias`;
    symlinkSync(dataDir, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await readRunningEmbeddedPostgres(alias, 55432)).toEqual({ pid: 4242, port: 55432 });
  });

  it("uses the filesystem case contract instead of unconditional case folding", async () => {
    writePid();
    const variant = dataDir.toUpperCase();
    if (existsSync(variant)) {
      expect(await readRunningEmbeddedPostgres(variant, 55432)).toEqual({ pid: 4242, port: 55432 });
    } else {
      expect(() => assertMatchingEmbeddedPostgresDirectory(dataDir, variant))
        .toThrow(EmbeddedPostgresDirectoryIdentityError);
    }
  });

  it("does not merge case-distinct directories on a case-sensitive filesystem", () => {
    const upper = resolve(dataDir, "Case");
    const lower = resolve(dataDir, "case");
    mkdirSync(upper);
    if (existsSync(lower)) {
      expect(() => assertMatchingEmbeddedPostgresDirectory(upper, lower)).not.toThrow();
    } else {
      mkdirSync(lower);
      expect(() => assertMatchingEmbeddedPostgresDirectory(upper, lower))
        .toThrow("data directory belongs to another instance");
    }
  });

  it("refuses a reported file and retains the PID file", async () => {
    writePid();
    const original = readFileSync(pidFile, "utf8");
    probe.mockResolvedValue(pidFile);
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects
      .toThrow("data directory identity could not be verified");
    expect(readFileSync(pidFile, "utf8")).toBe(original);
  });

  it.each([1, 2, 3, 4])("refuses native resolution failure at boundary %s without discarding the lock", async (failureAt) => {
    writePid();
    const original = readFileSync(pidFile, "utf8");
    const canonical = realpathSync.native(dataDir, { encoding: "buffer" });
    const native = vi.spyOn(realpathSync, "native");
    for (let i = 1; i < failureAt; i += 1) native.mockReturnValueOnce(canonical);
    native.mockImplementationOnce(() => { throw Object.assign(new Error("native lookup unavailable"), { code: "EIO" }); });
    await expect(readRunningEmbeddedPostgres(dataDir, 55432)).rejects
      .toThrow("data directory identity could not be verified");
    expect(readFileSync(pidFile, "utf8")).toBe(original);
  });

  it("refuses observable alias retargeting", () => {
    const other = resolve(dataDir, "other");
    mkdirSync(other);
    const canonical = realpathSync.native(dataDir, { encoding: "buffer" });
    const retargeted = realpathSync.native(other, { encoding: "buffer" });
    vi.spyOn(realpathSync, "native")
      .mockReturnValueOnce(canonical)
      .mockReturnValueOnce(canonical)
      .mockReturnValueOnce(retargeted);
    expect(() => assertMatchingEmbeddedPostgresDirectory(dataDir, dataDir))
      .toThrow("data directory identity could not be verified");
  });

});
