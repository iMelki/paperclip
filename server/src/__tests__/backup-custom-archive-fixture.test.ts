import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ensurePostgresDatabase } from "@paperclipai/db";
import { BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS, createRunner,
  startBoardImportFixtureDatabase } from "./helpers/board-import-fixture-db.js";

// INACTIVE, UNRUN proposal. Chief's existing C62 Job owns every native descendant.
// Synthetic transport only: NOT Factory backup/roles/ACLs/cluster-loss DR/migration qualification.
// No stock backup/prune/reset/drop/file cleanup. All native logs, partials and databases retained.
// PG18 custom stdout/list/transactional restore contracts:
// https://www.postgresql.org/docs/18/app-pgdump.html
// https://www.postgresql.org/docs/18/app-pgrestore.html
const CLIENT_ROOT = "C:/Users/Milky/AppData/Local/PaperclipFactory/assistants-factory-win/runtime/"
  + "pg18-client-acquire-20260924/extracted/pgsql/bin";
const CLIENT_REQUEST = "C:/Users/Milky/Documents/Codex/2026-10-01/executive-ceo/outputs/"
  + "parallel-company-canvas-20261007-2012/paperclip/github-asimtop-connection-20261012/"
  + "PG18-RETAINED-CLIENT-VERSION-REQUEST-20261015.private.json";
const REQUEST_SHA256 = "6673e047311e9c644487f7885949323605d8c978dbf5d3918b1c21958229f6a4";
const TOOL_PINS = [
  { name: "pg_dump", sha256: "ae5c804c05b32760bf9066b1df88838b7a29fa1387690b0054011cf53c19b6e7" },
  { name: "pg_restore", sha256: "2b549ba70eff93bf976a1d774fe4837c10dbf63db39ccd6d452f59cf03ace2af" },
] as const;
type Fixture = Awaited<ReturnType<typeof startBoardImportFixtureDatabase>>;
type Database = ReturnType<typeof createDb>;
let fixture: Fixture | undefined;
let run: ReturnType<typeof createRunner>;
let source: Database;
const clients: Database[] = [];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const executable = (name: string) => path.join(CLIENT_ROOT, `${name}.exe`);

function verifyPhysicalFile(file: string, expectedSha256: string) {
  if (path.resolve(file).toLowerCase() !== fs.realpathSync.native(file).toLowerCase()
    || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
    throw new Error("Backup fixture input must be a fixed physical regular file");
  }
  expect(sha256(fs.readFileSync(file)), file).toBe(expectedSha256);
}
function verifyExistingClientPins() {
  verifyPhysicalFile(CLIENT_REQUEST, REQUEST_SHA256);
  for (const pin of TOOL_PINS) verifyPhysicalFile(executable(pin.name), pin.sha256);
  const request = JSON.parse(fs.readFileSync(CLIENT_REQUEST, "utf8")) as {
    dllPins: Array<{ path: string; sha256: string }> };
  if (!Array.isArray(request.dllPins) || request.dllPins.length === 0) throw new Error("Missing retained DLL pins");
  expect(fs.readdirSync(CLIENT_ROOT).filter(name => /\.dll$/i.test(name)).sort()).toEqual(
    request.dllPins.map(pin => path.basename(pin.path)).sort());
  for (const pin of request.dllPins) {
    if (path.dirname(path.resolve(pin.path)).toLowerCase() !== path.resolve(CLIENT_ROOT).toLowerCase()) {
      throw new Error("Retained DLL pin escaped fixed client directory");
    }
    verifyPhysicalFile(pin.path, pin.sha256);
  }
}
function ownedFixture() {
  if (!fixture || !Number.isInteger(fixture.port)
    || [5113, 5114, 5432, 54329].includes(fixture.port)) throw new Error("Isolated native fixture required");
  return fixture;
}
async function newDatabase(name: string) {
  if (!/^backup_fixture_[a-z_]+$/.test(name)) throw new Error("Only named synthetic backup databases permitted");
  const { port } = ownedFixture();
  const admin = `postgres://paperclip_fixture:@127.0.0.1:${port}/postgres`;
  if (await ensurePostgresDatabase(admin, name) !== "created") {
    throw new Error("Restore target already exists; refusing reuse or reset");
  }
  const db = createDb(`postgres://paperclip_fixture:@127.0.0.1:${port}/${name}`, {
    maxConnections: 1, connectTimeoutSeconds: 5, idleTimeoutSeconds: 5,
  });
  clients.push(db);
  await db.$client.unsafe("SET statement_timeout = '5000'");
  const objects = await db.$client.unsafe("SELECT count(*)::int AS n FROM pg_class c "
    + "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
    + "AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','S','v','m')");
  expect(objects[0]?.n).toBe(0);
  return db;
}
async function snapshot(db: Database) {
  return {
    parents: Array.from(await db.$client.unsafe("SELECT id::text,name FROM fixture_parent ORDER BY id")),
    children: Array.from(await db.$client.unsafe("SELECT id,parent_id::text,score FROM fixture_child ORDER BY id")),
    journal: Array.from(await db.$client.unsafe("SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations")),
    constraints: Array.from(await db.$client.unsafe("SELECT conname,contype,convalidated FROM pg_constraint "
      + "WHERE conrelid IN ('fixture_parent'::regclass,'fixture_child'::regclass) ORDER BY conname")),
    index: Array.from(await db.$client.unsafe("SELECT indexname,indexdef FROM pg_indexes "
      + "WHERE tablename='fixture_child' ORDER BY indexname")),
    sequence: Array.from(await db.$client.unsafe("SELECT last_value::text,is_called FROM fixture_parent_id_seq")),
  };
}
function connectArgs(name: string) {
  const current = ownedFixture();
  const url = new URL(`postgresql://paperclip_fixture:@127.0.0.1:${current.port}/${name}`);
  // Prevent libpq's default password-file discovery; this new empty file contains no credential.
  url.searchParams.set("passfile", path.join(current.artifactDir, "synthetic-empty.pgpass"));
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("sslmode", "disable");
  url.searchParams.set("gssencmode", "disable");
  return ["--no-password", `--dbname=${url.toString()}`];
}

