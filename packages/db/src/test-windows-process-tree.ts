import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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
  confirmedStopped: boolean;
  reason:
    | "not_windows"
    | "no_owned_processes"
    | "reaped"
    | "untrusted_root"
    | "snapshot_failed"
    | "still_running"
    | "advisory_only_without_job_object";
  rootPid: number;
  capturedPids: number[];
  attemptedPids: number[];
  remainingPids: number[];
  snapshots: number;
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

export async function reapWindowsTestProcessTree(input: {
  rootPid: number;
  ownerMarkers: string[];
  expectedRootIdentity?: WindowsTestProcessIdentity;
  timeoutMs?: number;
}): Promise<ReapWindowsTestProcessTreeResult> {
  const rootPid = Number.isInteger(input.rootPid) && input.rootPid > 0
    ? input.rootPid
    : 0;
  const base = {
    rootPid,
    capturedPids: [] as number[],
    attemptedPids: [] as number[],
    remainingPids: [] as number[],
    snapshots: 0,
  };
  if (process.platform !== "win32") {
    return {
      ...base,
      attempted: false,
      confirmedStopped: true,
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

  const deadline = Date.now() + Math.max(500, input.timeoutMs ?? 5_000);
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
  const root = snapshot.find((item) => item.pid === rootPid);
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
    return {
      ...base,
      attempted: false,
      confirmedStopped: false,
      reason: "no_owned_processes",
      snapshots,
    };
  }
  // CIM PID/creation/lineage snapshots are advisory observations. A process can
  // exit and have its PID reused after this snapshot but before a bare-PID kill,
  // and an unobserved intermediate can leave a reparented descendant. Without a
  // launch-time Job Object and retained kernel handle, this helper must not
  // signal or claim the tree stopped—even in test cleanup on an operator host.
  return {
    rootPid,
    attempted: false,
    confirmedStopped: false,
    reason: "advisory_only_without_job_object",
    capturedPids: owned
      .map((item) => item.pid)
      .sort((left, right) => left - right),
    attemptedPids: [],
    remainingPids: owned
      .map((item) => item.pid)
      .sort((left, right) => left - right),
    snapshots,
  };
}
