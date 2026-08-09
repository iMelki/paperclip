import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFileAsync = promisify(execFile);
/**
 * The POSIX lineage fallback is a safety check, not a best-effort background
 * probe. Keep its entire ps walk bounded so an unavailable or wedged ps
 * implementation cannot hold runtime adoption indefinitely.
 */
export const UNIX_PROCESS_LINEAGE_TIMEOUT_MS = 2_000;
const taskkillCommand = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
const windowsPowerShellCommand = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const verifiedWindowsRegistryIdentities =
  new WeakSet<LocalServiceRegistryRecord>();

export interface LocalServiceRegistryRecord {
  version: 1;
  serviceKey: string;
  profileKind: string;
  serviceName: string;
  command: string;
  cwd: string;
  envFingerprint: string;
  port: number | null;
  url: string | null;
  pid: number;
  processGroupId: number | null;
  provider: "local_process";
  runtimeServiceId: string | null;
  reuseKey: string | null;
  startedAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown> | null;
}

export interface LocalServiceIdentityInput {
  profileKind: string;
  serviceName: string;
  cwd: string;
  command: string;
  envFingerprint: string;
  port: number | null;
  scope: Record<string, unknown> | null;
}

export type LocalServiceTerminationResult = {
  pid: number | null;
  attempted: boolean;
  confirmedStopped: boolean;
  outcome:
    | "invalid_pid"
    | "self_process"
    | "not_running"
    | "untrusted_identity"
    | "terminated"
    | "still_running";
  error?: string;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeServiceKeySegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function getRuntimeServicesDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
}

function assertSafeServiceKey(serviceKey: string) {
  if (
    serviceKey.length === 0
    || serviceKey.length > 240
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(serviceKey)
    || serviceKey === "."
    || serviceKey === ".."
  ) {
    throw new Error("Invalid local service registry key.");
  }
}

function getRuntimeServiceRegistryPath(serviceKey: string) {
  assertSafeServiceKey(serviceKey);
  const registryDir = getRuntimeServicesDir();
  const candidate = path.resolve(registryDir, `${serviceKey}.json`);
  if (path.dirname(candidate) !== registryDir) {
    throw new Error("Invalid local service registry path.");
  }
  return candidate;
}

export function normalizeLocalServicePid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function normalizeRegistryRecord(
  raw: unknown,
  expectedServiceKey?: string,
): LocalServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const pid = normalizeLocalServicePid(rec.pid);
  if (
    rec.version !== 1 ||
    typeof rec.serviceKey !== "string" ||
    (expectedServiceKey !== undefined && rec.serviceKey !== expectedServiceKey) ||
    typeof rec.profileKind !== "string" ||
    typeof rec.serviceName !== "string" ||
    typeof rec.command !== "string" ||
    typeof rec.cwd !== "string" ||
    typeof rec.envFingerprint !== "string" ||
    pid === null
  ) {
    return null;
  }
  try {
    assertSafeServiceKey(rec.serviceKey);
  } catch {
    return null;
  }

  return {
    version: 1,
    serviceKey: rec.serviceKey,
    profileKind: rec.profileKind,
    serviceName: rec.serviceName,
    command: rec.command,
    cwd: rec.cwd,
    envFingerprint: rec.envFingerprint,
    port: typeof rec.port === "number" ? rec.port : null,
    url: typeof rec.url === "string" ? rec.url : null,
    pid,
    processGroupId: normalizeLocalServicePid(rec.processGroupId),
    provider: "local_process",
    runtimeServiceId: typeof rec.runtimeServiceId === "string" ? rec.runtimeServiceId : null,
    reuseKey: typeof rec.reuseKey === "string" ? rec.reuseKey : null,
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : new Date().toISOString(),
    lastSeenAt: typeof rec.lastSeenAt === "string" ? rec.lastSeenAt : new Date().toISOString(),
    metadata:
      rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
        ? (rec.metadata as Record<string, unknown>)
        : null,
  };
}

async function safeReadRegistryRecord(
  filePath: string,
  expectedServiceKey?: string,
) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeRegistryRecord(raw, expectedServiceKey);
  } catch {
    return null;
  }
}

export function createLocalServiceKey(input: LocalServiceIdentityInput) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        profileKind: input.profileKind,
        serviceName: input.serviceName,
        cwd: path.resolve(input.cwd),
        command: input.command,
        envFingerprint: input.envFingerprint,
        port: input.port,
        scope: input.scope ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  return `${sanitizeServiceKeySegment(input.profileKind, "service")}-${sanitizeServiceKeySegment(input.serviceName, "service")}-${digest}`;
}

