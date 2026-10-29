import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  matchesLinuxProcessStartIdentity,
  parseLinuxProcStatBootTimeSec,
  parseLinuxProcStatStartTicks,
  terminateLocalService,
} from "../services/local-service-supervisor.js";

const BTIME = 1_700_000_000;
const HZ = 100;

function statLine(comm: string, startTicks: number) {
  // Fields 3..21 are filler; field 22 is starttime.
  const filler = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1))];
  return `4242 (${comm}) ${filler.join(" ")} ${startTicks} 999 888\n`;
}

function fakeDeps(files: Record<string, string | Error>) {
  return {
    platform: "linux" as const,
    clockTicksPerSecond: async () => HZ,
    readFile: async (p: string) => {
      const value = files[p];
      if (value === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("Linux process start-time identity", () => {
  it("parses field 22 after the last ')' even when comm has spaces and parens", () => {
    expect(parseLinuxProcStatStartTicks(statLine("we ird) (name", 12345))).toBe(12345);
    expect(parseLinuxProcStatStartTicks("garbage")).toBeNull();
    expect(parseLinuxProcStatStartTicks("1 (x) S 1 2")).toBeNull();
    expect(parseLinuxProcStatBootTimeSec(`cpu 1 2\nbtime ${BTIME}\n`)).toBe(BTIME);
    expect(parseLinuxProcStatBootTimeSec("cpu 1 2\n")).toBeNull();
  });

  it("trusts a pid whose start time matches the recorded start", async () => {
    const startTicks = 5_000; // 50 s after boot
    const expected = new Date(BTIME * 1000 + 50_000 + 4);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({
      "/proc/4242/stat": statLine("node", startTicks),
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(true);
  });

  it("refuses a reused pid whose start time differs from the recorded start", async () => {
    const expected = new Date(BTIME * 1000 + 50_000);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({
      "/proc/4242/stat": statLine("node", 5_000 + 600), // started 6 s later
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(false);
  });

  it("refuses when /proc is unreadable, missing, malformed, or the pid is gone", async () => {
    const expected = new Date(BTIME * 1000 + 50_000);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({
      "/proc/4242/stat": new Error("EACCES"),
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({}))).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, fakeDeps({
      "/proc/4242/stat": "4242 (node S",
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, {
      ...fakeDeps({ "/proc/4242/stat": statLine("node", 5_000), "/proc/stat": `btime ${BTIME}\n` }),
      clockTicksPerSecond: async () => null,
    })).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, "not a date", fakeDeps({
      "/proc/4242/stat": statLine("node", 5_000),
      "/proc/stat": `btime ${BTIME}\n`,
    }))).resolves.toBe(false);
    await expect(matchesLinuxProcessStartIdentity(4242, expected, {
      ...fakeDeps({ "/proc/4242/stat": statLine("node", 5_000), "/proc/stat": `btime ${BTIME}\n` }),
      platform: "darwin",
    })).resolves.toBe(false);
  });

  it.runIf(process.platform === "linux")("terminates a live child only when its real start time matches", async () => {
    const startedAt = new Date();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refused = await terminateLocalService(
        { pid: child.pid!, processGroupId: null },
        { expectedStartedAt: new Date(startedAt.getTime() - 60_000), forceAfterMs: 500 },
      );
      expect(refused.outcome).toBe("untrusted_identity");
      const result = await terminateLocalService(
        { pid: child.pid!, processGroupId: null },
        { expectedStartedAt: startedAt, forceAfterMs: 500 },
      );
      expect(result.confirmedStopped).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
