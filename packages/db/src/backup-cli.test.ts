import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBufferedTextFileWriter, runDatabaseBackup, type RunDatabaseBackupOptions } from "./backup-lib.js";
import { PreservedBackupError, buildPgDumpInvocation, runPgDumpBackup, runPreservedPgDumpBackup, settleBackupChildPipeline } from "./backup-cli.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), postgres: vi.fn(), link: vi.fn(), open: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, link: mocks.link, open: mocks.open };
});

const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
// The server health reader is the consumer of these backups. It lives outside this
// package's tsc rootDir, so load it at runtime by URL instead of a static import
// (a static import breaks `tsc` with TS6059 for @paperclipai/db).
type BackupHealthInspector = (options: { enabled: boolean; backupDir: string; maxAgeHours: number }) => {
  status: "ok" | "warning";
  latestBackup: { path: string } | null;
};
const healthUrl = new URL("../../../server/src/services/database-backup-health.ts", import.meta.url).href;
const { inspectDatabaseBackupHealth } = (await import(/* @vite-ignore */ healthUrl)) as {
  inspectDatabaseBackupHealth: BackupHealthInspector;
};
const fixtures: string[] = [];
const sql = "CREATE TABLE public.sample (id integer);\nINSERT INTO public.sample VALUES (42);\n";
// Synthetic only: never a live endpoint or credential.
const connectionString = "postgres://fixture:synthetic-secret@invalid.invalid/fixture";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-preserve-test-"));
  fixtures.push(dir);
  return dir;
}

function options(dir: string): RunDatabaseBackupOptions {
  return {
    connectionString,
    backupDir: dir,
    retention: { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 },
    backupEngine: "pg_dump",
    preserveAll: true,
    filenamePrefix: "fixture",
  };
}

function child(input: { exitCode?: number; spawnError?: Error; streamError?: Error; stderr?: string } = {}): ChildProcess {
  const process = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(process, { stdout, stderr });
  queueMicrotask(() => {
    if (input.stderr) stderr.write(input.stderr);
    if (input.streamError) stdout.destroy(input.streamError);
    else stdout.end(sql);
    stderr.end();
    if (input.spawnError) process.emit("error", input.spawnError);
    else process.emit("exit", input.exitCode ?? 0, null);
  });
  return process as ChildProcess;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.link.mockImplementation(fs.link);
  mocks.open.mockImplementation(fs.open);
  mocks.spawn.mockImplementation(() => child());
  mocks.postgres.mockImplementation(() => { throw new Error("Unexpected JavaScript backup fallback"); });
  vi.stubEnv("PAPERCLIP_PG_DUMP_PATH", "synthetic-pg-dump");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The operator permits cleanup ONLY of these newly created synthetic fixtures.
  while (fixtures.length) {
    const dir = fixtures.pop()!;
    const parent = resolve(tmpdir()) + sep;
    if (!resolve(dir).startsWith(parent) || !basename(dir).startsWith("paperclip-preserve-test-")) {
      throw new Error("Refusing cleanup outside newly created fixture scope");
    }
    await rm(dir, { recursive: true });
  }
});

