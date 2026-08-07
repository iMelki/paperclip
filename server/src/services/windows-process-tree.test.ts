import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { isPidAlive, terminateLocalService } from "./local-service-supervisor.js";
import {
  captureWindowsProcessTreeReceipt,
  observeWindowsProcessTreeReceipt,
  selectTrackedWindowsProcessTree,
  type WindowsProcessIdentity,
} from "./windows-process-tree.js";

const windowsOnly = process.platform === "win32" ? it : it.skip;

function identity(
  pid: number,
  parentPid: number,
  createdAt: string,
): WindowsProcessIdentity {
  return { pid, parentPid, createdAt };
}

async function readChildPid(child: ChildProcess) {
  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for child PID")),
      5_000,
    );
    child.stdout?.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(Number.parseInt(String(chunk).trim(), 10));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function spawnWrapperWithChild(marker: string) {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const marker = process.argv[1];",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 8000)', marker], { stdio: 'ignore', windowsHide: true });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  return spawn(process.execPath, ["-e", script, marker], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

function spawnGrandchildEscapeWrapper(marker: string) {
  const grandchildScript = "setTimeout(() => process.exit(0), 8000);";
  const intermediateScript = [
    "const { spawn } = require('node:child_process');",
    "const marker = process.argv[1];",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, marker], { detached: true, stdio: 'ignore', windowsHide: true });`,
    "console.log(grandchild.pid);",
    "grandchild.unref();",
  ].join(" ");
  const wrapperScript = [
    "const { spawn } = require('node:child_process');",
    "const marker = process.argv[1];",
    "process.stdin.once('data', () => {",
    `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(intermediateScript)}, marker], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });`,
    "  child.stdout.once('data', (chunk) => console.log(`${child.pid},${String(chunk).trim()}`));",
    "  child.once('exit', () => process.exit(0));",
    "});",
    "process.stdin.resume();",
  ].join(" ");
  return spawn(process.execPath, ["-e", wrapperScript, marker], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

async function readEscapePids(wrapper: ChildProcess) {
  return await new Promise<{ childPid: number; grandchildPid: number }>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for escape process PIDs")),
      5_000,
    );
    wrapper.stdout?.once("data", (chunk) => {
      clearTimeout(timeout);
      const [childPid, grandchildPid] = String(chunk)
        .trim()
        .split(",")
        .map((value) => Number.parseInt(value, 10));
      resolve({ childPid, grandchildPid });
    });
    wrapper.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("Windows process-tree stop receipts", () => {
  it("retains an exact captured descendant after its parent exits or it is reparented", () => {
    const root = identity(100, 1, "2026-08-03T12:00:00.000Z");
    const child = identity(101, 100, "2026-08-03T12:00:01.000Z");
    const snapshot = [
      { ...child, parentPid: 1 },
      identity(200, 1, "2026-08-03T12:00:02.000Z"),
    ];

    expect(selectTrackedWindowsProcessTree({
      snapshot,
      captured: [root, child],
    })).toEqual([{ ...child, parentPid: 1 }]);
  });

  it("detects a child that raced the first snapshot after its captured parent exits", () => {
    const root = identity(100, 1, "2026-08-03T12:00:00.000Z");
    const racedChild = identity(101, 100, "2026-08-03T12:00:01.000Z");

    expect(selectTrackedWindowsProcessTree({
      snapshot: [racedChild],
      captured: [root],
    })).toEqual([racedChild]);
  });

  windowsOnly(
    "signals only the exact root handle and keeps release blocked without a Job receipt",
    async () => {
      const wrapper = spawnWrapperWithChild(`paperclip-stop-proof-${randomUUID()}`);
      const childPid = await readChildPid(wrapper);
      expect(wrapper.pid).toBeTypeOf("number");
      try {
        await expect.poll(() => isPidAlive(childPid), { timeout: 5_000 }).toBe(true);
        const result = await terminateLocalService(
          { pid: wrapper.pid!, processGroupId: wrapper.pid! },
          { trustedPid: true, childProcess: wrapper, forceAfterMs: 2_000 },
        );

        expect(result).toMatchObject({
          attempted: true,
          confirmedStopped: false,
          outcome: "still_running",
          error: "windows_process_tree_absence_unproven_without_job_object",
          processTreeReceipt: {
            authority: "snapshot_advisory",
            authoritative: false,
          },
        });
        expect(result.processTreeReceipt?.captured.map(({ pid }) => pid)).toEqual(
          expect.arrayContaining([wrapper.pid!, childPid]),
        );
        expect(isPidAlive(wrapper.pid!)).toBe(false);
      } finally {
        if (wrapper.exitCode === null) wrapper.kill("SIGKILL");
        await expect.poll(() => isPidAlive(childPid), { timeout: 10_000 }).toBe(false);
      }
    },
    20_000,
  );

  windowsOnly(
    "sends no signal when the live-handle identity changes after the final observation",
    async () => {
      const root = spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000);",
      ], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(root.pid).toBeTypeOf("number");
      const signal = vi.fn(() => true);
      const fakeHandle = {
        pid: root.pid,
        exitCode: null,
        signalCode: null,
        kill: signal,
      } as unknown as ChildProcess;

      try {
        await expect.poll(() => isPidAlive(root.pid!), { timeout: 5_000 }).toBe(true);
        const result = await terminateLocalService(
          { pid: root.pid!, processGroupId: root.pid! },
          {
            trustedPid: true,
            childProcess: fakeHandle,
            forceAfterMs: 100,
            testOnlyBeforeWindowsRootSignal: () => {
              Object.defineProperty(fakeHandle, "pid", {
                configurable: true,
                value: root.pid! + 1,
              });
            },
          },
        );

        expect(result).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          outcome: "untrusted_identity",
          error: "windows_child_process_handle_no_longer_live",
        });
        expect(signal).not.toHaveBeenCalled();
        expect(isPidAlive(root.pid!)).toBe(true);
      } finally {
        if (root.exitCode === null) root.kill("SIGKILL");
      }
    },
    15_000,
  );

  windowsOnly(
    "does not promote empty snapshots when an unobserved intermediate leaves a surviving grandchild",
    async () => {
      const wrapper = spawnGrandchildEscapeWrapper(`paperclip-stop-survivor-${randomUUID()}`);
      expect(wrapper.pid).toBeTypeOf("number");
      let receipt = await captureWindowsProcessTreeReceipt({
        rootPid: wrapper.pid!,
        timeoutMs: 5_000,
      });
      expect(receipt).not.toBeNull();
      expect(receipt).toMatchObject({
        authority: "snapshot_advisory",
        authoritative: false,
        root: { pid: wrapper.pid! },
      });

      const escapedPidsPromise = readEscapePids(wrapper);
      wrapper.stdin?.end("go\n");
      const { childPid, grandchildPid } = await escapedPidsPromise;

      try {
        await expect.poll(() => isPidAlive(wrapper.pid!), { timeout: 5_000 }).toBe(false);
        await expect.poll(() => isPidAlive(childPid), { timeout: 5_000 }).toBe(false);
        await expect.poll(() => isPidAlive(grandchildPid), { timeout: 5_000 }).toBe(true);

        receipt = await observeWindowsProcessTreeReceipt({
          receipt: receipt!,
          timeoutMs: 5_000,
        });
        receipt = await observeWindowsProcessTreeReceipt({
          receipt,
          timeoutMs: 5_000,
        });
        expect(receipt).toMatchObject({
          authority: "snapshot_advisory",
          authoritative: false,
          consecutiveAbsentSnapshots: 2,
          remaining: [],
        });
        expect(isPidAlive(grandchildPid)).toBe(true);
      } finally {
        if (wrapper.exitCode === null) wrapper.kill("SIGKILL");
        await expect.poll(() => isPidAlive(grandchildPid), { timeout: 10_000 }).toBe(false);
        await delay(50);
      }
    },
    20_000,
  );
});
