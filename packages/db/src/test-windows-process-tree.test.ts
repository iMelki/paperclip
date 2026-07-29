import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWindowsTestProcessIdentity,
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

  windowsOnly(
    "reaps a live marked Node process tree and reports before/after evidence",
    async () => {
      const marker = path.join(
        os.tmpdir(),
        `paperclip-process-tree-${randomUUID()}`,
      );
      const rootScript = [
        "const { spawn } = require('node:child_process');",
        "const marker = process.argv[1];",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { windowsHide: true });",
        "console.log(child.pid);",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const root = spawn(
        process.execPath,
        ["-e", rootScript, marker],
        {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      const childPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for child PID")),
          5_000,
        );
        root.stdout?.once("data", (chunk) => {
          clearTimeout(timeout);
          resolve(Number.parseInt(String(chunk).trim(), 10));
        });
        root.once("error", reject);
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
          attempted: true,
          confirmedStopped: true,
          reason: "reaped",
          remainingPids: [],
        });
        expect(result.capturedPids).toEqual(
          expect.arrayContaining([root.pid!, childPid]),
        );
        expect(result.snapshots).toBeGreaterThanOrEqual(2);
      } finally {
        if (root.exitCode === null && root.pid) {
          const taskkill = path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          );
          await new Promise<void>((resolve) => {
            execFile(
              taskkill,
              ["/PID", String(root.pid), "/T", "/F"],
              { windowsHide: true },
              () => resolve(),
            );
          });
        }
      }
    },
    15_000,
  );
});
