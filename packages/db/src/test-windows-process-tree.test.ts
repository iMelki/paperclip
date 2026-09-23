import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWindowsTestProcessIdentity,
  parseWindowsTestProcessSnapshot,
  reapWindowsTestProcessTree,
  selectOwnedWindowsTestProcessTree,
  signalVerifiedWindowsTestProcesses,
  type WindowsTestProcessIdentity,
} from "./test-windows-process-tree.js";
import {
  acquireWindowsTestJobCustody,
  shutdownWindowsTestJobWardenForTests,
  type WindowsTestJobCustody,
} from "./windows-test-job-warden.js";

const windowsOnly = process.platform === "win32" ? it : it.skip;
const nonWindowsOnly = process.platform === "win32" ? it.skip : it;

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

  // --- no-custody (legacy caller) contract -----------------------------------
  // The callers below pass no jobCustody: cli/src/__tests__/
  // company-import-export-e2e.test.ts and packages/db/src/
  // test-embedded-postgres.ts. Neither had any coverage of these paths, which
  // is how an empty-tree result that reads like success reached main.

  windowsOnly(
    "reports an empty owned tree as an advisory observation, never as a confirmed stop",
    async () => {
      // An absolute marker that is well-formed (so ownership evidence is
      // usable) but matches no live process, so the owned set is empty.
      const marker = path.join(
        os.tmpdir(),
        `paperclip-absent-owner-${randomUUID()}`,
      );

      const result = await reapWindowsTestProcessTree({
        rootPid: 2_000_011,
        ownerMarkers: [marker],
        timeoutMs: 8_000,
      });

      // The whole point: an empty enumeration is the case that FEELS like
      // success. It must not be promoted to confirmedStopped without a kernel
      // statement, and the advisory fact must still be reported separately so
      // callers can act on it knowingly.
      expect(result).toMatchObject({
        attempted: false,
        confirmedStopped: false,
        observedNoOwnedProcesses: true,
        stopEvidence: "advisory",
        reason: "no_owned_processes",
      });
      expect(result.jobReceipt).toBeUndefined();
      expect(result.capturedPids).toEqual([]);
      expect(result.remainingPids).toEqual([]);
      expect(result.snapshots).toBe(1);
    },
    20_000,
  );

  windowsOnly(
    "separates unusable ownership evidence from an observed-empty owned tree",
    async () => {
      // No marker survives normalization (none is absolute), and no
      // expectedRootIdentity is supplied, so nothing could have been
      // attributed to this tree even if it were running. Reporting that as
      // "no owned processes" would be a fail-open: it is the absence of an
      // instrument, not the absence of processes.
      const result = await reapWindowsTestProcessTree({
        rootPid: 2_000_012,
        ownerMarkers: ["short", "also-not-absolute"],
        timeoutMs: 8_000,
      });

      expect(result).toMatchObject({
        attempted: false,
        confirmedStopped: false,
        observedNoOwnedProcesses: false,
        reason: "ownership_evidence_unusable",
      });
      expect(result.jobReceipt).toBeUndefined();
    },
    20_000,
  );

  windowsOnly(
    "reports a live no-custody tree as observed-not-stopped",
    async () => {
      const marker = path.join(
        os.tmpdir(),
        `paperclip-live-no-custody-${randomUUID()}`,
      );
      const root = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000);", marker],
        { stdio: "ignore", windowsHide: true },
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
          observedNoOwnedProcesses: false,
          stopEvidence: "advisory",
          reason: "advisory_only_without_job_object",
        });
        expect(result.remainingPids).toContain(root.pid!);
        expect(root.exitCode).toBeNull();
      } finally {
        if (root.exitCode === null && root.signalCode === null) {
          root.kill("SIGKILL");
        }
        await waitForFixtureExit(rootExit);
      }
    },
    20_000,
  );

  // --- explicit force opt-in (forceWithoutCustody) --------------------------
  // For callers that can never hold custody. Pinned in both directions:
  // without the opt-in a hung, identifiable tree is NOT signalled; with it,
  // unusable or unproven ownership is refused, a marker-verified tree is
  // forced, and the result is stopEvidence "forced" -- never confirmedStopped.


  async function expectStillAlive(child: ReturnType<typeof spawn>) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  }

  function spawnIdle(args: string[]) {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);", ...args],
      { stdio: "ignore", windowsHide: true },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    return { child, exited };
  }

  async function killFixture(fixture: ReturnType<typeof spawnIdle>) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
      fixture.child.kill("SIGKILL");
    }
    await waitForFixtureExit(fixture.exited);
  }

  windowsOnly(
    "does not signal a hung marker-verified tree unless force is requested by name",
    async () => {
      // Fully identifiable -- an absolute marker in its command line -- and
      // still left alone, because nobody asked for force.
      const marker = path.join(os.tmpdir(), `paperclip-no-force-${randomUUID()}`);
      const fixture = spawnIdle([marker]);
      try {
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(fixture.child.pid!)) !== null,
          { timeout: 5_000 },
        ).toBe(true);
        const result = await reapWindowsTestProcessTree({
          rootPid: fixture.child.pid!,
          ownerMarkers: [marker],
          timeoutMs: 10_000,
        });
        expect(result).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          observedNoOwnedProcesses: false,
          stopEvidence: "advisory",
          reason: "advisory_only_without_job_object",
          attemptedPids: [],
        });
        expect(result.remainingPids).toContain(fixture.child.pid!);
        await expectStillAlive(fixture.child);
      } finally {
        await killFixture(fixture);
      }
    },
    30_000,
  );

  windowsOnly(
    "signals a marker-verified tree without custody but never claims confirmedStopped",
    async () => {
      const marker = path.join(os.tmpdir(), `paperclip-advisory-signal-${randomUUID()}`);
      // The root carries the marker; its child does not and is owned only by
      // verified lineage. The root reports the child's PID so we can check it.
      const root = spawn(
        process.execPath,
        [
          "-e",
          "const cp=require('child_process');"
          + "const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{stdio:'ignore',windowsHide:true});"
          + "process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);",
          marker,
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      const rootExit = new Promise<void>((resolve) => {
        root.once("exit", () => resolve());
      });
      const childPid = await new Promise<number>((resolve, reject) => {
        let stdout = "";
        root.stdout!.setEncoding("utf8");
        root.stdout!.on("data", (chunk: string) => {
          stdout += chunk;
          const match = /^(\d+)\r?\n/.exec(stdout);
          if (match) resolve(Number.parseInt(match[1]!, 10));
        });
        root.once("exit", () => reject(new Error("root exited before reporting its child")));
      });

      try {
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(childPid)) !== null,
          { timeout: 5_000 },
        ).toBe(true);

        const result = await reapWindowsTestProcessTree({
          rootPid: root.pid!,
          ownerMarkers: [marker],
          timeoutMs: 20_000,
          forceWithoutCustody: true,
        });

        expect(result).toMatchObject({
          attempted: true,
          confirmedStopped: false,
          observedNoOwnedProcesses: true,
          stopEvidence: "forced",
          reason: "forced_none_observed",
          remainingPids: [],
        });
        expect(result.jobReceipt).toBeUndefined();
        expect(result.attemptedPids).toEqual(
          expect.arrayContaining([root.pid!, childPid]),
        );
        await waitForFixtureExit(rootExit, 5_000);
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(childPid)) === null,
          { timeout: 5_000 },
        ).toBe(true);
      } finally {
        if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
        await waitForFixtureExit(rootExit);
      }
    },
    45_000,
  );

  windowsOnly(
    "never signals a live root that lacks the ownership marker",
    async () => {
      const fixture = spawnIdle([]);
      try {
        const result = await reapWindowsTestProcessTree({
          rootPid: fixture.child.pid!,
          ownerMarkers: [path.join(os.tmpdir(), `paperclip-not-this-${randomUUID()}`)],
          timeoutMs: 10_000,
          forceWithoutCustody: true,
        });
        expect(result).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          observedNoOwnedProcesses: false,
          stopEvidence: "advisory",
          reason: "untrusted_root",
          attemptedPids: [],
        });
        await expectStillAlive(fixture.child);
      } finally {
        await killFixture(fixture);
      }
    },
    30_000,
  );

  windowsOnly(
    "never signals anything when ownership evidence is unusable, even where its text appears",
    async () => {
      // "paperclip-unusable-marker" is not absolute, so normalization drops it.
      // The live process literally carries that text; it must still survive.
      const fixture = spawnIdle(["paperclip-unusable-marker"]);
      try {
        const result = await reapWindowsTestProcessTree({
          rootPid: 0,
          ownerMarkers: ["paperclip-unusable-marker"],
          timeoutMs: 10_000,
          forceWithoutCustody: true,
        });
        expect(result).toMatchObject({
          attempted: false,
          confirmedStopped: false,
          observedNoOwnedProcesses: false,
          stopEvidence: "advisory",
          reason: "ownership_evidence_unusable",
          attemptedPids: [],
        });
        await expectStillAlive(fixture.child);
      } finally {
        await killFixture(fixture);
      }
    },
    30_000,
  );

  windowsOnly(
    "signals by absolute marker alone when the root PID is unknown, still advisory",
    async () => {
      // rootPid 0 is what the embedded-Postgres caller passes when
      // postmaster.pid cannot be read. PID 0 exists in CIM (System Idle
      // Process) and must not be mistaken for the root.
      const marker = path.join(os.tmpdir(), `paperclip-unknown-root-${randomUUID()}`);
      const fixture = spawnIdle([marker]);
      try {
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(fixture.child.pid!)) !== null,
          { timeout: 5_000 },
        ).toBe(true);
        const result = await reapWindowsTestProcessTree({
          rootPid: 0,
          ownerMarkers: [marker],
          timeoutMs: 20_000,
          forceWithoutCustody: true,
        });
        expect(result).toMatchObject({
          attempted: true,
          confirmedStopped: false,
          observedNoOwnedProcesses: true,
          stopEvidence: "forced",
          reason: "forced_none_observed",
          remainingPids: [],
        });
        expect(result.attemptedPids).toContain(fixture.child.pid!);
        await waitForFixtureExit(fixture.exited, 5_000);
      } finally {
        await killFixture(fixture);
      }
    },
    45_000,
  );

  windowsOnly(
    "refuses to signal a PID whose creation time does not match the captured identity",
    async () => {
      const fixture = spawnIdle([]);
      try {
        const real = await readWindowsTestProcessIdentity(fixture.child.pid!);
        expect(real).not.toBeNull();
        // Same PID, different creation time: exactly what a recycled PID
        // looks like. It must not be touched.
        const recycled = new Date(Date.parse(real!.createdAt) - 3_600_000).toISOString();
        expect(await signalVerifiedWindowsTestProcesses(
          [{ pid: real!.pid, createdAt: recycled }],
          10_000,
        )).toEqual([]);
        await expectStillAlive(fixture.child);

        // Positive control in the same run: the exact identity IS signalled.
        expect(await signalVerifiedWindowsTestProcesses([real!], 10_000)).toEqual([real!.pid]);
        await waitForFixtureExit(fixture.exited, 5_000);
      } finally {
        await killFixture(fixture);
      }
    },
    30_000,
  );

  nonWindowsOnly("never claims confirmedStopped off Windows, where it does nothing", async () => {
    const result = await reapWindowsTestProcessTree({ rootPid: 12345, ownerMarkers: [] });
    expect(result).toMatchObject({
      attempted: false,
      confirmedStopped: false,
      observedNoOwnedProcesses: false,
      stopEvidence: "advisory",
      reason: "not_windows",
    });
  });

  afterEach(async () => {
    await shutdownWindowsTestJobWardenForTests();
  });

  windowsOnly(
    "does not invoke Job Object termination when custody is not bound to the requested root",
    async () => {
      let terminateCalls = 0;
      const custody: WindowsTestJobCustody = {
        serviceId: "mismatched-root-custody",
        rootPid: 2_000_002,
        async terminate() {
          terminateCalls += 1;
          return { ok: false, reason: "should_not_run", activeProcesses: null };
        },
        async listPids() {
          return [];
        },
      };

      const result = await reapWindowsTestProcessTree({
        rootPid: 2_000_001,
        ownerMarkers: [],
        jobCustody: custody,
      });

      expect(result).toMatchObject({
        attempted: false,
        confirmedStopped: false,
        reason: "job_containment_incomplete",
      });
      expect(terminateCalls).toBe(0);
    },
  );

  windowsOnly(
    "rejects a successful Job Object response whose kernel receipt does not match custody",
    async () => {
      const rootPid = 2_000_003;
      const custody: WindowsTestJobCustody = {
        serviceId: "mismatched-receipt-custody",
        rootPid,
        async terminate() {
          return {
            ok: true,
            receipt: {
              authority: "job_object_kernel",
              authoritative: true,
              serviceId: "different-service",
              rootPid,
              jobPidsBeforeTerminate: [],
              activeProcessesAfter: 0,
              terminateError: null,
              waitMs: 0,
            },
          };
        },
        async listPids() {
          return [];
        },
      };

      const result = await reapWindowsTestProcessTree({
        rootPid,
        ownerMarkers: [],
        jobCustody: custody,
      });

      expect(result).toMatchObject({
        attempted: true,
        confirmedStopped: false,
        stopEvidence: "forced",
        reason: "job_terminate_unconfirmed",
      });
      expect(result.jobReceipt).toBeUndefined();
    },
  );

  windowsOnly(
    "kernel-confirms a stop and kills a grandchild spawned after custody was assigned, given jobCustody",
    async () => {
      // Root blocks on stdin before spawning anything, mirroring the
      // production release-gate (containment-from-birth): the grandchild
      // must not exist until custody is already assigned to root.
      const root = spawn(
        process.execPath,
        [
          "-e",
          "const cp=require('child_process');const readline=require('readline');"
          + "const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let released=false;"
          + "process.stdin.once('end',()=>{if(!released)process.exit(3);});"
          + "rl.once('line',(line)=>{if(line!=='go')process.exit(2);released=true;rl.close();"
          + "const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{stdio:'ignore',detached:true});"
          + "c.unref();setInterval(()=>{},1000);});",
        ],
        { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
      );
      const rootExit = new Promise<void>((resolve) => {
        root.once("exit", () => resolve());
      });

      try {
        const custody = await acquireWindowsTestJobCustody("job-warden-integration-test", root);
        expect(custody).not.toBeNull();
        root.stdin!.write("go\n"); // release the gate only after custody is kernel-established
        // Give the grandchild a moment to spawn inside the now-assigned job.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const rootIdentity = await readWindowsTestProcessIdentity(root.pid!);
        expect(rootIdentity).not.toBeNull();
        const result = await reapWindowsTestProcessTree({
          rootPid: root.pid!,
          ownerMarkers: [],
          expectedRootIdentity: rootIdentity!,
          timeoutMs: 8_000,
          jobCustody: custody!,
        });
        expect(result).toMatchObject({
          attempted: true,
          confirmedStopped: true,
          stopEvidence: "kernel",
          reason: "reaped",
          remainingPids: [],
          jobReceipt: {
            authority: "job_object_kernel",
            authoritative: true,
            serviceId: "job-warden-integration-test",
            rootPid: root.pid,
            activeProcessesAfter: 0,
          },
        });
        expect(result.attemptedPids).toEqual([]);
        expect(result.snapshots).toBe(0);
        await waitForFixtureExit(rootExit, 4_000);
        expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      } finally {
        if (root.exitCode === null && root.signalCode === null) {
          root.kill("SIGKILL");
          await waitForFixtureExit(rootExit);
        }
        root.stdin?.end();
        await waitForFixtureExit(rootExit);
      }
    },
    20_000,
  );

  windowsOnly(
    "kernel-confirms a native descendant stop after its MSYS-style root has already exited",
    async () => {
      const serviceId = `dead-root-job-warden-${randomUUID()}`;
      const root = spawn(
        process.execPath,
        [
          "-e",
          "const cp=require('child_process');const readline=require('readline');"
          + "const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let released=false;"
          + "process.stdin.once('end',()=>{if(!released)process.exit(3);});"
          + "rl.once('line',(line)=>{if(line!=='go')process.exit(2);released=true;rl.close();"
          + "const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);'],{stdio:'ignore',windowsHide:true,detached:true});"
          + "process.stdout.write(String(c.pid)+'\\n');c.unref();setTimeout(()=>{},500);});",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
      const rootExit = new Promise<void>((resolve) => {
        root.once("exit", () => resolve());
      });
      const childPidPromise = new Promise<number>((resolve, reject) => {
        let stdout = "";
        let settled = false;
        root.stdout!.setEncoding("utf8");
        root.stdout!.on("data", (chunk: string) => {
          if (settled) return;
          stdout += chunk;
          const match = /^(\d+)\r?\n/.exec(stdout);
          if (!match) return;
          settled = true;
          resolve(Number.parseInt(match[1]!, 10));
        });
        root.stdout!.once("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        root.once("exit", () => {
          if (settled) return;
          settled = true;
          reject(new Error("The root exited without reporting its native child PID."));
        });
      });
      let custody: WindowsTestJobCustody | null = null;
      let confirmedStopped = false;
      let childPid: number | null = null;

      try {
        custody = await acquireWindowsTestJobCustody(serviceId, root);
        expect(custody).not.toBeNull();
        const rootIdentity = await readWindowsTestProcessIdentity(root.pid!);
        expect(rootIdentity).not.toBeNull();

        root.stdin!.end("go\n");
        childPid = await childPidPromise;
        expect(childPid).toBeGreaterThan(0);
        await waitForFixtureExit(rootExit, 4_000);
        expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(childPid!)) !== null,
          { timeout: 4_000 },
        ).toBe(true);

        const result = await reapWindowsTestProcessTree({
          rootPid: root.pid!,
          ownerMarkers: [],
          expectedRootIdentity: rootIdentity!,
          timeoutMs: 8_000,
          jobCustody: custody!,
        });
        expect(result).toMatchObject({
          attempted: true,
          confirmedStopped: true,
          stopEvidence: "kernel",
          reason: "reaped",
          remainingPids: [],
          jobReceipt: {
            authority: "job_object_kernel",
            authoritative: true,
            serviceId,
            rootPid: root.pid,
            activeProcessesAfter: 0,
          },
        });
        confirmedStopped = true;
        await expect.poll(
          async () => (await readWindowsTestProcessIdentity(childPid!)) === null,
          { timeout: 4_000 },
        ).toBe(true);
      } finally {
        if (!confirmedStopped && custody) {
          await custody.terminate(8_000);
        }
        if (root.exitCode === null && root.signalCode === null) {
          root.kill("SIGKILL");
          await waitForFixtureExit(rootExit);
        }
        root.stdin?.end();
        await waitForFixtureExit(rootExit);
      }
    },
    25_000,
  );
});
