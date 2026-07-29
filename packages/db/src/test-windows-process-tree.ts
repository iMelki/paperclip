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
const taskkillCommand = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "taskkill.exe",
);

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
    | "still_running";
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

function parseWindowsTestProcessSnapshot(
  stdout: string,
): WindowsTestProcessIdentity[] {
  const parsed = JSON.parse(stdout) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const value = record as Record<string, unknown>;
    const pid = Number(value.pid);
    const parentPid = Number(value.parentPid);
    if (
      !Number.isInteger(pid)
      || pid <= 0
      || !Number.isInteger(parentPid)
      || parentPid < 0
      || typeof value.createdAt !== "string"
    ) {
      return [];
    }
    return [{
      pid,
      parentPid,
      createdAt: value.createdAt,
      commandLine:
        typeof value.commandLine === "string" ? value.commandLine : null,
    }];
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

async function taskkillWindowsTestProcess(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  await execFileAsync(
    taskkillCommand,
    ["/PID", String(pid), "/T", "/F"],
    {
      windowsHide: true,
      timeout: Math.max(1, Math.min(1_500, timeoutMs)),
    },
  ).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      confirmedStopped: true,
      reason: "no_owned_processes",
      snapshots,
    };
  }

  const capturedByKey = new Map(owned.map((item) => [identityKey(item), item]));
  const attemptedPids = new Set<number>();
  while (Date.now() < deadline) {
    const currentOwned = selectOwnedWindowsTestProcessTree({
      snapshot,
      rootPid,
      ownerMarkers: input.ownerMarkers,
      previouslyOwned: [...capturedByKey.values()],
    });
    for (const item of currentOwned) {
      capturedByKey.set(identityKey(item), item);
    }
    if (currentOwned.length === 0) {
      return {
        rootPid,
        attempted: attemptedPids.size > 0,
        confirmedStopped: true,
        reason: "reaped",
        capturedPids: [...new Set(
          [...capturedByKey.values()].map((item) => item.pid),
        )].sort((left, right) => left - right),
        attemptedPids: [...attemptedPids].sort((left, right) => left - right),
        remainingPids: [],
        snapshots,
      };
    }

    const root = currentOwned.find((item) => item.pid === rootPid);
    const killCandidates = root ? [root] : currentOwned.slice(0, 1);
    for (const item of killCandidates) {
      if (item.pid === process.pid) continue;
      attemptedPids.add(item.pid);
      await taskkillWindowsTestProcess(
        item.pid,
        Math.max(1, deadline - Date.now()),
      );
    }
    await delay(Math.min(75, Math.max(1, deadline - Date.now())));
    try {
      snapshot = await snapshotWindowsTestProcesses(
        Math.max(250, deadline - Date.now()),
      );
      snapshots += 1;
    } catch {
      break;
    }
  }

  const remaining = selectOwnedWindowsTestProcessTree({
    snapshot,
    rootPid,
    ownerMarkers: input.ownerMarkers,
    previouslyOwned: [...capturedByKey.values()],
  });
  return {
    rootPid,
    attempted: attemptedPids.size > 0,
    confirmedStopped: remaining.length === 0,
    reason: remaining.length === 0 ? "reaped" : "still_running",
    capturedPids: [...new Set(
      [...capturedByKey.values()].map((item) => item.pid),
    )].sort((left, right) => left - right),
    attemptedPids: [...attemptedPids].sort((left, right) => left - right),
    remainingPids: remaining
      .map((item) => item.pid)
      .sort((left, right) => left - right),
    snapshots,
  };
}
