import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPostgresDataDirectory } from "./client.js";
import { resolveEmbeddedPostgresLock } from "./embedded-postgres-lock.js";
import {
  __startEmbeddedPostgresWithRetryForTests,
  __stopEmbeddedPostgresBoundedForTests,
} from "./test-embedded-postgres.js";

const SYNTHETIC_STALE_PID = 2_147_483_647;

async function waitForPostmasterPid(pidFile: string, stalePid: number, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").split(/\r?\n/, 1)[0], 10);
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== stalePid) return pid;
    } catch {
      // PostgreSQL can briefly remove or replace postmaster.pid during startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function waitForDataDirectory(url: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dataDir = await getPostgresDataDirectory(url);
    if (dataDir !== null) return dataDir;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

describe("embedded PostgreSQL native stale-lock recovery", () => {
  it("lets PostgreSQL revalidate and replace a synthetic stale PID file", async () => {
    const cluster = await __startEmbeddedPostgresWithRetryForTests("paperclip-native-stale-lock-");
    const pidFile = path.join(cluster.dataDir, "postmaster.pid");

    try {
      const originalLock = readFileSync(pidFile, "utf8");
      await cluster.instance.stop();
      await expect(resolveEmbeddedPostgresLock(pidFile, cluster.dataDir))
        .resolves.toEqual({ state: "missing" });
      await expect(getPostgresDataDirectory(
        `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/postgres`,
      )).resolves.toBeNull();

      const staleLines = originalLock.split(/\r?\n/);
      staleLines[0] = String(SYNTHETIC_STALE_PID);
      writeFileSync(pidFile, staleLines.join("\n"), { encoding: "utf8", flag: "wx" });

      await expect(resolveEmbeddedPostgresLock(pidFile, cluster.dataDir))
        .resolves.toEqual({ state: "stale", pid: SYNTHETIC_STALE_PID, port: cluster.port });

      await cluster.instance.start();
      const postmasterPid = await waitForPostmasterPid(pidFile, SYNTHETIC_STALE_PID, 15_000);
      expect(postmasterPid).not.toBeNull();

      const activeDataDir = await waitForDataDirectory(
        `postgres://paperclip:paperclip@127.0.0.1:${cluster.port}/postgres`,
        15_000,
      );
      expect(activeDataDir).not.toBeNull();
      const normalizeDataDir = (value: string) => {
        const resolved = path.resolve(value);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      expect(normalizeDataDir(activeDataDir!)).toBe(normalizeDataDir(cluster.dataDir));
    } finally {
      // `pg_ctl start -w` may return while the stale pidfile is still visible.
      // Give PostgreSQL's native startup time to publish its real PID before
      // asking pg_ctl to stop the test cluster, which reads that file.
      const postmasterPid = await waitForPostmasterPid(pidFile, SYNTHETIC_STALE_PID, 15_000);
      if (postmasterPid === null) {
        console.error(`Preserving synthetic PostgreSQL fixture because its stale PID file was not replaced: ${cluster.dataDir}`);
      } else {
        const stopped = await __stopEmbeddedPostgresBoundedForTests(
          cluster.instance,
          cluster.dataDir,
          () => rmSync(cluster.dataDir, { recursive: true, force: true }),
          { stopTimeoutMs: 30_000 },
        );
        expect(stopped).toBe(true);
      }
    }
  }, 120_000);
});
