import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WindowsJobObjectTerminationReceipt,
  WindowsTestJobCustody,
} from "./windows-test-job-warden.js";

const execFileAsync = promisify(execFile);
const windowsPowerShellCommand = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const MAX_WINDOWS_PROCESS_ID = 0x7fffffff;

export type WindowsTestProcessIdentity = {
  pid: number;
  parentPid: number;
  createdAt: string;
  commandLine: string | null;
};

export type ReapWindowsTestProcessTreeResult = {
  attempted: boolean;
  /**
   * Authoritative kernel receipt ONLY: TerminateJobObject followed by a
   * post-terminate ActiveProcesses === 0 read, via launch-time Job Object
   * custody. Never issued from a CIM snapshot, however empty that snapshot is.
   */
  confirmedStopped: boolean;
  /**
   * Advisory observation, deliberately a separate field from confirmedStopped:
   * a full CIM enumeration succeeded and attributed no live process to this
   * tree. It is the strongest fact available to a caller that cannot hold
   * custody, and it is strictly weaker than confirmedStopped -- it cannot see
   * a reparented descendant whose command line no longer carries an owner
   * marker. Callers may gate cleanup on it; no caller may report it as a stop.
   */
  observedNoOwnedProcesses: boolean;
  /**
   * How any stop was established. Three outcomes, never collapsed:
   *   "kernel"   TerminateJobObject + ActiveProcesses === 0. The only source
   *              of confirmedStopped.
   *   "forced"   a kill was sent -- by forceWithoutCustody, or a Job Object
   *              terminate whose outcome could not be read. Forced, not
   *              confirmed: an action was taken, not a fact established.
   *   "advisory" nothing was signalled; any conclusion is an observation.
   * Deliberately, no non-kernel value is a word a caller could read as a
   * confirmation.
   */
  stopEvidence: "kernel" | "forced" | "advisory";
  reason:
    | "not_windows"
    | "no_owned_processes"
    | "ownership_evidence_unusable"
    | "reaped"
    | "untrusted_root"
    | "snapshot_failed"
    | "still_running"
    | "advisory_only_without_job_object"
    | "forced_none_observed"
    | "forced_still_running"
    | "forced_unobserved"
    | "job_terminate_unconfirmed"
    | "job_containment_incomplete";
  rootPid: number;
  capturedPids: number[];
  attemptedPids: number[];
  remainingPids: number[];
  snapshots: number;
  jobReceipt?: WindowsJobObjectTerminationReceipt;
};

function normalizeMarker(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

function normalizeCommandLine(value: string | null): string {
  return (value ?? "").replaceAll("/", "\\").toLowerCase();
}

function identityKey(
  processIdentity: Pick<WindowsTestProcessIdentity, "pid" | "createdAt">,
): string {
  return `${processIdentity.pid}:${processIdentity.createdAt}`;
}

function hasOwnedMarker(
  processIdentity: WindowsTestProcessIdentity,
  ownerMarkers: string[],
): boolean {
  const commandLine = normalizeCommandLine(processIdentity.commandLine);
  return ownerMarkers.some((marker) => commandLine.includes(marker));
}

function normalizeOwnershipMarkers(ownerMarkers: string[]): string[] {
  return ownerMarkers
    .map((marker) => marker.trim())
    .filter((marker) => marker.length >= 8 && path.isAbsolute(marker))
    .map(normalizeMarker);
}

function hasValidLineage(
  parent: WindowsTestProcessIdentity,
  child: WindowsTestProcessIdentity,
): boolean {
  const parentCreatedAt = Date.parse(parent.createdAt);
  const childCreatedAt = Date.parse(child.createdAt);
  return Number.isFinite(parentCreatedAt)
    && Number.isFinite(childCreatedAt)
    && parentCreatedAt <= childCreatedAt;
}

export function selectOwnedWindowsTestProcessTree(input: {
  snapshot: WindowsTestProcessIdentity[];
  rootPid: number;
  ownerMarkers: string[];
  previouslyOwned?: WindowsTestProcessIdentity[];
}): WindowsTestProcessIdentity[] {
  const markers = normalizeOwnershipMarkers(input.ownerMarkers);
  if (
    markers.length === 0
    && (input.previouslyOwned?.length ?? 0) === 0
  ) {
    return [];
  }

  const byPid = new Map(input.snapshot.map((item) => [item.pid, item]));
  const previousKeys = new Set(
    (input.previouslyOwned ?? []).map(identityKey),
  );
  const selected = new Map<number, WindowsTestProcessIdentity>();
  const rootIsMissing = input.rootPid <= 0 || !byPid.has(input.rootPid);

  for (const item of input.snapshot) {
    if (previousKeys.has(identityKey(item))) {
      selected.set(item.pid, item);
    }
    if (
      rootIsMissing
      && hasOwnedMarker(item, markers)
    ) {
      selected.set(item.pid, item);
    }
  }

  const root = byPid.get(input.rootPid);
  if (
    root
    && (
      previousKeys.has(identityKey(root))
      || (
        (input.previouslyOwned?.length ?? 0) === 0
        && hasOwnedMarker(root, markers)
      )
    )
  ) {
    selected.set(root.pid, root);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of input.snapshot) {
      if (selected.has(item.pid)) continue;
      const parent = selected.get(item.parentPid);
      if (!parent || !hasValidLineage(parent, item)) continue;
      selected.set(item.pid, item);
      changed = true;
    }
  }

  return [...selected.values()].sort((left, right) => {
    if (left.pid === input.rootPid) return -1;
    if (right.pid === input.rootPid) return 1;
    return left.pid - right.pid;
  });
}