describe("settleBackupChildPipeline (upstream PR #13153 regression cases)", () => {
  it("prefers the child stderr error over the pipeline error", async () => {
    const childError = new Error("synthetic pg_dump stderr");
    await expect(settleBackupChildPipeline(Promise.reject(new Error("pipeline")), Promise.reject(childError)))
      .rejects.toBe(childError);
  });

  it("prefers spawn ENOENT over the pipeline error", async () => {
    const childError = Object.assign(new Error("missing synthetic client"), { code: "ENOENT" });
    await expect(settleBackupChildPipeline(Promise.reject(new Error("pipeline")), Promise.reject(childError)))
      .rejects.toBe(childError);
  });

  it("keeps the pipeline error when the child succeeds", async () => {
    const error = new Error("pipeline");
    await expect(settleBackupChildPipeline(Promise.reject(error), Promise.resolve())).rejects.toBe(error);
  });

  it("keeps the child error when the pipeline succeeds", async () => {
    const error = new Error("child");
    await expect(settleBackupChildPipeline(Promise.resolve(), Promise.reject(error))).rejects.toBe(error);
  });

  it("resolves only when both halves settle successfully", async () => {
    await expect(settleBackupChildPipeline(Promise.resolve(), Promise.resolve())).resolves.toBeUndefined();
  });

  it("consumes both rejections and waits for the second half", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const error = new Error("child");
    let rejectChild!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { rejectChild = reject; });
    const result = settleBackupChildPipeline(Promise.reject(new Error("pipeline")), pending);
    const caught = expect(result).rejects.toBe(error);
    try {
      await Promise.resolve();
      rejectChild(error);
      await caught;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("preserve-all native backup policy", () => {
  it("retains history and publishes one complete inode under two names after closing the writer", async () => {
    const dir = await fixture();
    const historical = join(dir, "fixture-20000101-000000.sql.gz");
    await writeFile(historical, "historical fixture");
    await fs.utimes(historical, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    let closed = false;
    mocks.open.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => { await close(); closed = true; });
      return file;
    });
    mocks.link.mockImplementation(async (partial: string, final: string) => {
      expect(closed).toBe(true);
      expect(partial.endsWith(".sql.gz")).toBe(false);
      expect(gunzipSync(await readFile(partial)).toString()).toBe(sql);
      await fs.link(partial, final);
    });
    const result = await runDatabaseBackup(options(dir));
    const names = await readdir(dir);
    expect(result).toMatchObject({ prunedCount: 0, backupEngine: "pg_dump", preservationPolicy: "preserve-all" });
    expect(result.retainedPartialFile).toBeDefined();
    expect(await readFile(historical, "utf8")).toBe("historical fixture");
    const final = await stat(result.backupFile);
    const partial = await stat(result.retainedPartialFile!);
    expect(final.ino).toBe(partial.ino);
    expect(final.nlink).toBe(2);
    expect(result.sizeBytes).toBe(final.size);
    expect(gunzipSync(await readFile(result.backupFile)).toString()).toBe(sql);
    expect(names.filter((name) => name.endsWith(".sql.gz"))).toHaveLength(2);
    expect(names.filter((name) => name.endsWith(".sql"))).toHaveLength(0);
    expect(mocks.open.mock.calls[0]?.slice(1)).toEqual(["wx", 0o600]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(inspectDatabaseBackupHealth({ enabled: true, backupDir: dir, maxAgeHours: 24 }))
      .toMatchObject({ status: "ok", latestBackup: { path: result.backupFile } });
  });

  it("never passes the password in argv and supplies it via PGPASSWORD only", async () => {
    const dir = await fixture();
    const url = "postgres://us%40er:p%40ss%2Fw%3Ard%25@db.example.invalid:5433/app%20db?sslmode=require&password=ignored-q";
    await runDatabaseBackup({ ...options(dir), connectionString: url });
    const [, args, spawnOptions] = mocks.spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const argv = args.join("\n");
    for (const secret of ["p@ss/w:rd%", "p%40ss%2Fw%3Ard%25", "ignored-q"]) expect(argv).not.toContain(secret);
    expect(args[0]).toContain("sslmode=require");
    expect(args[0]).toContain("db.example.invalid:5433");
    expect(args[0]).toContain("us%40er");
    expect(spawnOptions.env.PGPASSWORD).toBe("p@ss/w:rd%");
    expect(buildPgDumpInvocation("postgres://u@h/db?password=q%40x&sslmode=require", 5, {}).env.PGPASSWORD).toBe("q@x");
    const plain = buildPgDumpInvocation("postgres://u:p%40ss%2Fw%3Ard%25@h/db?sslmode=require", 7, {});
    expect(plain.env).toMatchObject({ PGPASSWORD: "p@ss/w:rd%", PGCONNECT_TIMEOUT: "7" });
    expect(plain.args.join(" ")).not.toMatch(/p@ss|p%40ss/);
    expect(plain.args[0]).toBe("--dbname=postgres://u@h/db?sslmode=require");
  });

  it.each([
    ["%20", "postgres://u:pw@h/db?application_name=a%20b&password=q&sslmode=require", "postgres://u@h/db?application_name=a%20b&sslmode=require"],
    ["+ stays a literal plus", "postgres://u:pw@h/db?application_name=a+b&sslmode=require", "postgres://u@h/db?application_name=a+b&sslmode=require"],
    ["%2B", "postgres://u:pw@h/db?application_name=a%2Bb&password=q", "postgres://u@h/db?application_name=a%2Bb"],
    ["%3D in a value", "postgres://u:pw@h/db?options=-c%20statement_timeout%3D0&password=q&sslmode=require", "postgres://u@h/db?options=-c%20statement_timeout%3D0&sslmode=require"],
    ["multiple params, password first", "postgres://u@h/db?password=q&a=%2F%20+%3D&b=%41&c", "postgres://u@h/db?a=%2F%20+%3D&b=%41&c"],
    ["password last, fragment kept", "postgres://u@h/db?x=1%202&password=q#frag", "postgres://u@h/db?x=1%202#frag"],
    ["only password param drops the ?", "postgres://u@h/db?password=q", "postgres://u@h/db"],
    ["no password: byte-identical", "postgres://u@h:5433/d%20b?options=-c%20x%3D1&a=b+c", "postgres://u@h:5433/d%20b?options=-c%20x%3D1&a=b+c"],
    ["encoded key name", "postgres://u@h/db?pass%77ord=q&a=%20", "postgres://u@h/db?a=%20"],
  ])("keeps the other URL bytes untouched when stripping the password: %s", (_name, input, expected) => {
    const invocation = buildPgDumpInvocation(input, 5, {});
    expect(invocation.args[0]).toBe(`--dbname=${expected}`);
  });

  it("decodes a query password as libpq does (percent only, plus stays plus)", () => {
    expect(buildPgDumpInvocation("postgres://u@h/db?password=a+b%2Bc%20d", 5, {}).env.PGPASSWORD).toBe("a+b+c d");
  });

  it("refuses sslpassword without echoing it, and never reaches argv", () => {
    for (const url of [
      "postgres://u@h/db?sslmode=require&sslpassword=key-pass-secret",
      "postgres://u@h/db?sslpass%77ord=key-pass-secret",
    ]) {
      const error = (() => { try { buildPgDumpInvocation(url, 5, {}); } catch (e) { return e as Error; } })();
      expect(error?.message).toMatch(/sslpassword/);
      expect(error?.message).not.toContain("key-pass-secret");
    }
  });

  it("surfaces the sslpassword refusal from the backup runner before spawning", async () => {
    const dir = await fixture();
    const error = await runPgDumpBackup({
      connectionString: "postgres://u@h/db?sslpassword=key-pass-secret", backupFile: join(dir, "x.sql.gz"), connectTimeout: 5,
    }).catch((v: unknown) => v);
    expect(String(error)).toMatch(/sslpassword/);
    expect(String(error)).not.toContain("key-pass-secret");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("redacts the decoded password from stderr even when only the decoded form appears", async () => {
    const dir = await fixture();
    mocks.spawn.mockImplementation(() => child({ exitCode: 1, stderr: "auth failed for p@ss/w:rd% and p%40ss%2Fw%3Ard%25 and q+x" }));
    const error = await runPgDumpBackup({
      connectionString: "postgres://u:p%40ss%2Fw%3Ard%25@h/db?password=q%2Bx", backupFile: join(dir, "x.sql.gz"), connectTimeout: 5,
    }).catch((v: unknown) => v);
    expect(String(error)).toContain("auth failed for *** and *** and ***");
    expect(String(error)).not.toMatch(/p@ss|p%40ss|q\+x/);
    const onlyDecoded = buildPgDumpInvocation("postgres://u:p%40ss@h/db", 5, {});
    expect(onlyDecoded.secrets).toContain("p@ss");
  });

  it("never mutates process.env.PGPASSWORD; the password reaches only the child env", async () => {
    const url = "postgres://u:child-only-pw@h/db";
    for (const before of [undefined, "operator-sentinel"]) {
      vi.stubEnv("PGPASSWORD", before);
      const dir = await fixture();
      mocks.spawn.mockImplementation(() => child());
      await runPgDumpBackup({ connectionString: url, backupFile: join(dir, "x.sql.gz"), connectTimeout: 5 });
      const [, , spawnOptions] = mocks.spawn.mock.calls.at(-1) as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(spawnOptions.env.PGPASSWORD).toBe("child-only-pw");
      expect(process.env.PGPASSWORD).toBe(before);
      expect(JSON.stringify(process.env)).not.toContain("child-only-pw");
    }
  });

  it("keeps an inherited PGPASSWORD when the URL has no password and rejects non-URL strings without echoing them", () => {
    expect(buildPgDumpInvocation("postgres://u@h/db", 5, { PGPASSWORD: "inherited" }).env.PGPASSWORD).toBe("inherited");
    expect(() => buildPgDumpInvocation("host=h password=topsecret dbname=d", 5)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining("topsecret") }),
    );
  });

  it("redacts the password from captured pg_dump stderr in the non-preserving path", async () => {
    const dir = await fixture();
    mocks.spawn.mockImplementation(() => child({ exitCode: 1, stderr: "failed for synthetic-secret here" }));
    const error = await runPgDumpBackup({ connectionString, backupFile: join(dir, "x.sql.gz"), connectTimeout: 5 }).catch((v: unknown) => v);
    expect(String(error)).toContain("failed for *** here");
    expect(String(error)).not.toContain("synthetic-secret");
  });

  it("gives an actionable error when pg_dump is missing", async () => {
    const dir = await fixture();
    mocks.spawn.mockImplementation(() => child({ spawnError: Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" }) }));
    const error = await runDatabaseBackup(options(dir)).catch((v: unknown) => v);
    expect(error).toMatchObject({ phase: "dump", code: "dump_failed" });
    expect(String(error)).toMatch(/PAPERCLIP_PG_DUMP_PATH/);
    expect(String(error)).not.toContain("synthetic-secret");
  });

  it("refuses an existing final name before spawning and preserves its bytes", async () => {
    const dir = await fixture();
    const target = join(dir, "existing.sql.gz");
    await writeFile(target, "existing fixture");
    await expect(runPreservedPgDumpBackup({ connectionString, backupDir: dir, backupFile: target, connectTimeout: 5 }))
      .rejects.toMatchObject({ phase: "reserve", code: "output_exists" });
    expect(await readFile(target, "utf8")).toBe("existing fixture");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("refuses a same-second repeated backup without altering the first or history", async () => {
    const dir = await fixture();
    const first = await runDatabaseBackup(options(dir));
    const before = await readFile(first.backupFile);
    await expect(runDatabaseBackup(options(dir))).rejects.toMatchObject({ code: "output_exists" });
    expect(await readFile(first.backupFile)).toEqual(before);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses a final-name race atomically and retains complete staging output", async () => {
    const dir = await fixture();
    mocks.link.mockImplementation(async (partial: string, final: string) => {
      await writeFile(final, "racing fixture", { flag: "wx" });
      await fs.link(partial, final);
    });
    await expect(runDatabaseBackup(options(dir))).rejects.toMatchObject({ phase: "publish", code: "publish_failed" });
    const names = await readdir(dir);
    const final = names.find((name) => name.endsWith(".sql.gz"))!;
    const partial = names.find((name) => name.includes(".partial-"))!;
    expect(await readFile(join(dir, final), "utf8")).toBe("racing fixture");
    expect(gunzipSync(await readFile(join(dir, partial))).toString()).toBe(sql);
  });

  it.each(["EXDEV", "ENOTSUP", "EACCES"])("retains staging and fails closed on publish %s", async (code) => {
    const dir = await fixture();
    mocks.link.mockRejectedValue(Object.assign(new Error("synthetic publish error"), { code }));
    const error = await runDatabaseBackup(options(dir)).catch((value: unknown) => value);
    expect(error).toMatchObject({ phase: "publish", code: "publish_failed" });
    expect(String(error)).toMatch(/hard-link/);
    expect((error as PreservedBackupError).retainedArtifact).toContain(".partial-");
    expect(resolve((error as PreservedBackupError).retainedArtifact!)).toBe((error as PreservedBackupError).retainedArtifact);
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(".partial-");
    expect(names[0]?.endsWith(".sql.gz")).toBe(false);

    expect(gunzipSync(await readFile(join(dir, names[0]!))).toString()).toBe(sql);
    expect(inspectDatabaseBackupHealth({ enabled: true, backupDir: dir, maxAgeHours: 24 }))
      .toMatchObject({ status: "warning", latestBackup: null });
  });

  it.each(["nonzero", "spawn", "stream"])("retains failed %s output without health-visible success or fallback", async (kind) => {
    const dir = await fixture();
    const secretError = new Error(`synthetic stderr ${connectionString}`);
    mocks.spawn.mockImplementation(() => child({
      exitCode: kind === "nonzero" ? 1 : 0,
      spawnError: kind === "spawn" ? secretError : undefined,
      streamError: kind === "stream" ? secretError : undefined,
      stderr: secretError.message,
    }));
    const error = await runDatabaseBackup(options(dir)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PreservedBackupError);
    expect(error).toMatchObject({ phase: "dump", code: "dump_failed" });
    expect(String(error)).not.toContain(connectionString);
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
    expect(error).not.toHaveProperty("cause");
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]?.endsWith(".sql.gz")).toBe(false);
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(inspectDatabaseBackupHealth({ enabled: true, backupDir: dir, maxAgeHours: 24 }))
      .toMatchObject({ status: "warning", latestBackup: null });
  });

  it("sanitizes reservation failure without spawning or overwriting a colliding partial", async () => {
    const dir = await fixture();
    mocks.open.mockImplementation(async (partial: string) => {
      await writeFile(partial, "colliding fixture", { flag: "wx" });
      return fs.open(partial, "wx", 0o600);
    });
    await expect(runDatabaseBackup(options(dir))).rejects.toMatchObject({ phase: "reserve", code: "output_create_failed" });
    const names = await readdir(dir);
    expect(await readFile(join(dir, names[0]!), "utf8")).toBe("colliding fixture");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["constructor", "sync", "stat", "close"])("closes and retains the file on %s failure without publishing", async (stage) => {
    const dir = await fixture();
    let opened!: Awaited<ReturnType<typeof fs.open>>;
    mocks.open.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      opened = file;
      const error = new Error(`synthetic failure ${connectionString}`);
      if (stage === "constructor") vi.spyOn(file, "createWriteStream").mockImplementation(() => { throw error; });
      if (stage === "sync") vi.spyOn(file, "sync").mockRejectedValue(error);
      if (stage === "stat") vi.spyOn(file, "stat").mockRejectedValue(error);
      if (stage === "close") {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementation(async () => { await close(); throw error; });
      }
      return file;
    });
    const error = await runDatabaseBackup(options(dir)).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PreservedBackupError);
    expect(String(error)).not.toContain(connectionString);
    expect(opened.fd).toBe(-1);
    expect(mocks.link).not.toHaveBeenCalled();
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]?.endsWith(".sql.gz")).toBe(false);
  });

  it.each([
    { backupEngine: "auto" }, { backupEngine: "javascript" },
    { excludeTables: ["users"] }, { nullifyColumns: { users: ["email"] } },
    { filenamePrefix: "../escape" }, { filenamePrefix: "fixture\n" },
  ] satisfies Partial<RunDatabaseBackupOptions>[])("rejects unsupported policy options before creating files: %j", async (override) => {
    const dir = await fixture();
    await expect(runDatabaseBackup({ ...options(dir), ...override })).rejects.toThrow("Preserve-all requires");
    expect(await readdir(dir)).toEqual([]);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });
});

describe("legacy caller regression", () => {
  it("preserves buffered SQL line boundaries", async () => {
    const dir = await fixture();
    const path = join(dir, "buffered.sql");
    const writer = createBufferedTextFileWriter(path, 16);
    const lines = ["-- header", "BEGIN;", "", "INSERT INTO sample VALUES (42);", "-- footer"];
    for (const line of lines) writer.emit(line);
    await writer.close();
    expect(await readFile(path, "utf8")).toBe(lines.join("\n"));
  });

  it("leaves the legacy auto caller's retention and response contract unchanged", async () => {
    const dir = await fixture();
    const old = join(dir, "fixture-20000101-000000.sql.gz");
    await writeFile(old, "new synthetic historical fixture");
    await fs.utimes(old, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
    const database = Object.assign(vi.fn().mockResolvedValue([]), { end: vi.fn().mockResolvedValue(undefined) });
    mocks.postgres.mockReturnValue(database);
    const result = await runDatabaseBackup({ ...options(dir), preserveAll: false, backupEngine: "auto" });
    expect(result).toMatchObject({ prunedCount: 1 });
    expect(result).not.toHaveProperty("preservationPolicy");
    expect(result).not.toHaveProperty("retainedPartialFile");
    expect(gunzipSync(await readFile(result.backupFile)).toString()).toBe(sql);
    expect(await readdir(dir)).toEqual([basename(result.backupFile)]);
    expect(database.end).toHaveBeenCalledTimes(1);
  });
});