export async function writeLocalServiceRegistryRecord(record: LocalServiceRegistryRecord) {
  const registryDir = getRuntimeServicesDir();
  const registryPath = getRuntimeServiceRegistryPath(record.serviceKey);
  const temporaryPath = path.resolve(
    registryDir,
    `.${record.serviceKey}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(registryDir, { recursive: true });
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, registryPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function removeLocalServiceRegistryRecord(serviceKey: string) {
  await fs.rm(getRuntimeServiceRegistryPath(serviceKey), { force: true });
}

export async function readLocalServiceRegistryRecord(serviceKey: string) {
  return await safeReadRegistryRecord(
    getRuntimeServiceRegistryPath(serviceKey),
    serviceKey,
  );
}

export async function listLocalServiceRegistryRecords(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const entries = await fs.readdir(getRuntimeServicesDir(), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const expectedServiceKey = entry.name.slice(0, -".json".length);
          try {
            assertSafeServiceKey(expectedServiceKey);
          } catch {
            return Promise.resolve(null);
          }
          return safeReadRegistryRecord(
            path.resolve(getRuntimeServicesDir(), entry.name),
            expectedServiceKey,
          );
        }),
    );

    return records
      .filter((record): record is LocalServiceRegistryRecord => record !== null)
      .filter((record) => {
        if (filter?.profileKind && record.profileKind !== filter.profileKind) return false;
        if (!filter?.metadata) return true;
        return Object.entries(filter.metadata).every(([key, value]) => record.metadata?.[key] === value);
      })
      .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  } catch {
    return [];
  }
}

export async function findLocalServiceRegistryRecordByRuntimeServiceId(input: {
  runtimeServiceId: string;
  profileKind?: string;
}) {
  const records = await listLocalServiceRegistryRecords(
    input.profileKind ? { profileKind: input.profileKind } : undefined,
  );
  const record = records.find((entry) => entry.runtimeServiceId === input.runtimeServiceId) ?? null;
  if (!record) return null;

  const candidate = await refreshLocalServiceRegistryProcessIdentity(record);
  if (!candidate) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }

  if (!(await isLikelyMatchingCommand(candidate))) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }
  if (!(await doesLocalServiceRecordMatchCwd(candidate))) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }

  return candidate;
}

async function refreshLocalServiceRegistryProcessIdentity(
  record: LocalServiceRegistryRecord,
) {
  if (process.platform === "win32") {
    const ownerPid = record.port
      ? await readLocalServicePortOwner(record.port)
      : null;
    if (!ownerPid) return null;
    const identity = await readWindowsProcessLineageIdentity(
      record.pid,
      ownerPid,
    );
    const wrapperIdentityMatches =
      identity?.ownerDescendsFromTarget === true &&
      doesCommandLineMatch(record.command, identity.targetCommandLine);
    const ownerIdentityMatches = doesCommandLineMatch(
      record.command,
      identity?.ownerCommandLine ?? null,
    );
    if (!wrapperIdentityMatches && !ownerIdentityMatches) return null;
    const verifiedPid = wrapperIdentityMatches ? record.pid : ownerPid;
    const candidate: LocalServiceRegistryRecord = {
      ...record,
      pid: verifiedPid,
      processGroupId: verifiedPid,
      lastSeenAt: new Date().toISOString(),
    };
    verifiedWindowsRegistryIdentities.add(candidate);
    await writeLocalServiceRegistryRecord(candidate);
    return candidate;
  }

  if (isPidAlive(record.pid)) return record;
  const ownerPid = record.port
    ? await readLocalServicePortOwner(record.port)
    : null;
  if (!ownerPid) return null;
  const candidate: LocalServiceRegistryRecord = {
    ...record,
    pid: ownerPid,
    processGroupId: await readLocalServiceProcessGroupId(ownerPid),
    lastSeenAt: new Date().toISOString(),
  };
  await writeLocalServiceRegistryRecord(candidate);
  return candidate;
}

async function readWindowsProcessLineageIdentity(
  targetPid: number,
  ownerPid: number,
): Promise<{
  targetCommandLine: string | null;
  ownerCommandLine: string | null;
  ownerDescendsFromTarget: boolean;
} | null> {
  const normalizedTargetPid = normalizeLocalServicePid(targetPid);
  const normalizedOwnerPid = normalizeLocalServicePid(ownerPid);
  if (
    process.platform !== "win32" ||
    normalizedTargetPid === null ||
    normalizedOwnerPid === null
  ) {
    return null;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$processesById = @{}",
    "foreach ($item in @(Get-CimInstance Win32_Process)) {",
    "  $processesById[[int]$item.ProcessId] = $item",
    "}",
    `$target = $processesById[${normalizedTargetPid}]`,
    `$owner = $processesById[${normalizedOwnerPid}]`,
    "$current = $owner",
    "$descends = $false",
    "$lineageValid = $true",
    "for ($depth = 0; $depth -lt 64 -and $current; $depth++) {",
    `  if ($current.ProcessId -eq ${normalizedTargetPid}) { $descends = $true; break }`,
    "  if ($current.ParentProcessId -le 0 -or $current.ParentProcessId -eq $current.ProcessId) { break }",
    "  $parent = $processesById[[int]$current.ParentProcessId]",
    "  if (-not $parent) { break }",
    "  if ($parent.CreationDate -gt $current.CreationDate) {",
    "    $lineageValid = $false",
    "    break",
    "  }",
    "  $current = $parent",
    "}",
    "[pscustomobject]@{",
    "  TargetCommandLine = if ($target) { $target.CommandLine } else { $null }",
    "  OwnerCommandLine = if ($owner) { $owner.CommandLine } else { $null }",
    "  OwnerDescendsFromTarget = [bool]($descends -and $lineageValid)",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(windowsPowerShellCommand, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      targetCommandLine:
        typeof parsed.TargetCommandLine === "string"
          ? parsed.TargetCommandLine
          : null,
      ownerCommandLine:
        typeof parsed.OwnerCommandLine === "string"
          ? parsed.OwnerCommandLine
          : null,
      ownerDescendsFromTarget:
        parsed.OwnerDescendsFromTarget === true,
    };
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateWindowsProcessTree(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: "invalid_pid" };
  }
  try {
    await execFileAsync(taskkillCommand, ["/pid", String(pid), "/t", "/f"]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function matchesWindowsProcessCreationIdentity(
  pid: number,
  expectedStartedAt: Date | string,
) {
  if (process.platform !== "win32") return false;
  const expected = expectedStartedAt instanceof Date
    ? expectedStartedAt
    : new Date(expectedStartedAt);
  if (Number.isNaN(expected.getTime())) return false;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if (-not $item) { exit 3 }",
    "[Console]::Out.Write($item.CreationDate.ToUniversalTime().ToString('o'))",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(windowsPowerShellCommand, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const actual = new Date(stdout.trim());
    if (Number.isNaN(actual.getTime())) return false;
    return Math.abs(actual.getTime() - expected.getTime()) <= 60_000;
  } catch {
    return false;
  }
}

async function isLikelyMatchingCommand(record: LocalServiceRegistryRecord) {
  if (
    process.platform === "win32" &&
    verifiedWindowsRegistryIdentities.has(record)
  ) {
    return true;
  }
  try {
    const commandLine =
      process.platform === "win32"
        ? (
            await execFileAsync(windowsPowerShellCommand, [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}'; if ($process) { [Console]::Out.Write($process.CommandLine) }`,
            ])
          ).stdout.trim()
        : (
            await execFileAsync("ps", [
              "-o",
              "command=",
              "-p",
              String(record.pid),
            ])
          ).stdout.trim();
    if (doesCommandLineMatch(record.command, commandLine)) return true;
    const ownerPid = record.port ? await readLocalServicePortOwner(record.port) : null;
    return ownerPid !== null && await doesUnixProcessLineageMatch(ownerPid, record.command);
  } catch {
    return false;
  }
}