export function parseWindowsTestProcessSnapshot(
  stdout: string,
): WindowsTestProcessIdentity[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid Windows process snapshot: expected an array.");
  }
  const seenPids = new Set<number>();
  return parsed.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid Windows process snapshot record.");
    }
    const value = record as Record<string, unknown>;
    const pid = value.pid;
    const parentPid = value.parentPid;
    if (
      typeof pid !== "number"
      || !Number.isInteger(pid)
      || pid < 0
      || pid > MAX_WINDOWS_PROCESS_ID
      || typeof parentPid !== "number"
      || !Number.isInteger(parentPid)
      || parentPid < 0
      || parentPid > MAX_WINDOWS_PROCESS_ID
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
      || (value.commandLine !== null && typeof value.commandLine !== "string")
    ) {
      throw new Error("Invalid Windows process snapshot identity.");
    }
    if (seenPids.has(pid)) {
      throw new Error("Invalid Windows process snapshot: duplicate PID.");
    }
    seenPids.add(pid);
    return {
      pid,
      parentPid,
      createdAt: value.createdAt,
      commandLine: value.commandLine,
    };
  });
}

export async function readWindowsTestProcessIdentity(
  pid: number,
  timeoutMs = 5_000,
): Promise<WindowsTestProcessIdentity | null> {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$items = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ForEach-Object {`,
    "  [pscustomobject]@{",
    "    pid = [int]$_.ProcessId",
    "    parentPid = [int]$_.ParentProcessId",
    "    createdAt = $_.CreationDate.ToUniversalTime().ToString('o')",
    "    commandLine = $_.CommandLine",
    "  }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($items)))",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShellCommand,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: Math.max(250, Math.min(5_000, timeoutMs)),
      maxBuffer: 1024 * 1024,
    },
  );
  return parseWindowsTestProcessSnapshot(stdout)[0] ?? null;
}

export async function snapshotWindowsTestProcesses(
  timeoutMs = 10_000,
): Promise<
  WindowsTestProcessIdentity[]
> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{",
    "    pid = [int]$_.ProcessId",
    "    parentPid = [int]$_.ParentProcessId",
    "    createdAt = $_.CreationDate.ToUniversalTime().ToString('o')",
    "    commandLine = $_.CommandLine",
    "  }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($items)))",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShellCommand,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: Math.max(1, Math.min(10_000, timeoutMs)),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseWindowsTestProcessSnapshot(stdout);
}

// Two CIM/StartTime renderings of the same kernel creation time agree to well
// under a millisecond. A mismatch means "not the process we captured", and the
// safe response to any doubt is to leave the process alone.
const SIGNAL_IDENTITY_TOLERANCE_MS = 2;

/**
 * Terminate exactly the captured process identities, never a bare PID.
 *
 * For each target the script opens a handle to the PID and touches `.Handle`,
 * which pins the kernel process object: while that handle is open the PID
 * cannot be recycled. Only then does it compare the process's real creation
 * time against the captured `createdAt`, and it calls Kill() on that same
 * pinned object. A PID that was reused after the snapshot has a different
 * creation time and is skipped. Returns the PIDs that were actually signalled.
 *
 * This is an action, not a receipt: success here never implies the tree
 * stopped. Only a Job Object read can say that.
 */
export async function signalVerifiedWindowsTestProcesses(
  targets: Pick<WindowsTestProcessIdentity, "pid" | "createdAt">[],
  timeoutMs = 5_000,
): Promise<number[]> {
  if (process.platform !== "win32" || targets.length === 0) return [];
  // Deepest first. Owned lineage requires a child to be created no earlier
  // than its parent, so descending creation time orders children before
  // parents. Killing a parent first leaves the outcome to whatever the parent
  // does to its children on exit (a Node parent's libuv job kills them; a
  // postmaster's children are orphaned), which is not ours to rely on.
  const ordered = [...targets].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const payload = JSON.stringify(
    ordered.map((target) => ({ pid: target.pid, createdAt: target.createdAt })),
  );
  if (payload.includes("'")) {
    throw new Error("Refusing to embed a process identity containing a quote.");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$targets = ConvertFrom-Json -InputObject '${payload}'`,
    "$signalled = New-Object System.Collections.Generic.List[int]",
    "foreach ($t in @($targets)) {",
    "  $p = $null",
    "  try { $p = [System.Diagnostics.Process]::GetProcessById([int]$t.pid) } catch { continue }",
    "  try {",
    "    $null = $p.Handle",
    // PS 7 would auto-convert an ISO string to DateTime; casting that back to
    // [string] re-renders it in local culture and shifts the instant. Branch
    // on the type instead of casting.
    "    $raw = $t.createdAt",
    "    if ($raw -is [DateTime]) { $expected = $raw.ToUniversalTime() } else {",
    "      $expected = [DateTime]::Parse($raw, [Globalization.CultureInfo]::InvariantCulture,"
      + " [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }",
    "    $actual = $p.StartTime.ToUniversalTime()",
    `    if ([Math]::Abs(($actual - $expected).TotalMilliseconds) -gt ${SIGNAL_IDENTITY_TOLERANCE_MS}) { continue }`,
    "    $p.Kill()",
    "    $signalled.Add([int]$t.pid)",
    "  } catch { continue } finally { $p.Dispose() }",
    "}",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($signalled.ToArray())))",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShellCommand,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: Math.max(250, Math.min(10_000, timeoutMs)),
      maxBuffer: 1024 * 1024,
    },
  );
  const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values
    .filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
    .sort((left, right) => left - right);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reapWindowsTestProcessTree(input: {
  rootPid: number;
  ownerMarkers: string[];
  expectedRootIdentity?: WindowsTestProcessIdentity;
  timeoutMs?: number;
  // Launch-time Job Object custody (windows-test-job-warden.ts) is the only
  // mechanism that may promote a CIM snapshot from advisory to authoritative:
  // TerminateJobObject + a post-terminate ActiveProcesses==0 read is a kernel
  // statement that every process ever assigned to the job (including
  // descendants created after assignment, since breakaway is denied) has
  // exited -- unlike the snapshot below, it closes the PID-reuse and
  // unobserved-intermediate races described in the comment further down.
  jobCustody?: WindowsTestJobCustody;
  // Explicit force opt-in, OFF by default. Without it, nothing is signalled
  // on the no-custody path. With it, only a tree whose ownership is proven
  // (absolute marker or exact root identity) is terminated, through
  // signalVerifiedWindowsTestProcesses -- identity-bound, never a bare PID --
  // and never when ownership evidence is unusable. The result is
  // stopEvidence "forced": never confirmedStopped.
  forceWithoutCustody?: boolean;
}): Promise<ReapWindowsTestProcessTreeResult> {
  const rootPid = Number.isInteger(input.rootPid) && input.rootPid > 0
    ? input.rootPid
    : 0;
  const base = {
    rootPid,
    observedNoOwnedProcesses: false,
    stopEvidence: "advisory" as ReapWindowsTestProcessTreeResult["stopEvidence"],
    capturedPids: [] as number[],
    attemptedPids: [] as number[],
    remainingPids: [] as number[],
    snapshots: 0,
  };
  if (process.platform !== "win32") {
    return {
      ...base,
      attempted: false,
      // Nothing was stopped and nothing was observed: this helper is a no-op
      // off Windows. confirmedStopped is reserved for the kernel receipt.
      confirmedStopped: false,
      reason: "not_windows",
    };
  }
  if (rootPid === process.pid) {
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "untrusted_root",
    };
  }

  const timeoutMs = Math.max(500, input.timeoutMs ?? 5_000);

  if (input.jobCustody) {
    if (
      rootPid === 0
      || input.jobCustody.rootPid !== rootPid
      || typeof input.jobCustody.serviceId !== "string"
      || input.jobCustody.serviceId.length === 0
    ) {
      return {
        ...base,
        attempted: false,
        confirmedStopped: false,
        reason: "job_containment_incomplete",
      };
    }

    // Exact launch-time custody is operationally primary: do not spend any of
    // its bounded termination budget on CIM/root-liveness diagnostics first.
    // A dead MSYS wrapper and a reparented native child are still members of
    // the retained Job Object, while numeric PID/CIM evidence is advisory.
    const termination = await input.jobCustody.terminate(timeoutMs);
    if (!termination.ok) {
      return {
        rootPid,
        attempted: true,
        confirmedStopped: false,
        observedNoOwnedProcesses: false,
        stopEvidence: "forced",
        reason: "job_terminate_unconfirmed",
        capturedPids: [],
        attemptedPids: [],
        remainingPids: [],
        snapshots: 0,
      };
    }

    const receipt = termination.receipt;
    if (
      receipt.authority !== "job_object_kernel"
      || receipt.authoritative !== true
      || receipt.serviceId !== input.jobCustody.serviceId
      || receipt.rootPid !== rootPid
      || receipt.activeProcessesAfter !== 0
    ) {
      return {
        rootPid,
        attempted: true,
        confirmedStopped: false,
        observedNoOwnedProcesses: false,
        stopEvidence: "forced",
        reason: "job_terminate_unconfirmed",
        capturedPids: [],
        attemptedPids: [],
        remainingPids: [],
        snapshots: 0,
      };
    }

    return {
      rootPid,
      attempted: true,
      confirmedStopped: true,
      // The kernel's ActiveProcesses === 0 read is a superset of the advisory
      // observation, so this is the one place both may be asserted together.
      observedNoOwnedProcesses: true,
      stopEvidence: "kernel",
      reason: "reaped",
      // PID-list marshaling is not yet available. Do not mislabel advisory
      // CIM observations as the exact set acted on by TerminateJobObject.
      capturedPids: [],
      attemptedPids: [],
      remainingPids: [],
      snapshots: 0,
      jobReceipt: receipt,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let snapshot: WindowsTestProcessIdentity[];
  let snapshots = 0;
  try {
    snapshot = await snapshotWindowsTestProcesses(
      Math.max(1, deadline - Date.now()),
    );
    snapshots += 1;
  } catch {
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "snapshot_failed",
      snapshots,
    };
  }
  // rootPid 0 means "root unknown" (e.g. an unreadable postmaster.pid), not a
  // real process. A CIM snapshot DOES contain PID 0 -- the System Idle Process
  // -- so looking it up made every unknown-root call report untrusted_root and
  // made the marker-only path unreachable. selectOwnedWindowsTestProcessTree
  // already treats rootPid <= 0 as missing; this keeps the two consistent.
  const root = rootPid > 0
    ? snapshot.find((item) => item.pid === rootPid)
    : undefined;
  const ownershipMarkers = normalizeOwnershipMarkers(input.ownerMarkers);
  if (
    input.expectedRootIdentity
    && root
    && identityKey(root) !== identityKey(input.expectedRootIdentity)
  ) {
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "untrusted_root",
      snapshots,
    };
  }
  if (
    input.expectedRootIdentity
    && !root
    && ownershipMarkers.length === 0
  ) {
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "untrusted_root",
      snapshots,
    };
  }
  const owned = selectOwnedWindowsTestProcessTree({
    snapshot,
    rootPid,
    ownerMarkers: input.ownerMarkers,
    previouslyOwned: input.expectedRootIdentity
      ? [input.expectedRootIdentity]
      : undefined,
  });
  if (
    root
    && !owned.some((item) => item.pid === rootPid)
  ) {
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "untrusted_root",
      snapshots,
    };
  }
  if (owned.length === 0) {
    // An empty owned set has two completely different causes, and collapsing
    // them is a fail-open: "the instrument found nothing running" and "there
    // was no instrument" must not share a reason code. Ownership evidence is
    // usable only if at least one marker survived normalization (absolute and
    // >= 8 chars) or an exact root identity was supplied; otherwise nothing
    // could have been attributed to this tree even if it were fully alive.
    if (ownershipMarkers.length === 0 && !input.expectedRootIdentity) {
      return {
        ...base,
        attempted: false,
        confirmedStopped: false,
        observedNoOwnedProcesses: false,
        reason: "ownership_evidence_unusable",
        snapshots,
      };
    }
    // Deliberately NOT confirmedStopped, and this is the case that will most
    // tempt the next reader to "fix" it, so the reasoning lives here:
    //
    // An empty tree feels like success -- there is nothing left to stop. But
    // without jobCustody we do not know the tree is empty; we know that one
    // CIM enumeration attributed nothing to it, which is a weaker statement
    // produced by a weaker instrument. Absence of an observation is not an
    // authoritative kernel statement that nothing is running: a descendant
    // that was reparented and no longer carries an owner marker is invisible
    // here and still alive. confirmedStopped means TerminateJobObject plus
    // ActiveProcesses === 0 and nothing else, so the honest result is the
    // advisory observation below. Callers that cannot hold custody may gate
    // cleanup on observedNoOwnedProcesses, knowingly; none may call it a stop.
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      observedNoOwnedProcesses: true,
      reason: "no_owned_processes",
      snapshots,
    };
  }
  const ownedPids = owned
    .map((item) => item.pid)
    .sort((left, right) => left - right);

  // CIM PID/creation/lineage snapshots are advisory observations. A process can
  // exit and have its PID reused after this snapshot but before a bare-PID kill,
  // and an unobserved intermediate can leave a reparented descendant. Without a
  // launch-time Job Object this helper must never send a bare-PID signal and
  // must never claim the tree stopped.
  if (!input.forceWithoutCustody) {
    return {
      rootPid,
      attempted: false,
      confirmedStopped: false,
      observedNoOwnedProcesses: false,
      stopEvidence: "advisory",
      reason: "advisory_only_without_job_object",
      capturedPids: ownedPids,
      attemptedPids: [],
      remainingPids: ownedPids,
      snapshots,
    };
  }

  // Opted-in force path. Reached only after ownership was proven by an
  // owner marker or the exact expected root identity: the untrusted_root,
  // ownership_evidence_unusable and no_owned_processes exits above all return
  // before this point, so a tree we cannot identify is never signalled. Each
  // target is re-verified by creation time on a pinned handle before Kill().
  let attemptedPids: number[] = [];
  try {
    attemptedPids = await signalVerifiedWindowsTestProcesses(
      owned,
      Math.max(250, deadline - Date.now()),
    );
  } catch {
    attemptedPids = [];
  }

  // Observe the outcome. A killed process can linger in CIM for a moment, so
  // re-observe a bounded number of times. We never re-signal: one verified
  // pass is the whole action this path is allowed.
  let remaining: WindowsTestProcessIdentity[] | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    if (pass > 0) {
      if (deadline - Date.now() < 500) break;
      await delay(250);
    }
    try {
      const after = await snapshotWindowsTestProcesses(
        Math.max(250, deadline - Date.now()),
      );
      snapshots += 1;
      remaining = selectOwnedWindowsTestProcessTree({
        snapshot: after,
        rootPid,
        ownerMarkers: input.ownerMarkers,
        previouslyOwned: owned,
      });
    } catch {
      break;
    }
    if (remaining.length === 0) break;
  }

  // Whatever was observed, confirmedStopped stays false. A signal plus an
  // empty CIM enumeration is still an advisory statement: it cannot see a
  // reparented descendant that lost its marker. The advisory fact goes in
  // observedNoOwnedProcesses, which is the field callers may gate reclaim on.
  if (remaining === null) {
    return {
      rootPid,
      attempted: attemptedPids.length > 0,
      confirmedStopped: false,
      observedNoOwnedProcesses: false,
      stopEvidence: "forced",
      reason: "forced_unobserved",
      capturedPids: ownedPids,
      attemptedPids,
      remainingPids: ownedPids,
      snapshots,
    };
  }
  const remainingPids = remaining
    .map((item) => item.pid)
    .sort((left, right) => left - right);
  return {
    rootPid,
    attempted: attemptedPids.length > 0,
    confirmedStopped: false,
    observedNoOwnedProcesses: remainingPids.length === 0,
    stopEvidence: "forced",
    reason: remainingPids.length === 0 ? "forced_none_observed" : "forced_still_running",
    capturedPids: ownedPids,
    attemptedPids,
    remainingPids,
    snapshots,
  };
}