describe("retained native PG18 custom archive synthetic transport", () => {
  beforeAll(async () => {
    verifyExistingClientPins();
    if (process.env.PAPERCLIP_BOARD_FIXTURE_PG_VERSION !== "18.1") throw new Error("Exact PG18.1 fixture required");
    fixture = await startBoardImportFixtureDatabase();
    fs.writeFileSync(path.join(fixture.artifactDir, "synthetic-empty.pgpass"), "", { flag: "wx" });
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) {
      if (/^(?:systemroot|windir|temp|tmp|pathext)$/i.test(key)) childEnv[key] = process.env[key];
    }
    const systemRoot = childEnv.SystemRoot ?? childEnv.SYSTEMROOT ?? childEnv.systemroot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Explicit OS system root required");
    childEnv.PATH = [CLIENT_ROOT, path.join(systemRoot, "System32")].join(path.delimiter);
    run = createRunner(path.dirname(fixture.artifactDir), fixture.artifactDir, fixture.dataDir, childEnv);
    for (const pin of TOOL_PINS) {
      const version = await run(`${pin.name}-backup-version`, executable(pin.name), ["--version"], 5000);
      expect(version.trim()).toMatch(new RegExp(`^${pin.name} \\(PostgreSQL\\) 18\\.6(?:\\s|$)`));
    }
    source = await newDatabase("backup_fixture_source");
    await source.$client.unsafe(`
      CREATE TABLE fixture_parent (id bigserial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE fixture_child (id serial PRIMARY KEY, parent_id bigint NOT NULL,
        score int NOT NULL CONSTRAINT fixture_score_nonnegative CHECK (score >= 0),
        CONSTRAINT fixture_parent_fk FOREIGN KEY (parent_id) REFERENCES fixture_parent(id));
      CREATE INDEX fixture_child_score_idx ON fixture_child(score);
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id int PRIMARY KEY, hash text NOT NULL, created_at bigint);
      INSERT INTO fixture_parent(name) VALUES ('MemSys — δοκιμή 🧠'),('עברית — synthetic');
      INSERT INTO fixture_child(parent_id,score) VALUES (1,7),(2,11);
      INSERT INTO drizzle.__drizzle_migrations VALUES (1,'synthetic-transport-only',123456789);
    `);
  }, BOARD_IMPORT_FIXTURE_SETUP_TIMEOUT_MS + 20_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const closed = await Promise.allSettled(clients.map(db => db.$client.end({ timeout: 5 })));
    for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
    try { await fixture?.cleanup(); } catch (error) { failures.push(error); }
    try { verifyExistingClientPins(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Backup fixture cleanup/pins unverified; all evidence retained");
  }, 30_000);

  it("retains a CREATE_NEW archive, rejects truncated input and restores twice into distinct empty targets", async () => {
    const { artifactDir } = ownedFixture();
    const expected = await snapshot(source);
    await expect(newDatabase("backup_fixture_source")).rejects.toThrow("already exists; refusing reuse");
    // No --file: binary stdout is captured byte-for-byte into a CREATE_NEW wx+ file by existing runner.
    await run("backup-custom", executable("pg_dump"), ["--format=custom", ...connectArgs("backup_fixture_source")], 15_000);
    const archive = path.join(artifactDir, "backup-custom.stdout.log");
    const bytes = fs.readFileSync(archive), archiveHash = sha256(bytes);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("PGDMP");
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    await expect(run("backup-custom", executable("pg_dump"), ["--version"], 5000)).rejects.toMatchObject({ code: "EEXIST" });
    expect(sha256(fs.readFileSync(archive))).toBe(archiveHash);
    const toc = await run("backup-toc", executable("pg_restore"), ["--list", "--no-password", archive], 5000);
    for (const name of ["fixture_parent", "fixture_child", "fixture_parent_id_seq", "__drizzle_migrations"]) {
      expect(toc).toContain(name);
    }
    const truncated = path.join(artifactDir, "backup-truncated.custom");
    fs.writeFileSync(truncated, bytes.subarray(0, 4), { flag: "wx" });
    await run("backup-truncated-list", executable("pg_restore"), ["--list", truncated], 5000, [1]);
    const failedReceipt = JSON.parse(fs.readFileSync(path.join(artifactDir, "backup-truncated-list.receipt.json"), "utf8"));
    expect(failedReceipt).toMatchObject({ code: 1, timedOut: false, rootExited: true, closeObserved: true,
      streamsComplete: true, captureMatched: true, error: null });
    const errorText = fs.readFileSync(path.join(artifactDir, "backup-truncated-list.stderr.log"), "utf8");
    expect(errorText).toMatch(/(?:input file is too short|could not read from input file|end of file)/i);
    expect(fs.readFileSync(truncated).equals(bytes.subarray(0, 4))).toBe(true);
    for (const [index, name] of ["backup_fixture_restore_a", "backup_fixture_restore_b"].entries()) {
      const restored = await newDatabase(name);
      await run(`backup-restore-${index}`, executable("pg_restore"), ["--exit-on-error", "--single-transaction",
        "--no-owner", "--no-acl", ...connectArgs(name), archive], 15_000);
      expect(await snapshot(restored)).toEqual(expected);
      await expect(restored.$client.unsafe("INSERT INTO fixture_child(parent_id,score) VALUES (999,1)"))
        .rejects.toMatchObject({ code: "23503" });
      await expect(restored.$client.unsafe("INSERT INTO fixture_child(parent_id,score) VALUES (1,-1)"))
        .rejects.toMatchObject({ code: "23514" });
      const next = await restored.$client.unsafe("INSERT INTO fixture_parent(name) VALUES ('restored-only') RETURNING id::text");
      expect(next[0]?.id).toBe("3");
    }
    expect(await snapshot(source)).toEqual(expected);
    expect(sha256(fs.readFileSync(archive))).toBe(archiveHash);
    fs.writeFileSync(path.join(artifactDir, "backup-synthetic-outcome.json"), JSON.stringify({
      at: new Date().toISOString(), archive, archiveHash, archiveBytes: bytes.length,
      validRestores: 2, distinctNewTargets: 2, truncatedListRejectedWithCode: 1,
      sourceUnchanged: true, mode: "synthetic-normalized-ownership-transport-only",
      excludes: ["Factory data backup", "global roles/ACLs", "corrupt table COPY", "host migration qualification"],
    }, null, 2), { flag: "wx" });
  }, 75_000);
});
