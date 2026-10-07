import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { prepareEmbeddedPostgresNativeRuntime } from "@paperclipai/db";
import { expect, it } from "vitest";
import { readRunningEmbeddedPostgres } from "../embedded-postgres-reuse.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if ([5113, 54329].includes(address.port)) return unusedPort();
  return address.port;
}

it("rejects an actual node PID on a closed port, then starts and reuses actual PostgreSQL", async () => {
  await prepareEmbeddedPostgresNativeRuntime();
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "embedded-pg-native-identity-")));
  const port = await unusedPort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  const pidFile = join(dataDir, "postmaster.pid");
  const stale = `${process.pid}\n${dataDir}\n${Math.floor(Date.now() / 1000)}\n${port}\n\nlocalhost\n\nready\n`;
  writeFileSync(pidFile, stale);
  expect(process.kill(process.pid, 0)).toBe(true);
  expect(await readRunningEmbeddedPostgres(dataDir, port)).toBeNull();
  expect(readFileSync(pidFile, "utf8")).toBe(stale);

  // This is the existing server start path: it removes the stale lock before
  // start(). The dependency itself does not clean up a recycled-PID lock.
  rmSync(pidFile, { force: true });
  try {
    await pg.start();
    const postgresPid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    expect(postgresPid).not.toBe(process.pid);
    expect(await readRunningEmbeddedPostgres(dataDir, port)).toEqual({ pid: postgresPid, port });
    // A prior startup may have selected another port; the PID file owns it.
    expect(await readRunningEmbeddedPostgres(dataDir, 54329)).toEqual({ pid: postgresPid, port });
    expect(process.kill(process.pid, 0)).toBe(true);
  } finally {
    await pg.stop();
  }
  // The stopped server has no reusable identity. Retain all test data for audit.
  expect(await readRunningEmbeddedPostgres(dataDir, port)).toBeNull();
}, 60_000);