function doesCommandLineMatch(
  recordedCommand: string,
  actualCommandLine: string | null,
) {
  if (!actualCommandLine) return false;
  const normalize = (value: string) =>
    value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  const normalizedCommandLine = normalize(actualCommandLine);
  const normalizedRecordedCommand = normalize(recordedCommand);
  if (!normalizedRecordedCommand) return false;
  if (normalizedCommandLine.includes(normalizedRecordedCommand)) return true;

  const firstArgumentSeparator = normalizedRecordedCommand.indexOf(" ");
  if (firstArgumentSeparator <= 0) return false;
  const recordedExecutable = path
    .basename(normalizedRecordedCommand.slice(0, firstArgumentSeparator))
    .replace(/\.exe$/i, "");
  const recordedArguments = normalizedRecordedCommand
    .slice(firstArgumentSeparator + 1)
    .trim();
  if (!recordedExecutable || !recordedArguments) return false;
  const normalizedLower = normalizedCommandLine.toLowerCase();
  const argumentTailLower = recordedArguments.toLowerCase();
  const executableLower = recordedExecutable.toLowerCase();
  return ["", ".exe", ".cjs", ".js"].some((suffix) =>
    normalizedLower.includes(`${executableLower}${suffix} ${argumentTailLower}`),
  );
}

