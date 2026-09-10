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
const MAX_WINDOWS_PROCESS_ID = 0xffffffff;

export type WindowsProcessIdentity = {
  pid: number;
  parentPid: number;
  createdAt: string;
};

export type WindowsProcessTreeReceipt = {
  // A CIM snapshot is useful observability, but cannot close the race where an
  // unseen intermediate creates a grandchild and exits between observations.
  // Only launch-time kernel containment (for example, a Windows Job Object)
  // may introduce an authoritative receipt variant in the future.
  authority: "snapshot_advisory";
  authoritative: false;
  root: WindowsProcessIdentity;
  captured: WindowsProcessIdentity[];
  remaining: WindowsProcessIdentity[];
  snapshots: number;
  consecutiveAbsentSnapshots: number;
};

function identityKey(identity: Pick<WindowsProcessIdentity, "pid" | "createdAt">) {
  return `${identity.pid}:${identity.createdAt}`;
}

function isValidProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_WINDOWS_PROCESS_ID;
}

function parseWindowsProcessSnapshot(stdout: string): WindowsProcessIdentity[] {
  const parsed = JSON.parse(stdout) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const result: WindowsProcessIdentity[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("windows_process_snapshot_invalid_record");
    }
    const value = record as Record<string, unknown>;
    const pid = Number(value.pid);
    const parentPid = Number(value.parentPid);
    const createdAt = value.createdAt;
    // The System Idle Process is represented as PID 0 and can never be an
    // application-owned root or descendant signal target.
    if (pid === 0) continue;
    if (
      !isValidProcessId(pid)
      || !Number.isSafeInteger(parentPid)
      || parentPid < 0
      || parentPid > MAX_WINDOWS_PROCESS_ID
      || typeof createdAt !== "string"
      || !Number.isFinite(Date.parse(createdAt))
    ) {
      throw new Error("windows_process_snapshot_invalid_identity");
    }
    result.push({ pid, parentPid, createdAt });
  }
  return result;
}

export async function snapshotWindowsProcesses(
  timeoutMs = 5_000,
): Promise<WindowsProcessIdentity[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{",
    "    pid = [int]$_.ProcessId",
    "    parentPid = [int]$_.ParentProcessId",
    "    createdAt = $_.CreationDate.ToUniversalTime().ToString('o')",
    "  }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($items)))",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShellCommand,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      timeout: Math.max(250, Math.min(10_000, timeoutMs)),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseWindowsProcessSnapshot(stdout);
}

function hasValidLineage(
  parent: WindowsProcessIdentity,
  child: WindowsProcessIdentity,
) {
  const parentCreatedAt = Date.parse(parent.createdAt);
  const childCreatedAt = Date.parse(child.createdAt);
  return Number.isFinite(parentCreatedAt)
    && Number.isFinite(childCreatedAt)
    && parentCreatedAt <= childCreatedAt;
}

/**
 * Selects exact captured identities plus descendants of any captured identity.
 *
 * Windows keeps a creator PID after the creator exits, and PIDs are reusable.
 * Exact PID + creation-time matching therefore preserves already-captured
 * descendants after reparenting, while lineage expansion detects children that
 * raced the first snapshot without treating a reused PID as the same process.
 */
export function selectTrackedWindowsProcessTree(input: {
  snapshot: WindowsProcessIdentity[];
  captured: WindowsProcessIdentity[];
}): WindowsProcessIdentity[] {
  const capturedKeys = new Set(input.captured.map(identityKey));
  const knownParents = new Map<number, WindowsProcessIdentity[]>();
  for (const identity of input.captured) {
    const identities = knownParents.get(identity.pid) ?? [];
    identities.push(identity);
    knownParents.set(identity.pid, identities);
  }

  const selected = new Map<string, WindowsProcessIdentity>();
  for (const identity of input.snapshot) {
    if (capturedKeys.has(identityKey(identity))) {
      selected.set(identityKey(identity), identity);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of input.snapshot) {
      const key = identityKey(identity);
      if (selected.has(key)) continue;
      const parents = knownParents.get(identity.parentPid) ?? [];
      if (!parents.some((parent) => hasValidLineage(parent, identity))) continue;
      selected.set(key, identity);
      const identities = knownParents.get(identity.pid) ?? [];
      identities.push(identity);
      knownParents.set(identity.pid, identities);
      changed = true;
    }
  }

  return [...selected.values()].sort((left, right) => left.pid - right.pid);
}

export async function captureWindowsProcessTreeReceipt(input: {
  rootPid: number;
  timeoutMs?: number;
}): Promise<WindowsProcessTreeReceipt | null> {
  if (process.platform !== "win32" || !isValidProcessId(input.rootPid)) {
    return null;
  }
  const snapshot = await snapshotWindowsProcesses(input.timeoutMs);
  const root = snapshot.find((identity) => identity.pid === input.rootPid);
  if (!root) return null;
  const captured = selectTrackedWindowsProcessTree({
    snapshot,
    captured: [root],
  });
  return {
    authority: "snapshot_advisory",
    authoritative: false,
    root,
    captured,
    remaining: captured,
    snapshots: 1,
    consecutiveAbsentSnapshots: 0,
  };
}

export async function observeWindowsProcessTreeReceipt(input: {
  receipt: WindowsProcessTreeReceipt;
  timeoutMs?: number;
}): Promise<WindowsProcessTreeReceipt> {
  const snapshot = await snapshotWindowsProcesses(input.timeoutMs);
  const remaining = selectTrackedWindowsProcessTree({
    snapshot,
    captured: input.receipt.captured,
  });
  const capturedByKey = new Map(
    input.receipt.captured.map((identity) => [identityKey(identity), identity]),
  );
  for (const identity of remaining) {
    capturedByKey.set(identityKey(identity), identity);
  }
  return {
    ...input.receipt,
    captured: [...capturedByKey.values()].sort((left, right) => left.pid - right.pid),
    remaining,
    snapshots: input.receipt.snapshots + 1,
    consecutiveAbsentSnapshots: remaining.length === 0
      ? input.receipt.consecutiveAbsentSnapshots + 1
      : 0,
  };
}
