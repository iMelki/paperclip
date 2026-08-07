import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWindowsTestProcessIdentity,
  parseWindowsTestProcessSnapshot,
  reapWindowsTestProcessTree,
  selectOwnedWindowsTestProcessTree,
  type WindowsTestProcessIdentity,
} from "./test-windows-process-tree.js";

const windowsOnly = process.platform === "win32" ? it : it.skip;

function identity(
  pid: number,
  parentPid: number,
  createdAt: string,
  commandLine: string | null,
): WindowsTestProcessIdentity {
  return { pid, parentPid, createdAt, commandLine };
}

async function waitForFixtureExit(exitPromise: Promise<void>, timeoutMs = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the Windows process-tree fixture to exit.")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Windows test process tree selection", () => {
  it("captures a marked root and its full valid descendant tree", () => {
    const marker = path.join(os.tmpdir(), "paperclip-owned-12345678");
    const snapshot = [
      identity(100, 1, "2026-07-29T18:00:00.000Z", `node runner.js ${marker}`),
      identity(101, 100, "2026-07-29T18:00:01.000Z", "postgres: io worker"),
      identity(102, 101, "2026-07-29T18:00:02.000Z", "node helper.js"),
      identity(200, 1, "2026-07-29T18:00:00.000Z", "node unrelated.js"),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: 100,
        ownerMarkers: [marker],
      }).map((item) => item.pid),
    ).toEqual([100, 101, 102]);
  });

  it("keeps an exact previously captured child after it is reparented", () => {
    const marker = path.join(os.tmpdir(), "paperclip-owned-12345678");
    const captured = identity(
      101,
      100,
      "2026-07-29T18:00:01.000Z",
      "postgres: io worker",
    );
    const snapshot = [
      { ...captured, parentPid: 1 },
      identity(200, 1, "2026-07-29T18:00:00.000Z", "node unrelated.js"),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: 100,
        ownerMarkers: [marker],
        previouslyOwned: [captured],
      }).map((item) => item.pid),
    ).toEqual([101]);
  });

  it("does not adopt a reused PID or an unmarked root", () => {
    const marker = path.join(os.tmpdir(), "paperclip-owned-12345678");
    const previous = identity(
      101,
      100,
      "2026-07-29T18:00:01.000Z",
      "postgres: io worker",
    );
    const snapshot = [
      identity(100, 1, "2026-07-29T18:00:00.000Z", "node unrelated.js"),
      identity(101, 1, "2026-07-29T19:00:00.000Z", "node reused-pid.js"),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: 100,
        ownerMarkers: [marker],
        previouslyOwned: [previous],
      }),
    ).toEqual([]);
  });

  it("uses an exact captured root identity without trusting a bare PID", () => {
    const capturedRoot = identity(
      100,
      1,
      "2026-07-29T18:00:00.000Z",
      "node service.js",
    );
    const snapshot = [
      capturedRoot,
      identity(101, 100, "2026-07-29T18:00:01.000Z", "node child.js"),
      identity(200, 1, "2026-07-29T18:00:00.000Z", "node service.js"),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: capturedRoot.pid,
        ownerMarkers: [],
        previouslyOwned: [capturedRoot],
      }).map((item) => item.pid),
    ).toEqual([100, 101]);
  });

  it("uses only an absolute ownership marker when the root has already exited", () => {
    const ownedMarker = path.join(
      os.tmpdir(),
      "paperclip-root-gone-owned-12345678",
    );
    const otherMarker = path.join(
      os.tmpdir(),
      "paperclip-root-gone-other-12345678",
    );
    const snapshot = [
      identity(101, 1, "2026-07-29T18:00:01.000Z", `node service.js ${ownedMarker}`),
      identity(201, 1, "2026-07-29T18:00:01.000Z", `node service.js ${otherMarker}`),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: 100,
        ownerMarkers: ["node service.js", ownedMarker],
      }).map((item) => item.pid),
    ).toEqual([101]);
  });

  it("retains marker ownership when an exactly captured root has already exited", () => {
    const ownedMarker = path.join(
      os.tmpdir(),
      "paperclip-root-gone-captured-12345678",
    );
    const capturedRoot = identity(
      100,
      1,
      "2026-07-29T18:00:00.000Z",
      `node service.js ${ownedMarker}`,
    );
    const snapshot = [
      identity(101, 1, "2026-07-29T18:00:01.000Z", `node child.js ${ownedMarker}`),
      identity(201, 1, "2026-07-29T18:00:01.000Z", "node unrelated.js"),
    ];

    expect(
      selectOwnedWindowsTestProcessTree({
        snapshot,
        rootPid: capturedRoot.pid,
        ownerMarkers: [ownedMarker],
        previouslyOwned: [capturedRoot],
      }).map((item) => item.pid),
    ).toEqual([101]);
  });

  it("rejects a whole CIM snapshot when any identity record is malformed", () => {
    const valid = {
      pid: 100,
      parentPid: 1,
      createdAt: "2026-07-29T18:00:00.000Z",
      commandLine: "node service.js",
    };

    expect(() => parseWindowsTestProcessSnapshot(JSON.stringify([
      valid,
      { ...valid, pid: "101" },
    ]))).toThrow(/invalid windows process snapshot identity/i);
    expect(() => parseWindowsTestProcessSnapshot(JSON.stringify([
      valid,
      { ...valid, pid: 101, createdAt: "not-a-timestamp" },
    ]))).toThrow(/invalid windows process snapshot identity/i);
    expect(() => parseWindowsTestProcessSnapshot(JSON.stringify([
      valid,
      { ...valid, commandLine: undefined },
    ]))).toThrow(/invalid windows process snapshot identity/i);
    expect(() => parseWindowsTestProcessSnapshot(JSON.stringify([
      valid,
      { ...valid },
    ]))).toThrow(/duplicate pid/i);
  });

  windowsOnly(
    "observes a live marked process but sends no bare-PID signal or stop claim",
    async () => {
      const marker = path.join(
        os.tmpdir(),
        `paperclip-process-tree-${randomUUID()}`,
      );
      const root = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000);", marker],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const rootExit = new Promise<void>((resolve) => {
        root.once("exit", () => resolve());
      });

      try {
        const rootIdentity = await readWindowsTestProcessIdentity(root.pid!);
        expect(rootIdentity).not.toBeNull();
        const result = await reapWindowsTestProcessTree({
          rootPid: root.pid!,
          ownerMarkers: [],
          expectedRootIdentity: rootIdentity!,
          timeoutMs: 8_000,
        });
        expect(result).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          reason: "advisory_only_without_job_object",
          attemptedPids: [],
        });
        expect(result.capturedPids).toContain(root.pid!);
        expect(result.remainingPids).toContain(root.pid!);
        expect(result.snapshots).toBe(1);
        expect(root.exitCode).toBeNull();
      } finally {
        if (root.exitCode === null && root.signalCode === null) {
          expect(root.kill("SIGKILL")).toBe(true);
        }
        await waitForFixtureExit(rootExit);
        expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      }
    },
    15_000,
  );
});