export async function doesUnixProcessLineageMatch(ownerPid: number, recordedCommand: string) {
  if (process.platform === "win32") return false;
  const visited = new Set<number>();
  const deadline = Date.now() + UNIX_PROCESS_LINEAGE_TIMEOUT_MS;
  let pid: number | null = normalizeLocalServicePid(ownerPid);
  for (let depth = 0; pid !== null && depth < 16 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    try {
      const [{ stdout: commandLine }, { stdout: parentPidText }] = await Promise.all([
        execFileAsync("ps", ["-o", "command=", "-p", String(pid)], {
          timeout: remainingMs,
          killSignal: "SIGTERM",
        }),
        execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], {
          timeout: remainingMs,
          killSignal: "SIGTERM",
        }),
      ]);
      if (doesCommandLineMatch(recordedCommand, commandLine.trim())) return true;
      const parentPid = normalizeLocalServicePid(parentPidText.trim());
      pid = parentPid !== null && parentPid !== pid && parentPid > 1 ? parentPid : null;
    } catch {
      return false;
    }
  }
  return false;
}

export async function findAdoptableLocalService(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
  expectedPid?: number | null;
  expectedStartedAt?: Date | string | null;
}) {
  const existing = await readLocalServiceRegistryRecord(input.serviceKey);
  const record = existing
    ? await refreshLocalServiceRegistryProcessIdentity(existing)
    : await adoptLocalServiceFromPortOwner(input);
  if (!record) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (!(await isLikelyMatchingCommand(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (!(await doesLocalServiceRecordMatchCwd(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (input.command && record.command !== input.command) return null;
  if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
  if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
  if (input.port !== undefined && input.port !== null && record.port !== input.port) return null;
  return record;
}

async function readProcessGroupId(pid: number) {
  return readLocalServiceProcessGroupId(pid);
}

async function adoptLocalServiceFromPortOwner(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
  expectedPid?: number | null;
  expectedStartedAt?: Date | string | null;
}) {
  if (!input.port) return null;
  const ownerPid = await readLocalServicePortOwner(input.port);
  if (!ownerPid) return null;

  let verifiedWindowsPid: number | null = null;
  if (process.platform === "win32") {
    const expectedPid = normalizeLocalServicePid(input.expectedPid);
    if (expectedPid === null || !input.expectedStartedAt) return null;
    if (!(await matchesWindowsProcessCreationIdentity(expectedPid, input.expectedStartedAt))) {
      return null;
    }
    const identity = await readWindowsProcessLineageIdentity(expectedPid, ownerPid);
    if (
      !identity
      || (ownerPid !== expectedPid && !identity.ownerDescendsFromTarget)
      || (
        input.command
        && !doesCommandLineMatch(input.command, identity.targetCommandLine)
        && !doesCommandLineMatch(input.command, identity.ownerCommandLine)
      )
    ) {
      return null;
    }
    verifiedWindowsPid = expectedPid;
  } else if (input.cwd) {
    const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
    if (!ownerCwd || !(await isLocalServiceProcessInWorkspace(ownerCwd, input.cwd))) {
      return null;
    }
  }

  const processGroupId = await readProcessGroupId(ownerPid);
  const pid = verifiedWindowsPid
    ?? (processGroupId && isPidAlive(processGroupId) ? processGroupId : ownerPid);
  const now = new Date().toISOString();
  const record: LocalServiceRegistryRecord = {
    version: 1,
    serviceKey: input.serviceKey,
    profileKind: input.profileKind ?? "workspace-runtime",
    serviceName: input.serviceName ?? "service",
    command: input.command ?? input.serviceName ?? "service",
    cwd: input.cwd ?? process.cwd(),
    envFingerprint: input.envFingerprint ?? "",
    port: input.port,
    url: input.url ?? null,
    pid,
    processGroupId: processGroupId ?? pid,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: input.envFingerprint ?? null,
    startedAt: now,
    lastSeenAt: now,
    metadata: null,
  };

  if (verifiedWindowsPid !== null) {
    verifiedWindowsRegistryIdentities.add(record);
  }
  if (!(await isLikelyMatchingCommand(record))) return null;
  await writeLocalServiceRegistryRecord(record);
  return record;
}

export async function touchLocalServiceRegistryRecord(
  serviceKey: string,
  patch?: Partial<Omit<LocalServiceRegistryRecord, "serviceKey" | "version">>,
) {
  const existing = await readLocalServiceRegistryRecord(serviceKey);
  if (!existing) return null;
  const next: LocalServiceRegistryRecord = {
    ...existing,
    ...patch,
    version: 1,
    serviceKey,
    lastSeenAt: patch?.lastSeenAt ?? new Date().toISOString(),
  };
  await writeLocalServiceRegistryRecord(next);
  return next;
}

export async function terminateLocalService(
  record: Pick<LocalServiceRegistryRecord, "pid" | "processGroupId">,
  opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    trustedPid?: boolean;
    trustedProcessGroup?: boolean;
    expectedStartedAt?: Date | string | null;
  },
): Promise<LocalServiceTerminationResult> {
  const pid = normalizeLocalServicePid(record.pid);
  if (pid === null) {
    return {
      pid: null,
      attempted: false,
      confirmedStopped: false,
      outcome: "invalid_pid",
    };
  }
  if (pid === process.pid) {
    return {
      pid,
      attempted: false,
      confirmedStopped: false,
      outcome: "self_process",
    };
  }
  const recordedProcessGroupId = normalizeLocalServicePid(record.processGroupId);

  if (process.platform === "win32") {
    if (!isPidAlive(pid)) {
      return {
        pid,
        attempted: false,
        confirmedStopped: true,
        outcome: "not_running",
      };
    }
    const trustedIdentity = opts?.trustedPid === true
      || (
        opts?.expectedStartedAt !== undefined
        && opts.expectedStartedAt !== null
        && await matchesWindowsProcessCreationIdentity(pid, opts.expectedStartedAt)
      );
    if (!trustedIdentity) {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
      };
    }
    const firstAttempt = await terminateWindowsProcessTree(pid);
    const deadline = Date.now() + (opts?.forceAfterMs ?? 2_000);
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) {
        return {
          pid,
          attempted: true,
          confirmedStopped: true,
          outcome: "terminated",
        };
      }
      await delay(100);
    }
    const secondAttempt = await terminateWindowsProcessTree(pid);
    const forceDeadline = Date.now() + Math.min(opts?.forceAfterMs ?? 2_000, 2_000);
    while (Date.now() < forceDeadline) {
      if (!isPidAlive(pid)) {
        return {
          pid,
          attempted: true,
          confirmedStopped: true,
          outcome: "terminated",
        };
      }
      await delay(100);
    }
    return {
      pid,
      attempted: true,
      confirmedStopped: false,
      outcome: "still_running",
      ...(!secondAttempt.ok || !firstAttempt.ok
        ? { error: secondAttempt.error ?? firstAttempt.error }
        : {}),
    };
  }

  const pidAlive = isPidAlive(pid);
  if (!pidAlive && !isProcessGroupAlive(recordedProcessGroupId)) {
    return {
      pid,
      attempted: false,
      confirmedStopped: true,
      outcome: "not_running",
    };
  }
  let processGroupId: number | null = null;
  if (recordedProcessGroupId !== null) {
    const [actualProcessGroupId, ownProcessGroupId] = await Promise.all([
      readLocalServiceProcessGroupId(pid),
      readLocalServiceProcessGroupId(process.pid),
    ]);
    if (
      ownProcessGroupId !== null &&
      recordedProcessGroupId === actualProcessGroupId &&
      recordedProcessGroupId !== ownProcessGroupId
    ) {
      processGroupId = recordedProcessGroupId;
    }
    // Descendant-only reaping is allowed only with an explicit process-group
    // assertion plus the run's persisted start identity. A bare historical
    // PGID remains fail-closed.
    if (
      processGroupId === null
      && opts?.trustedProcessGroup === true
      && !pidAlive
      && opts.expectedStartedAt !== undefined
      && opts.expectedStartedAt !== null
    ) {
      const ownProcessGroupId = await readLocalServiceProcessGroupId(process.pid);
      if (ownProcessGroupId === null || recordedProcessGroupId !== ownProcessGroupId) {
        processGroupId = recordedProcessGroupId;
      }
    }
  }

  const signal = opts?.signal ?? "SIGTERM";
  const canTargetPid = opts?.trustedPid === true;
  if (processGroupId === null && !canTargetPid) {
    return {
      pid,
      attempted: false,
      confirmedStopped: false,
      outcome: "untrusted_identity",
    };
  }
  let targetProcessGroup = processGroupId !== null;
  try {
    if (targetProcessGroup) {
      process.kill(-processGroupId!, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    if (!targetProcessGroup || !canTargetPid) {
      return {
        pid,
        attempted: true,
        confirmedStopped: false,
        outcome: "still_running",
      };
    }
    targetProcessGroup = false;
    try {
      process.kill(pid, signal);
    } catch {
      const stopped = !isPidAlive(pid);
      return {
        pid,
        attempted: true,
        confirmedStopped: stopped,
        outcome: stopped ? "terminated" : "still_running",
      };
    }
  }

  const deadline = Date.now() + (opts?.forceAfterMs ?? 2_000);
  while (Date.now() < deadline) {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(processGroupId)
      : isPidAlive(pid);
    if (!targetAlive) {
      return {
        pid,
        attempted: true,
        confirmedStopped: true,
        outcome: "terminated",
      };
    }
    await delay(100);
  }

  const stillAlive = targetProcessGroup
    ? isProcessGroupAlive(processGroupId)
    : isPidAlive(pid);
  if (!stillAlive) {
    return {
      pid,
      attempted: true,
      confirmedStopped: true,
      outcome: "terminated",
    };
  }
  try {
    if (targetProcessGroup) {
      process.kill(-processGroupId!, "SIGKILL");
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Ignore cleanup races.
  }
  const killDeadline = Date.now() + Math.min(opts?.forceAfterMs ?? 2_000, 2_000);
  while (Date.now() < killDeadline) {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(processGroupId)
      : isPidAlive(pid);
    if (!targetAlive) {
      return {
        pid,
        attempted: true,
        confirmedStopped: true,
        outcome: "terminated",
      };
    }
    await delay(100);
  }
  return {
    pid,
    attempted: true,
    confirmedStopped: false,
    outcome: "still_running",
  };
}

export async function readLocalServicePortOwner(port: number) {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (process.platform === "win32") {
    try {
      const netstatCommand = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "netstat.exe",
      );
      const { stdout } = await execFileAsync(netstatCommand, ["-ano", "-p", "TCP"]);
      for (const rawLine of stdout.split(/\r?\n/)) {
        const columns = rawLine.trim().split(/\s+/);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
        const localAddress = columns[1] ?? "";
        const state = columns[3]?.toUpperCase();
        if (state !== "LISTENING" || !localAddress.endsWith(`:${port}`)) continue;
        const pid = Number.parseInt(columns[4] ?? "", 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const firstPid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value > 0);
    return firstPid ?? null;
  } catch {
    return null;
  }
}

export async function readLocalServiceProcessCwd(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "linux") return null;
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

export async function readLocalServiceProcessGroupId(pid: number) {
  const normalizedPid = normalizeLocalServicePid(pid);
  if (normalizedPid === null || process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(normalizedPid)]);
    return normalizeLocalServicePid(stdout.trim());
  } catch {
    return null;
  }
}

export async function isLocalServiceProcessInWorkspace(processCwd: string, workspaceCwd: string) {
  try {
    const [resolvedProcessCwd, resolvedWorkspaceCwd] = await Promise.all([
      fs.realpath(processCwd),
      fs.realpath(workspaceCwd),
    ]);
    const relativePath = path.relative(resolvedWorkspaceCwd, resolvedProcessCwd);
    return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
  } catch {
    return false;
  }
}

export async function isLocalServiceRegistryCwdCompatible(processCwd: string | null, workspaceCwd: string) {
  if (!processCwd) return process.platform !== "linux";
  return isLocalServiceProcessInWorkspace(processCwd, workspaceCwd);
}

async function doesLocalServiceRecordMatchCwd(record: LocalServiceRegistryRecord) {
  if (!record.port) return true;
  const ownerPid = await readLocalServicePortOwner(record.port);
  if (!ownerPid) return false;
  const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
  return isLocalServiceRegistryCwdCompatible(ownerCwd, record.cwd);
}
