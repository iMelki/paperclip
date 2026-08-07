import { execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  captureWindowsProcessTreeReceipt,
  observeWindowsProcessTreeReceipt,
  type WindowsProcessTreeReceipt,
} from "./windows-process-tree.js";

const execFileAsync = promisify(execFile);
const windowsPowerShellCommand = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const verifiedWindowsRegistryIdentities =
  new WeakSet<LocalServiceRegistryRecord>();
const MAX_SIGNALABLE_PROCESS_ID = 0x7fffffff;
const MAX_LOCAL_SERVICE_EVIDENCE_BYTES = 64 * 1024;
const REGISTRY_FILE_SUFFIX = ".json";
const LAUNCH_CLAIM_FILE_SUFFIX = `${REGISTRY_FILE_SUFFIX}.launch-claim`;
const RELEASED_LAUNCH_CLAIM_MARKER = `${LAUNCH_CLAIM_FILE_SUFFIX}.released-`;
const RETAINED_MUTATION_SUFFIXES = [".tmp", ".previous", ".remove"] as const;
const UNSUPPORTED_POSIX_DIRECTORY_FSYNC_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
]);

type LocalServiceRegistryInvalidReason =
  | "malformed_json"
  | "invalid_schema"
  | "unreadable"
  | "unsafe_entry_type"
  | "file_too_large"
  | "path_identity_changed"
  | "untrusted_registry_directory"
  | "retained_launch_claim"
  | "retained_mutation_evidence";

export interface LocalServiceLaunchClaimEvidence {
  version: 1;
  serviceKey: string;
  purpose: "generation_launch" | "registry_mutation_guard";
  ownerPid: number;
  createdAt: string;
  nonce: string;
  expectedGenerationId: string | null;
  spawnJournalState: "not_recorded_or_write_failed" | "recorded" | "partial_or_corrupt";
  spawn: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  } | null;
}

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

export interface LocalServiceRegistryDirectoryIdentity {
  realPath: string;
  dev: string;
  ino: string;
}

export type LocalServiceRegistryWriteExpectation =
  | { state: "absent"; launchClaimNonce?: string }
  | { state: "matches"; record: LocalServiceRegistryRecord; launchClaimNonce?: string };

export type LocalServiceRegistryInspection = (
  | {
      state: "absent";
      filePath: string;
      record: null;
      reason: null;
    }
  | {
      state: "invalid";
      filePath: string;
      record: null;
      reason: LocalServiceRegistryInvalidReason;
      entryKind?: "registry" | "launch_claim" | "mutation_evidence" | "registry_directory";
      launchClaim?: LocalServiceLaunchClaimEvidence | null;
    }
  | {
      state: "valid";
      filePath: string;
      record: LocalServiceRegistryRecord;
      reason: null;
      fileIdentity: FileIdentity;
      contentSha256: string;
    }
) & {
  directoryIdentity?: LocalServiceRegistryDirectoryIdentity;
};

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
  processTreeReceipt?: WindowsProcessTreeReceipt;
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

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

type TrustedRegistryDirectory = {
  logicalPath: string;
  realPath: string;
  identity: FileIdentity;
};

type RegistryDirectoryInspection =
  | { state: "absent"; logicalPath: string }
  | { state: "invalid"; logicalPath: string }
  | { state: "valid"; trust: TrustedRegistryDirectory };

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function projectRegistryDirectoryIdentity(
  trust: TrustedRegistryDirectory,
): LocalServiceRegistryDirectoryIdentity {
  return {
    realPath: trust.realPath,
    dev: trust.identity.dev.toString(),
    ino: trust.identity.ino.toString(),
  };
}

async function inspectRuntimeServicesDirectory(): Promise<RegistryDirectoryInspection> {
  const logicalPath = getRuntimeServicesDir();
  let logicalStat: BigIntStats;
  try {
    logicalStat = await fs.lstat(logicalPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent", logicalPath };
    return { state: "invalid", logicalPath };
  }
  if (logicalStat.isSymbolicLink() || !logicalStat.isDirectory()) {
    return { state: "invalid", logicalPath };
  }

  try {
    const realPath = await fs.realpath(logicalPath);
    const realStat = await fs.lstat(realPath, { bigint: true });
    if (
      realStat.isSymbolicLink()
      || !realStat.isDirectory()
      || !sameFileIdentity(logicalStat, realStat)
      || !sameResolvedPath(logicalPath, realPath)
    ) {
      return { state: "invalid", logicalPath };
    }
    return {
      state: "valid",
      trust: {
        logicalPath,
        realPath,
        identity: { dev: realStat.dev, ino: realStat.ino },
      },
    };
  } catch {
    return { state: "invalid", logicalPath };
  }
}

async function ensureTrustedRuntimeServicesDirectory() {
  let inspection = await inspectRuntimeServicesDirectory();
  if (inspection.state === "invalid") {
    throw new Error(
      "Local service registry directory is not a trusted regular directory; no registry mutation was attempted.",
    );
  }
  if (inspection.state === "absent") {
    await fs.mkdir(inspection.logicalPath, { recursive: true });
    inspection = await inspectRuntimeServicesDirectory();
  }
  if (inspection.state !== "valid") {
    throw new Error(
      "Local service registry directory could not be pinned after creation; no registry mutation was attempted.",
    );
  }
  if (!(await isTrustedRegistryDirectoryCurrent(inspection.trust))) {
    throw new Error(
      "Local service registry directory identity changed before mutation; no registry mutation was attempted.",
    );
  }
  return inspection.trust;
}

function getTrustedRuntimeServiceRegistryPath(
  trust: TrustedRegistryDirectory,
  serviceKey: string,
) {
  assertSafeServiceKey(serviceKey);
  const candidate = path.resolve(trust.realPath, `${serviceKey}${REGISTRY_FILE_SUFFIX}`);
  if (!sameResolvedPath(path.dirname(candidate), trust.realPath)) {
    throw new Error("Invalid local service registry path.");
  }
  return candidate;
}

async function isTrustedRegistryDirectoryCurrent(trust: TrustedRegistryDirectory) {
  try {
    const [logicalStat, realStat, currentRealPath] = await Promise.all([
      fs.lstat(trust.logicalPath, { bigint: true }),
      fs.lstat(trust.realPath, { bigint: true }),
      fs.realpath(trust.logicalPath),
    ]);
    return !logicalStat.isSymbolicLink()
      && logicalStat.isDirectory()
      && !realStat.isSymbolicLink()
      && realStat.isDirectory()
      && sameFileIdentity(logicalStat, trust.identity)
      && sameFileIdentity(realStat, trust.identity)
      && sameResolvedPath(currentRealPath, trust.realPath);
  } catch {
    return false;
  }
}

async function syncTrustedRegistryDirectory(
  trust: TrustedRegistryDirectory,
  namespaceTransition: string,
) {
  if (process.platform === "win32") {
    // Node does not expose the Windows directory-handle flags needed for a
    // portable FlushFileBuffers contract. Windows keeps the no-replace,
    // identity, and exact-byte checks below, but does not claim parent-
    // directory durability across sudden power loss.
    return;
  }
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
    throw new Error(
      `Local service registry directory identity changed before parent-directory fsync after ${namespaceTransition}.`,
    );
  }

  const directoryFlags = fsConstants.O_RDONLY
    | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(trust.realPath, directoryFlags);
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isDirectory()
      || !sameFileIdentity(openedStat, trust.identity)
      || !(await isTrustedRegistryDirectoryCurrent(trust))
    ) {
      throw new Error(
        `Local service registry directory identity changed during parent-directory fsync after ${namespaceTransition}.`,
      );
    }
    try {
      await handle.sync();
    } catch (error) {
      const code = String(errorCode(error) ?? "unknown");
      // These codes explicitly report that this kernel/filesystem cannot fsync
      // a directory. Atomic namespace and evidence checks still apply, but
      // sudden-power-loss durability cannot be asserted for that filesystem.
      if (!UNSUPPORTED_POSIX_DIRECTORY_FSYNC_CODES.has(code)) {
        throw new Error(
          `Local service registry parent-directory fsync failed after ${namespaceTransition} (${code}).`,
        );
      }
    }
  } finally {
    await handle?.close();
  }
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
    throw new Error(
      `Local service registry directory identity changed after parent-directory fsync for ${namespaceTransition}.`,
    );
  }
}

type BoundedEvidenceRead =
  | { state: "absent" }
  | { state: "invalid"; reason: LocalServiceRegistryInvalidReason }
  | {
      state: "valid";
      contents: string;
      fileIdentity: FileIdentity;
      contentSha256: string;
    };

async function readBoundedTrustedEvidenceFile(input: {
  trust: TrustedRegistryDirectory;
  fileName: string;
  expectedPresent: boolean;
}): Promise<BoundedEvidenceRead> {
  const filePath = path.resolve(input.trust.realPath, input.fileName);
  if (path.dirname(filePath) !== input.trust.realPath) {
    return { state: "invalid", reason: "path_identity_changed" };
  }
  if (!(await isTrustedRegistryDirectoryCurrent(input.trust))) {
    return { state: "invalid", reason: "untrusted_registry_directory" };
  }

  let beforeStat: BigIntStats;
  try {
    beforeStat = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return input.expectedPresent
        ? { state: "invalid", reason: "path_identity_changed" }
        : { state: "absent" };
    }
    return { state: "invalid", reason: "unreadable" };
  }
  if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) {
    return { state: "invalid", reason: "unsafe_entry_type" };
  }
  if (beforeStat.size > BigInt(MAX_LOCAL_SERVICE_EVIDENCE_BYTES)) {
    return { state: "invalid", reason: "file_too_large" };
  }

  let flags = fsConstants.O_RDONLY;
  if (process.platform !== "win32") {
    if (
      typeof fsConstants.O_NOFOLLOW !== "number"
      || typeof fsConstants.O_NONBLOCK !== "number"
    ) {
      return { state: "invalid", reason: "unsafe_entry_type" };
    }
    // O_NOFOLLOW closes the final-component symlink race; O_NONBLOCK prevents
    // a regular-file-to-FIFO swap from blocking before fstat can reject it.
    flags |= fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    try {
      handle = await fs.open(filePath, flags);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return input.expectedPresent
          ? { state: "invalid", reason: "path_identity_changed" }
          : { state: "absent" };
      }
      if (errorCode(error) === "ELOOP" || errorCode(error) === "ENXIO") {
        return { state: "invalid", reason: "unsafe_entry_type" };
      }
      return { state: "invalid", reason: "unreadable" };
    }

    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile()
      || !sameFileIdentity(beforeStat, openedStat)
    ) {
      return { state: "invalid", reason: "path_identity_changed" };
    }
    if (openedStat.size > BigInt(MAX_LOCAL_SERVICE_EVIDENCE_BYTES)) {
      return { state: "invalid", reason: "file_too_large" };
    }

    let currentPathStat: BigIntStats;
    let currentRealPath: string;
    try {
      [currentPathStat, currentRealPath] = await Promise.all([
        fs.lstat(filePath, { bigint: true }),
        fs.realpath(filePath),
      ]);
    } catch {
      return { state: "invalid", reason: "path_identity_changed" };
    }
    if (
      currentPathStat.isSymbolicLink()
      || !currentPathStat.isFile()
      || !sameFileIdentity(currentPathStat, openedStat)
      || !sameResolvedPath(currentRealPath, filePath)
      || !sameResolvedPath(path.dirname(currentRealPath), input.trust.realPath)
      || !(await isTrustedRegistryDirectoryCurrent(input.trust))
    ) {
      return { state: "invalid", reason: "path_identity_changed" };
    }

    const buffer = Buffer.allocUnsafe(MAX_LOCAL_SERVICE_EVIDENCE_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_LOCAL_SERVICE_EVIDENCE_BYTES) {
      return { state: "invalid", reason: "file_too_large" };
    }

    const afterStat = await handle.stat({ bigint: true });
    let afterPathStat: BigIntStats;
    try {
      afterPathStat = await fs.lstat(filePath, { bigint: true });
    } catch {
      return { state: "invalid", reason: "path_identity_changed" };
    }
    if (
      !afterStat.isFile()
      || afterPathStat.isSymbolicLink()
      || !afterPathStat.isFile()
      || afterStat.size > BigInt(MAX_LOCAL_SERVICE_EVIDENCE_BYTES)
      || !sameFileIdentity(openedStat, afterStat)
      || !sameFileIdentity(openedStat, afterPathStat)
      || !(await isTrustedRegistryDirectoryCurrent(input.trust))
    ) {
      return { state: "invalid", reason: "path_identity_changed" };
    }
    const contents = buffer.subarray(0, totalBytes);
    return {
      state: "valid",
      contents: contents.toString("utf8"),
      fileIdentity: { dev: openedStat.dev, ino: openedStat.ino },
      contentSha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch {
    return { state: "invalid", reason: "unreadable" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertSafeServiceKey(serviceKey: string) {
  if (
    serviceKey.length === 0
    || serviceKey.length > 240
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(serviceKey)
    || serviceKey !== serviceKey.toLowerCase()
    || serviceKey === "."
    || serviceKey === ".."
  ) {
    throw new Error("Invalid local service registry key.");
  }
}

function retainedMutationEvidenceServiceKey(fileName: string): string | null {
  const lowerFileName = fileName.toLowerCase();
  const matchedSuffix = RETAINED_MUTATION_SUFFIXES.find((suffix) => lowerFileName.endsWith(suffix));
  if (!matchedSuffix || !fileName.startsWith(".")) return null;
  const stem = fileName.slice(1, -matchedSuffix.length);
  const match = /^(.*)\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem);
  if (!match) return null;
  // Canonicalize evidence names before comparison so NTFS case aliases cannot
  // hide a retained file from a lowercase service-key retry. Applying the same
  // conservative rule on POSIX avoids platform-dependent custody decisions.
  const serviceKey = (match[1] ?? "").toLowerCase();
  try {
    assertSafeServiceKey(serviceKey);
    return serviceKey;
  } catch {
    return null;
  }
}

async function findRetainedMutationEvidence(
  serviceKey: string,
): Promise<{ filePath: string } | null> {
  const directoryInspection = await inspectRuntimeServicesDirectory();
  if (directoryInspection.state !== "valid") return null;
  const { trust } = directoryInspection;
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const entries = await fs.readdir(trust.realPath, { withFileTypes: true });
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const retained = entries
    .map((entry) => entry.name)
    .filter((name) => retainedMutationEvidenceServiceKey(name) === serviceKey)
    .sort((left, right) => left.localeCompare(right));
  return retained[0]
    ? { filePath: path.resolve(trust.realPath, retained[0]) }
    : null;
}

function releasedLaunchClaimServiceKey(fileName: string): string | null {
  const markerIndex = fileName.toLowerCase().lastIndexOf(RELEASED_LAUNCH_CLAIM_MARKER);
  if (markerIndex <= 0) return null;
  const canonicalServiceKey = fileName.slice(0, markerIndex).toLowerCase();
  try {
    assertSafeServiceKey(canonicalServiceKey);
    return canonicalServiceKey;
  } catch {
    return null;
  }
}

async function findRetainedReleasedLaunchClaim(
  serviceKey: string,
): Promise<LocalServiceRegistryInspection | null> {
  const directoryInspection = await inspectRuntimeServicesDirectory();
  if (directoryInspection.state !== "valid") return null;
  const { trust } = directoryInspection;
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const entries = await fs.readdir(trust.realPath, { withFileTypes: true });
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const expectedPrefix = `${serviceKey}${RELEASED_LAUNCH_CLAIM_MARKER}`.toLowerCase();
  const retainedName = entries
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().startsWith(expectedPrefix))
    .sort((left, right) => left.localeCompare(right))[0];
  if (!retainedName) return null;
  return await inspectLaunchClaimFile({
    trust,
    fileName: retainedName,
    expectedServiceKey: serviceKey,
  });
}

async function findActiveLaunchClaim(
  serviceKey: string,
): Promise<LocalServiceRegistryInspection | null> {
  const directoryInspection = await inspectRuntimeServicesDirectory();
  if (directoryInspection.state !== "valid") return null;
  const { trust } = directoryInspection;
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const expectedName = `${serviceKey}${LAUNCH_CLAIM_FILE_SUFFIX}`.toLowerCase();
  const entries = await fs.readdir(trust.realPath, { withFileTypes: true });
  if (!(await isTrustedRegistryDirectoryCurrent(trust))) return null;
  const activeName = entries
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase() === expectedName)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!activeName) return null;
  return await inspectLaunchClaimFile({
    trust,
    fileName: activeName,
    expectedServiceKey: serviceKey,
  });
}

async function assertRegistryMutationClaimBoundary(
  serviceKey: string,
  launchClaimNonce?: string,
): Promise<void> {
  const retainedRelease = await findRetainedReleasedLaunchClaim(serviceKey);
  if (retainedRelease) {
    throw new Error(
      `Retained local service launch-claim evidence requires human review at ${retainedRelease.filePath}.`,
    );
  }
  const activeClaim = await findActiveLaunchClaim(serviceKey);
  if (!activeClaim) {
    if (launchClaimNonce) {
      throw new Error(
        "Local service registry claim-authorized mutation lost its exact active launch claim.",
      );
    }
    return;
  }
  if (
    !launchClaimNonce
    || activeClaim.state !== "invalid"
    || activeClaim.entryKind !== "launch_claim"
    || activeClaim.launchClaim?.nonce !== launchClaimNonce
  ) {
    throw new Error(
      `Active local service launch-claim evidence requires matching claim coordination identity at ${activeClaim.filePath}.`,
    );
  }
}

type LocalServiceRegistryMutationGuard = {
  nonce: string;
  release: () => Promise<void>;
};

async function releaseLocalServiceRegistryMutationGuardWithRetry(
  guard: LocalServiceRegistryMutationGuard,
): Promise<void> {
  try {
    await guard.release();
  } catch (firstError) {
    try {
      await guard.release();
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "Local service registry mutation guard release failed twice; exact evidence was retained.",
      );
    }
  }
}

async function acquireLocalServiceRegistryMutationGuard(
  trust: TrustedRegistryDirectory,
  serviceKey: string,
): Promise<LocalServiceRegistryMutationGuard> {
  const registryPath = getTrustedRuntimeServiceRegistryPath(trust, serviceKey);
  const claimPath = `${registryPath}.launch-claim`;
  const nonce = randomUUID();
  const payload = Buffer.from(`${JSON.stringify({
    version: 1,
    serviceKey,
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    nonce,
    expectedGenerationId: null,
    spawn: null,
    purpose: "registry_mutation_guard",
  })}\n`, "utf8");
  const contentSha256 = createHash("sha256").update(payload).digest("hex");
  let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  if (process.platform !== "win32") {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new Error("Local service registry mutation guard requires O_NOFOLLOW support.");
    }
    flags |= fsConstants.O_NOFOLLOW;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let identity: FileIdentity | null = null;
  try {
    handle = await fs.open(claimPath, flags, 0o600);
    const [opened, named] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(claimPath, { bigint: true }),
    ]);
    if (
      !opened.isFile()
      || named.isSymbolicLink()
      || !named.isFile()
      || !sameFileIdentity(opened, named)
      || !(await isTrustedRegistryDirectoryCurrent(trust))
    ) {
      throw new Error(
        "Local service registry mutation guard identity is untrusted; evidence was retained.",
      );
    }
    identity = { dev: opened.dev, ino: opened.ino };
    let offset = 0;
    while (offset < payload.length) {
      const { bytesWritten } = await handle.write(
        payload,
        offset,
        payload.length - offset,
        offset,
      );
      if (bytesWritten <= 0) {
        throw new Error("Local service registry mutation guard write made no progress.");
      }
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    const readback = await readBoundedTrustedEvidenceFile({
      trust,
      fileName: path.basename(claimPath),
      expectedPresent: true,
    });
    if (
      readback.state !== "valid"
      || !sameFileIdentity(readback.fileIdentity, identity)
      || readback.contentSha256 !== contentSha256
    ) {
      throw new Error(
        "Local service registry mutation guard exact publication failed; evidence was retained.",
      );
    }
    await syncTrustedRegistryDirectory(trust, "registry mutation-guard publication");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (errorCode(error) === "EEXIST") {
      throw new Error(
        "Active local service launch-claim evidence requires matching claim coordination identity; registry mutation was refused.",
        { cause: error },
      );
    }
    throw error;
  }

  if (!identity) {
    throw new Error("Local service registry mutation guard identity is unavailable.");
  }
  let releaseState:
    | { kind: "active" }
    | { kind: "moved"; cleanupPath: string }
    | { kind: "unlinked" }
    | { kind: "released" } = { kind: "active" };
  let releasePromise: Promise<void> | null = null;
  const release = () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      if (releaseState.kind === "released") return;
      if (releaseState.kind === "active") {
        const current = await readBoundedTrustedEvidenceFile({
          trust,
          fileName: path.basename(claimPath),
          expectedPresent: true,
        });
        if (
          current.state !== "valid"
          || !sameFileIdentity(current.fileIdentity, identity)
          || current.contentSha256 !== contentSha256
        ) {
          throw new Error(
            "Local service registry mutation guard changed before release; evidence was retained.",
          );
        }
        const cleanupPath = `${claimPath}.released-${nonce}`;
        await fs.rename(claimPath, cleanupPath);
        releaseState = { kind: "moved", cleanupPath };
        await syncTrustedRegistryDirectory(trust, "registry mutation-guard quarantine");
      }
      if (releaseState.kind === "moved") {
        const moved = await readBoundedTrustedEvidenceFile({
          trust,
          fileName: path.basename(releaseState.cleanupPath),
          expectedPresent: true,
        });
        if (
          moved.state !== "valid"
          || !sameFileIdentity(moved.fileIdentity, identity)
          || moved.contentSha256 !== contentSha256
        ) {
          throw new Error(
            `Local service registry mutation guard changed during release; evidence was retained at ${releaseState.cleanupPath}.`,
          );
        }
        await fs.rm(releaseState.cleanupPath);
        releaseState = { kind: "unlinked" };
      }
      await syncTrustedRegistryDirectory(trust, "registry mutation-guard unlink");
      releaseState = { kind: "released" };
    })().catch((error) => {
      releasePromise = null;
      throw error;
    });
    return releasePromise;
  };
  return { nonce, release };
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
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_SIGNALABLE_PROCESS_ID ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid <= MAX_SIGNALABLE_PROCESS_ID ? pid : null;
}

function normalizeRegistryRecord(
  raw: unknown,
  expectedServiceKey?: string,
): LocalServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const pid = normalizeLocalServicePid(rec.pid);
  const processGroupId = rec.processGroupId == null
    ? null
    : normalizeLocalServicePid(rec.processGroupId);
  const startedAt = typeof rec.startedAt === "string" && !Number.isNaN(Date.parse(rec.startedAt))
    ? rec.startedAt
    : null;
  const lastSeenAt = typeof rec.lastSeenAt === "string" && !Number.isNaN(Date.parse(rec.lastSeenAt))
    ? rec.lastSeenAt
    : null;
  if (
    rec.version !== 1 ||
    typeof rec.serviceKey !== "string" ||
    (expectedServiceKey !== undefined && rec.serviceKey !== expectedServiceKey) ||
    typeof rec.profileKind !== "string" || rec.profileKind.trim().length === 0 ||
    typeof rec.serviceName !== "string" || rec.serviceName.trim().length === 0 ||
    typeof rec.command !== "string" || rec.command.trim().length === 0 ||
    typeof rec.cwd !== "string" || rec.cwd.trim().length === 0 ||
    typeof rec.envFingerprint !== "string" ||
    pid === null ||
    (rec.processGroupId != null && processGroupId === null) ||
    startedAt === null ||
    lastSeenAt === null
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
    processGroupId,
    provider: "local_process",
    runtimeServiceId: typeof rec.runtimeServiceId === "string" ? rec.runtimeServiceId : null,
    reuseKey: typeof rec.reuseKey === "string" ? rec.reuseKey : null,
    startedAt,
    lastSeenAt,
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
  return (await inspectRegistryRecordFile(filePath, expectedServiceKey)).record;
}

async function inspectRegistryRecordFile(
  filePath: string,
  expectedServiceKey?: string,
  options?: {
    trust?: TrustedRegistryDirectory;
    expectedPresent?: boolean;
  },
): Promise<LocalServiceRegistryInspection> {
  const directoryInspection = options?.trust
    ? { state: "valid" as const, trust: options.trust }
    : await inspectRuntimeServicesDirectory();
  if (directoryInspection.state === "absent") {
    return options?.expectedPresent
      ? {
          state: "invalid",
          filePath,
          record: null,
          reason: "path_identity_changed",
          entryKind: "registry",
        }
      : { state: "absent", filePath, record: null, reason: null };
  }
  if (directoryInspection.state === "invalid") {
    return {
      state: "invalid",
      filePath,
      record: null,
      reason: "untrusted_registry_directory",
      entryKind: "registry_directory",
    };
  }

  const trustedFilePath = path.resolve(
    directoryInspection.trust.realPath,
    path.basename(filePath),
  );
  const directoryIdentity = projectRegistryDirectoryIdentity(directoryInspection.trust);
  const read = await readBoundedTrustedEvidenceFile({
    trust: directoryInspection.trust,
    fileName: path.basename(filePath),
    expectedPresent: options?.expectedPresent ?? false,
  });
  if (read.state === "absent") {
    return {
      state: "absent",
      filePath: trustedFilePath,
      record: null,
      reason: null,
      directoryIdentity,
    };
  }
  if (read.state === "invalid") {
    return {
      state: "invalid",
      filePath: trustedFilePath,
      record: null,
      reason: read.reason,
      entryKind: "registry",
      directoryIdentity,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(read.contents) as unknown;
  } catch {
    return {
      state: "invalid",
      filePath: trustedFilePath,
      record: null,
      reason: "malformed_json",
      entryKind: "registry",
      directoryIdentity,
    };
  }
  const record = normalizeRegistryRecord(raw, expectedServiceKey);
  if (!record) {
    return {
      state: "invalid",
      filePath: trustedFilePath,
      record: null,
      reason: "invalid_schema",
      entryKind: "registry",
      directoryIdentity,
    };
  }
  return {
    state: "valid",
    filePath: trustedFilePath,
    record,
    reason: null,
    fileIdentity: read.fileIdentity,
    contentSha256: read.contentSha256,
    directoryIdentity,
  };
}

function normalizeLaunchClaimEvidence(
  raw: unknown,
  expectedServiceKey: string,
): LocalServiceLaunchClaimEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const ownerPid = normalizeLocalServicePid(record.ownerPid);
  const createdAt = typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt))
    ? record.createdAt
    : null;
  const nonce = typeof record.nonce === "string"
    && record.nonce.length > 0
    && record.nonce.length <= 200
    ? record.nonce
    : null;
  const expectedGenerationId = record.expectedGenerationId == null
    ? null
    : typeof record.expectedGenerationId === "string"
      && record.expectedGenerationId.trim().length > 0
      && record.expectedGenerationId.length <= 200
      ? record.expectedGenerationId
      : undefined;
  const purpose = record.purpose === undefined
    ? "generation_launch"
    : record.purpose === "generation_launch" || record.purpose === "registry_mutation_guard"
      ? record.purpose
      : undefined;
  if (
    record.version !== 1
    || record.serviceKey !== expectedServiceKey
    || ownerPid === null
    || createdAt === null
    || nonce === null
    || expectedGenerationId === undefined
    || purpose === undefined
  ) {
    return null;
  }

  let spawn: LocalServiceLaunchClaimEvidence["spawn"] = null;
  if (record.spawn !== null) {
    if (!record.spawn || typeof record.spawn !== "object" || Array.isArray(record.spawn)) {
      return null;
    }
    const rawSpawn = record.spawn as Record<string, unknown>;
    const pid = normalizeLocalServicePid(rawSpawn.pid);
    const processGroupId = rawSpawn.processGroupId === null
      ? null
      : normalizeLocalServicePid(rawSpawn.processGroupId);
    const startedAt = typeof rawSpawn.startedAt === "string"
      && Number.isFinite(Date.parse(rawSpawn.startedAt))
      ? rawSpawn.startedAt
      : null;
    if (
      pid === null
      || (rawSpawn.processGroupId !== null && processGroupId === null)
      || startedAt === null
    ) {
      return null;
    }
    spawn = { pid, processGroupId, startedAt };
  }
  if (purpose === "registry_mutation_guard" && spawn !== null) return null;

  return {
    version: 1,
    serviceKey: expectedServiceKey,
    purpose,
    ownerPid,
    createdAt,
    nonce,
    expectedGenerationId,
    spawnJournalState: spawn ? "recorded" : "not_recorded_or_write_failed",
    spawn,
  };
}

type LaunchClaimParseResult =
  | { state: "valid"; evidence: LocalServiceLaunchClaimEvidence }
  | { state: "malformed" }
  | { state: "invalid" };

function parseLaunchClaimEvidence(
  contents: string,
  expectedServiceKey: string,
): LaunchClaimParseResult {
  // Backward compatibility: claims written before the append-only journal are
  // one (often pretty-printed) JSON envelope containing `spawn` directly.
  try {
    const legacy = normalizeLaunchClaimEvidence(
      JSON.parse(contents) as unknown,
      expectedServiceKey,
    );
    return legacy ? { state: "valid", evidence: legacy } : { state: "invalid" };
  } catch {
    // A journal is two compact JSON lines: immutable header, then spawn event.
  }

  const headerEnd = contents.indexOf("\n");
  if (headerEnd < 0) return { state: "malformed" };
  const headerText = contents.slice(0, headerEnd).replace(/\r$/, "");
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(headerText) as unknown;
  } catch {
    return { state: "malformed" };
  }
  const header = normalizeLaunchClaimEvidence(rawHeader, expectedServiceKey);
  if (!header || header.spawn !== null) return { state: "invalid" };

  const tail = contents.slice(headerEnd + 1);
  if (header.purpose === "registry_mutation_guard" && tail.length > 0) {
    return { state: "invalid" };
  }
  if (tail.length === 0) return { state: "valid", evidence: header };
  const eventEnd = tail.indexOf("\n");
  if (eventEnd < 0 || tail.slice(eventEnd + 1).length > 0) {
    return {
      state: "valid",
      evidence: { ...header, spawnJournalState: "partial_or_corrupt" },
    };
  }

  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(tail.slice(0, eventEnd).replace(/\r$/, "")) as unknown;
  } catch {
    return {
      state: "valid",
      evidence: { ...header, spawnJournalState: "partial_or_corrupt" },
    };
  }
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
    return {
      state: "valid",
      evidence: { ...header, spawnJournalState: "partial_or_corrupt" },
    };
  }
  const event = rawEvent as Record<string, unknown>;
  const eventKeys = Object.keys(event).sort();
  const expectedKeys = ["nonce", "serviceKey", "spawn", "version"];
  if (
    eventKeys.length !== expectedKeys.length
    || eventKeys.some((key, index) => key !== expectedKeys[index])
    || event.version !== 1
    || event.serviceKey !== expectedServiceKey
    || event.nonce !== header.nonce
  ) {
    return {
      state: "valid",
      evidence: { ...header, spawnJournalState: "partial_or_corrupt" },
    };
  }
  const merged = normalizeLaunchClaimEvidence(
    { ...(rawHeader as Record<string, unknown>), spawn: event.spawn },
    expectedServiceKey,
  );
  if (!merged?.spawn) {
    return {
      state: "valid",
      evidence: { ...header, spawnJournalState: "partial_or_corrupt" },
    };
  }
  return { state: "valid", evidence: merged };
}

async function inspectLaunchClaimFile(input: {
  trust: TrustedRegistryDirectory;
  fileName: string;
  expectedServiceKey: string;
}): Promise<LocalServiceRegistryInspection> {
  const filePath = path.resolve(input.trust.realPath, input.fileName);
  const read = await readBoundedTrustedEvidenceFile({
    trust: input.trust,
    fileName: input.fileName,
    expectedPresent: true,
  });
  if (read.state !== "valid") {
    return {
      state: "invalid",
      filePath,
      record: null,
      reason: read.state === "invalid" ? read.reason : "path_identity_changed",
      entryKind: "launch_claim",
      launchClaim: null,
    };
  }

  const parsed = parseLaunchClaimEvidence(read.contents, input.expectedServiceKey);
  if (parsed.state === "malformed") {
    return {
      state: "invalid",
      filePath,
      record: null,
      reason: "malformed_json",
      entryKind: "launch_claim",
      launchClaim: null,
    };
  }
  if (parsed.state === "invalid") {
    return {
      state: "invalid",
      filePath,
      record: null,
      reason: "invalid_schema",
      entryKind: "launch_claim",
      launchClaim: null,
    };
  }
  const launchClaim = parsed.evidence;
  return {
    state: "invalid",
    filePath,
    record: null,
    reason: "retained_launch_claim",
    entryKind: "launch_claim",
    launchClaim,
  };
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

async function restoreRetainedMutationEvidence(input: {
  retainedPath: string;
  registryPath: string;
  identity: FileIdentity;
  trust: TrustedRegistryDirectory;
}) {
  if (!(await isTrustedRegistryDirectoryCurrent(input.trust))) return false;
  const retainedStat = await fs.lstat(input.retainedPath, { bigint: true }).catch(() => null);
  if (
    !retainedStat?.isFile()
    || retainedStat.isSymbolicLink()
    || !sameFileIdentity(retainedStat, input.identity)
  ) {
    return false;
  }
  try {
    // Hard-link publication is an atomic no-replace operation. A concurrent
    // writer wins with EEXIST instead of being overwritten by recovery.
    await fs.link(input.retainedPath, input.registryPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    return false;
  }
  const restoredStat = await fs.lstat(input.registryPath, { bigint: true }).catch(() => null);
  if (
    !restoredStat?.isFile()
    || restoredStat.isSymbolicLink()
    || !sameFileIdentity(restoredStat, input.identity)
    || !(await isTrustedRegistryDirectoryCurrent(input.trust))
  ) {
    return false;
  }
  await syncTrustedRegistryDirectory(input.trust, "retained-evidence restoration");
  const currentRetainedStat = await fs.lstat(input.retainedPath, { bigint: true }).catch(() => null);
  if (
    currentRetainedStat?.isFile()
    && !currentRetainedStat.isSymbolicLink()
    && sameFileIdentity(currentRetainedStat, input.identity)
  ) {
    await fs.rm(input.retainedPath);
    await syncTrustedRegistryDirectory(input.trust, "restored-evidence unlink");
  }
  return true;
}

async function removeExactRetainedMutationEvidence(input: {
  retainedPath: string;
  identity: FileIdentity;
  contentSha256: string;
  trust: TrustedRegistryDirectory;
}) {
  const current = await fs.lstat(input.retainedPath, { bigint: true });
  const currentRead = await readBoundedTrustedEvidenceFile({
    trust: input.trust,
    fileName: path.basename(input.retainedPath),
    expectedPresent: true,
  });
  if (
    current.isSymbolicLink()
    || !current.isFile()
    || !sameFileIdentity(current, input.identity)
    || currentRead.state !== "valid"
    || !sameFileIdentity(currentRead.fileIdentity, input.identity)
    || currentRead.contentSha256 !== input.contentSha256
    || !(await isTrustedRegistryDirectoryCurrent(input.trust))
  ) {
    throw new Error(
      `Local service mutation evidence identity changed; evidence was retained at ${input.retainedPath}.`,
    );
  }
  await fs.rm(input.retainedPath);
  await syncTrustedRegistryDirectory(input.trust, "verified mutation-evidence unlink");
}

export async function writeLocalServiceRegistryRecord(
  record: LocalServiceRegistryRecord,
  expectation: LocalServiceRegistryWriteExpectation,
) {
  assertSafeServiceKey(record.serviceKey);
  const normalizedRecord = normalizeRegistryRecord(record, record.serviceKey);
  if (!normalizedRecord) {
    throw new Error("Cannot persist an invalid local service registry record.");
  }
  const serialized = Buffer.from(`${JSON.stringify(normalizedRecord, null, 2)}\n`, "utf8");
  const serializedContentSha256 = createHash("sha256").update(serialized).digest("hex");
  if (serialized.length > MAX_LOCAL_SERVICE_EVIDENCE_BYTES) {
    throw new Error(
      `Local service registry record exceeds ${MAX_LOCAL_SERVICE_EVIDENCE_BYTES} bytes.`,
    );
  }

  const trust = await ensureTrustedRuntimeServicesDirectory();
  const mutationGuard = expectation.launchClaimNonce
    ? null
    : await acquireLocalServiceRegistryMutationGuard(
        trust,
        normalizedRecord.serviceKey,
      );
  const coordinationNonce = expectation.launchClaimNonce ?? mutationGuard?.nonce;
  const assertClaimBoundary = async () => await assertRegistryMutationClaimBoundary(
    normalizedRecord.serviceKey,
    coordinationNonce,
  );
  const registryPath = getTrustedRuntimeServiceRegistryPath(trust, normalizedRecord.serviceKey);
  const temporaryPath = path.resolve(
    trust.realPath,
    `.${normalizedRecord.serviceKey}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let temporaryIdentity: FileIdentity | null = null;
  let previousPath: string | null = null;
  let previousIdentity: FileIdentity | null = null;
  let previousContentSha256: string | null = null;
  let retainTemporaryEvidence = false;
  let published = false;
  let operationError: unknown = null;
  try {
    try {
    await assertClaimBoundary();
    const retainedMutationEvidence = await findRetainedMutationEvidence(normalizedRecord.serviceKey);
    if (retainedMutationEvidence) {
      throw new Error(
        `Retained local service mutation evidence requires human review at ${retainedMutationEvidence.filePath}.`,
      );
    }
    if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
      throw new Error("Local service registry directory identity changed before write.");
    }
    let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
    if (process.platform !== "win32") {
      if (typeof fsConstants.O_NOFOLLOW !== "number") {
        throw new Error("Local service registry write requires O_NOFOLLOW support.");
      }
      flags |= fsConstants.O_NOFOLLOW;
    }
    handle = await fs.open(temporaryPath, flags, 0o600);
    const [openedStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(temporaryPath, { bigint: true }),
    ]);
    if (
      !openedStat.isFile()
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || !sameFileIdentity(openedStat, pathStat)
      || !(await isTrustedRegistryDirectoryCurrent(trust))
    ) {
      throw new Error("Local service registry temporary-file identity is untrusted.");
    }
    temporaryIdentity = { dev: openedStat.dev, ino: openedStat.ino };

    let offset = 0;
    while (offset < serialized.length) {
      const { bytesWritten } = await handle.write(
        serialized,
        offset,
        serialized.length - offset,
        offset,
      );
      if (bytesWritten <= 0) {
        throw new Error("Local service registry write made no progress.");
      }
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await assertClaimBoundary();

    const targetInspection = await inspectRegistryRecordFile(
      registryPath,
      normalizedRecord.serviceKey,
      { trust, expectedPresent: false },
    );
    if (targetInspection.state === "invalid") {
      throw new Error(
        `Existing local service registry evidence is invalid (${targetInspection.reason}); it was retained instead of being replaced.`,
      );
    }
    if (
      (expectation.state === "absent" && targetInspection.state !== "absent")
      || (
        expectation.state === "matches"
        && (
          targetInspection.state !== "valid"
          || stableStringify(targetInspection.record) !== stableStringify(expectation.record)
        )
      )
    ) {
      throw new Error(
        "Local service registry logical compare-and-swap expectation changed; concurrent evidence was retained.",
      );
    }
    if (targetInspection.state === "valid") {
      previousPath = path.resolve(
        trust.realPath,
        `.${normalizedRecord.serviceKey}.${process.pid}.${randomUUID()}.previous`,
      );
      previousIdentity = targetInspection.fileIdentity;
      previousContentSha256 = targetInspection.contentSha256;
      await fs.rename(registryPath, previousPath);
      const movedPreviousStat = await fs.lstat(previousPath, { bigint: true });
      const movedPreviousRead = await readBoundedTrustedEvidenceFile({
        trust,
        fileName: path.basename(previousPath),
        expectedPresent: true,
      });
      if (
        movedPreviousStat.isSymbolicLink()
        || !movedPreviousStat.isFile()
        || !sameFileIdentity(movedPreviousStat, previousIdentity)
        || movedPreviousRead.state !== "valid"
        || !sameFileIdentity(movedPreviousRead.fileIdentity, previousIdentity)
        || movedPreviousRead.contentSha256 !== targetInspection.contentSha256
        || !(await isTrustedRegistryDirectoryCurrent(trust))
      ) {
        const restored = await restoreRetainedMutationEvidence({
          retainedPath: previousPath,
          registryPath,
          identity: { dev: movedPreviousStat.dev, ino: movedPreviousStat.ino },
          trust,
        });
        if (restored) previousPath = null;
        throw new Error(
          `Local service registry compare-and-swap target changed before publication; replacement evidence was ${restored ? "restored" : `retained at ${previousPath}`}.`,
        );
      }
      await syncTrustedRegistryDirectory(trust, "compare-and-swap target quarantine");
      await assertClaimBoundary();
    }
    const temporaryStat = await fs.lstat(temporaryPath, { bigint: true });
    if (
      temporaryStat.isSymbolicLink()
      || !temporaryStat.isFile()
      || !sameFileIdentity(temporaryStat, temporaryIdentity)
      || !(await isTrustedRegistryDirectoryCurrent(trust))
    ) {
      throw new Error("Local service registry path identity changed before publication.");
    }
    const prePublicationTemporaryRead = await readBoundedTrustedEvidenceFile({
      trust,
      fileName: path.basename(temporaryPath),
      expectedPresent: true,
    });
    if (
      prePublicationTemporaryRead.state !== "valid"
      || !sameFileIdentity(prePublicationTemporaryRead.fileIdentity, temporaryIdentity)
      || prePublicationTemporaryRead.contentSha256 !== serializedContentSha256
    ) {
      retainTemporaryEvidence = true;
      throw new Error(
        `Local service registry temporary content changed before publication; evidence was retained at ${temporaryPath}.`,
      );
    }
    await assertClaimBoundary();
    try {
      // Publish only if the canonical name is still absent. Unlike rename(),
      // link() never overwrites a concurrent replacement.
      await fs.link(temporaryPath, registryPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(
          "Local service registry changed during publication; concurrent evidence was retained.",
        );
      }
      throw error;
    }
    const [publishedRead, finalTemporaryRead] = await Promise.all([
      readBoundedTrustedEvidenceFile({
        trust,
        fileName: path.basename(registryPath),
        expectedPresent: true,
      }),
      readBoundedTrustedEvidenceFile({
        trust,
        fileName: path.basename(temporaryPath),
        expectedPresent: true,
      }),
    ]);
    if (
      publishedRead.state !== "valid"
      || !sameFileIdentity(publishedRead.fileIdentity, temporaryIdentity)
      || publishedRead.contentSha256 !== serializedContentSha256
      || finalTemporaryRead.state !== "valid"
      || !sameFileIdentity(finalTemporaryRead.fileIdentity, temporaryIdentity)
      || finalTemporaryRead.contentSha256 !== serializedContentSha256
    ) {
      retainTemporaryEvidence = true;
      throw new Error(
        `Local service registry publication exact content could not be verified; evidence was retained at ${temporaryPath}.`,
      );
    }
    try {
      await assertClaimBoundary();
    } catch (error) {
      retainTemporaryEvidence = true;
      throw error;
    }
    try {
      await syncTrustedRegistryDirectory(trust, "registry publication");
    } catch (error) {
      retainTemporaryEvidence = true;
      throw error;
    }
    await fs.rm(temporaryPath);
    await syncTrustedRegistryDirectory(trust, "published temporary-evidence unlink");
    const finalPublishedRead = await readBoundedTrustedEvidenceFile({
      trust,
      fileName: path.basename(registryPath),
      expectedPresent: true,
    });
    if (
      finalPublishedRead.state !== "valid"
      || !sameFileIdentity(finalPublishedRead.fileIdentity, temporaryIdentity)
      || finalPublishedRead.contentSha256 !== serializedContentSha256
    ) {
      throw new Error(
        "Local service registry publication changed after temporary-evidence cleanup; canonical evidence was retained.",
      );
    }
    await assertClaimBoundary();
    if (previousPath && previousIdentity && previousContentSha256) {
      await removeExactRetainedMutationEvidence({
        retainedPath: previousPath,
        identity: previousIdentity,
        contentSha256: previousContentSha256,
        trust,
      });
      previousPath = null;
      previousIdentity = null;
      previousContentSha256 = null;
    }
    await assertClaimBoundary();
    published = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published && !retainTemporaryEvidence && temporaryIdentity) {
        const current = await fs.lstat(temporaryPath, { bigint: true }).catch(() => null);
        if (
          current?.isFile()
          && !current.isSymbolicLink()
          && sameFileIdentity(current, temporaryIdentity)
        ) {
          try {
            await fs.rm(temporaryPath, { force: true });
            await syncTrustedRegistryDirectory(trust, "unpublished temporary-evidence unlink");
          } catch {
            // The primary write already failed closed; best-effort cleanup must
            // not hide it. Any surviving temp marker blocks later mutations.
          }
        }
      }
      if (!published && previousPath && previousIdentity) {
        const restored = await restoreRetainedMutationEvidence({
          retainedPath: previousPath,
          registryPath,
          identity: previousIdentity,
          trust,
        }).catch(() => false);
        if (restored) previousPath = null;
      }
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (mutationGuard) {
      try {
        await releaseLocalServiceRegistryMutationGuardWithRetry(mutationGuard);
      } catch (releaseError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, releaseError],
            "Local service registry mutation and its exact guard release both failed.",
          );
        }
        throw releaseError;
      }
    }
  }
}

export async function removeLocalServiceRegistryRecord(
  serviceKey: string,
  options?: { launchClaimNonce?: string },
) {
  assertSafeServiceKey(serviceKey);
  const directoryInspection = await inspectRuntimeServicesDirectory();
  if (directoryInspection.state === "absent") return;
  if (directoryInspection.state === "invalid") {
    throw new Error(
      "Local service registry directory is untrusted; registry evidence was retained.",
    );
  }
  const trust = directoryInspection.trust;
  const mutationGuard = options?.launchClaimNonce
    ? null
    : await acquireLocalServiceRegistryMutationGuard(trust, serviceKey);
  const coordinationNonce = options?.launchClaimNonce ?? mutationGuard?.nonce;
  let operationError: unknown = null;
  try {
  await assertRegistryMutationClaimBoundary(serviceKey, coordinationNonce);
  const retainedMutationEvidence = await findRetainedMutationEvidence(serviceKey);
  if (retainedMutationEvidence) {
    throw new Error(
      `Retained local service mutation evidence requires human review at ${retainedMutationEvidence.filePath}.`,
    );
  }
  const registryPath = getTrustedRuntimeServiceRegistryPath(trust, serviceKey);
  const inspection = await inspectRegistryRecordFile(
    registryPath,
    serviceKey,
    { trust, expectedPresent: false },
  );
  if (inspection.state === "absent") return;
  if (inspection.state === "invalid") {
    throw new Error(
      `Local service registry evidence is invalid (${inspection.reason}); it was retained.`,
    );
  }

  if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
    throw new Error("Local service registry path identity is untrusted; evidence was retained.");
  }
  await assertRegistryMutationClaimBoundary(serviceKey, coordinationNonce);
  const quarantinePath = path.resolve(
    trust.realPath,
    `.${serviceKey}.${process.pid}.${randomUUID()}.remove`,
  );
  await fs.rename(registryPath, quarantinePath);
  const movedStat = await fs.lstat(quarantinePath, { bigint: true });
  const movedRead = await readBoundedTrustedEvidenceFile({
    trust,
    fileName: path.basename(quarantinePath),
    expectedPresent: true,
  });
  if (
    movedStat.isSymbolicLink()
    || !movedStat.isFile()
    || !sameFileIdentity(inspection.fileIdentity, movedStat)
    || movedRead.state !== "valid"
    || !sameFileIdentity(movedRead.fileIdentity, inspection.fileIdentity)
    || movedRead.contentSha256 !== inspection.contentSha256
    || !(await isTrustedRegistryDirectoryCurrent(trust))
  ) {
    const restored = movedStat.isFile() && !movedStat.isSymbolicLink()
      ? await restoreRetainedMutationEvidence({
          retainedPath: quarantinePath,
          registryPath,
          identity: { dev: movedStat.dev, ino: movedStat.ino },
          trust,
        })
      : false;
    throw new Error(
      `Local service registry removal compare-and-swap identity changed; replacement evidence was ${restored ? "restored" : `retained at ${quarantinePath}`}.`,
    );
  }
  await syncTrustedRegistryDirectory(trust, "registry removal quarantine");
  try {
    await assertRegistryMutationClaimBoundary(serviceKey, coordinationNonce);
  } catch (error) {
    const restored = await restoreRetainedMutationEvidence({
      retainedPath: quarantinePath,
      registryPath,
      identity: inspection.fileIdentity,
      trust,
    }).catch(() => false);
    throw new Error(
      `Local service registry removal raced launch-claim custody; evidence was ${restored ? "restored" : `retained at ${quarantinePath}`}.`,
      { cause: error },
    );
  }
  await removeExactRetainedMutationEvidence({
    retainedPath: quarantinePath,
    identity: inspection.fileIdentity,
    contentSha256: inspection.contentSha256,
    trust,
  });
  await assertRegistryMutationClaimBoundary(serviceKey, coordinationNonce);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (mutationGuard) {
      try {
        await releaseLocalServiceRegistryMutationGuardWithRetry(mutationGuard);
      } catch (releaseError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, releaseError],
            "Local service registry removal and its exact guard release both failed.",
          );
        }
        throw releaseError;
      }
    }
  }
}

export async function readLocalServiceRegistryRecord(serviceKey: string) {
  return await safeReadRegistryRecord(
    getRuntimeServiceRegistryPath(serviceKey),
    serviceKey,
  );
}

export async function inspectLocalServiceRegistryRecord(serviceKey: string) {
  assertSafeServiceKey(serviceKey);
  const retainedLaunchClaim = await findRetainedReleasedLaunchClaim(serviceKey);
  if (retainedLaunchClaim) return retainedLaunchClaim;
  const retainedMutationEvidence = await findRetainedMutationEvidence(serviceKey);
  if (retainedMutationEvidence) {
    return {
      state: "invalid",
      filePath: retainedMutationEvidence.filePath,
      record: null,
      reason: "retained_mutation_evidence",
      entryKind: "mutation_evidence",
    } satisfies LocalServiceRegistryInspection;
  }
  return await inspectRegistryRecordFile(
    getRuntimeServiceRegistryPath(serviceKey),
    serviceKey,
  );
}

export async function listLocalServiceRegistryRecords(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  const inspections = await listLocalServiceRegistryInspections();
  return inspections
    .flatMap((inspection) => inspection.record ? [inspection.record] : [])
    .filter((record) => {
      if (filter?.profileKind && record.profileKind !== filter.profileKind) return false;
      if (!filter?.metadata) return true;
      return Object.entries(filter.metadata).every(([key, value]) => record.metadata?.[key] === value);
    })
    .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
}

export async function listLocalServiceRegistryInspections() {
  const directoryInspection = await inspectRuntimeServicesDirectory();
  if (directoryInspection.state === "absent") return [];
  if (directoryInspection.state === "invalid") {
    return [{
      state: "invalid",
      filePath: directoryInspection.logicalPath,
      record: null,
      reason: "untrusted_registry_directory",
      entryKind: "registry_directory",
    } satisfies LocalServiceRegistryInspection];
  }

  const trust = directoryInspection.trust;
  try {
    if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
      return [{
        state: "invalid",
        filePath: trust.logicalPath,
        record: null,
        reason: "untrusted_registry_directory",
        entryKind: "registry_directory",
      } satisfies LocalServiceRegistryInspection];
    }
    const entries = await fs.readdir(trust.realPath, { withFileTypes: true });
    if (!(await isTrustedRegistryDirectoryCurrent(trust))) {
      return [{
        state: "invalid",
        filePath: trust.logicalPath,
        record: null,
        reason: "untrusted_registry_directory",
        entryKind: "registry_directory",
      } satisfies LocalServiceRegistryInspection];
    }

    const candidateNames = entries
      .map((entry) => entry.name)
      .filter((name) => (
        name.toLowerCase().endsWith(LAUNCH_CLAIM_FILE_SUFFIX)
        || name.toLowerCase().endsWith(REGISTRY_FILE_SUFFIX)
        || releasedLaunchClaimServiceKey(name) !== null
        || retainedMutationEvidenceServiceKey(name) !== null
      ));
    const inspections = await Promise.all(candidateNames.map((fileName) => {
      const mutationServiceKey = retainedMutationEvidenceServiceKey(fileName);
      if (mutationServiceKey) {
        return Promise.resolve<LocalServiceRegistryInspection>({
          state: "invalid",
          filePath: path.resolve(trust.realPath, fileName),
          record: null,
          reason: "retained_mutation_evidence",
          entryKind: "mutation_evidence",
        });
      }
      const lowerFileName = fileName.toLowerCase();
      const releasedServiceKey = releasedLaunchClaimServiceKey(fileName);
      const isLaunchClaim = lowerFileName.endsWith(LAUNCH_CLAIM_FILE_SUFFIX)
        || releasedServiceKey !== null;
      const suffix = isLaunchClaim ? LAUNCH_CLAIM_FILE_SUFFIX : REGISTRY_FILE_SUFFIX;
      const expectedServiceKey = releasedServiceKey ?? fileName.slice(0, -suffix.length);
      if (releasedServiceKey === null && !fileName.endsWith(suffix)) {
        return Promise.resolve<LocalServiceRegistryInspection>({
          state: "invalid",
          filePath: path.resolve(trust.realPath, fileName),
          record: null,
          reason: "invalid_schema",
          entryKind: isLaunchClaim ? "launch_claim" : "registry",
          ...(isLaunchClaim ? { launchClaim: null } : {}),
        });
      }
      try {
        assertSafeServiceKey(expectedServiceKey);
      } catch {
        return Promise.resolve<LocalServiceRegistryInspection>({
          state: "invalid",
          filePath: path.resolve(trust.realPath, fileName),
          record: null,
          reason: "invalid_schema",
          entryKind: isLaunchClaim ? "launch_claim" : "registry",
          ...(isLaunchClaim ? { launchClaim: null } : {}),
        });
      }
      return isLaunchClaim
        ? inspectLaunchClaimFile({
            trust,
            fileName,
            expectedServiceKey,
          })
        : inspectRegistryRecordFile(
            path.resolve(trust.realPath, fileName),
            expectedServiceKey,
            { trust, expectedPresent: true },
          );
    }));
    return inspections.sort((left, right) => left.filePath.localeCompare(right.filePath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [{
        state: "invalid",
        filePath: trust.logicalPath,
        record: null,
        reason: "untrusted_registry_directory",
        entryKind: "registry_directory",
      } satisfies LocalServiceRegistryInspection];
    }
    return [{
      state: "invalid",
      filePath: trust.logicalPath,
      record: null,
      reason: "unreadable",
      entryKind: "registry_directory",
    } satisfies LocalServiceRegistryInspection];
  }
}

function hasLiveOrUnprovenPosixRegistryProcess(record: LocalServiceRegistryRecord) {
  if (process.platform === "win32") return false;
  // V1 registry records contain numeric PID/PGID observations only. Neither a
  // live probe nor numeric absence is a kernel tree-exit receipt: the original
  // identity can be reused and a wrapper may have left detached descendants.
  // Retain every POSIX record until launch-time pidfd/cgroup/namespace custody
  // (or another OS-stable tree receipt) is implemented.
  void record;
  return true;
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
    // Windows lacks authoritative process-tree absence without launch-time
    // Job Object evidence. Keep the durable ownership record even when its
    // wrapper/port identity can no longer be refreshed: an escaped descendant
    // may still be live and require human reconciliation.
    if (process.platform !== "win32" && !hasLiveOrUnprovenPosixRegistryProcess(record)) {
      await removeLocalServiceRegistryRecord(record.serviceKey);
    }
    return null;
  }

  if (!(await isLikelyMatchingCommand(candidate))) {
    if (process.platform !== "win32" && !hasLiveOrUnprovenPosixRegistryProcess(candidate)) {
      await removeLocalServiceRegistryRecord(record.serviceKey);
    }
    return null;
  }
  if (!(await doesLocalServiceRecordMatchCwd(candidate))) {
    if (process.platform !== "win32" && !hasLiveOrUnprovenPosixRegistryProcess(candidate)) {
      await removeLocalServiceRegistryRecord(record.serviceKey);
    }
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
      // WMI lineage can rebind the observable Windows root PID, but no POSIX
      // process group or Job Object custody was created. Keep group identity
      // null instead of manufacturing it from the repaired PID.
      processGroupId: null,
      lastSeenAt: new Date().toISOString(),
    };
    verifiedWindowsRegistryIdentities.add(candidate);
    await writeLocalServiceRegistryRecord(candidate, { state: "matches", record });
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
  await writeLocalServiceRegistryRecord(candidate, { state: "matches", record });
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

function isDefinitelyAbsentProcessError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

function isSignalablePosixProcessGroupId(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) > 1
    && (value as number) <= MAX_SIGNALABLE_PROCESS_ID;
}

export function isPidAlive(pid: number) {
  if (normalizeLocalServicePid(pid) === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isDefinitelyAbsentProcessError(error);
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return false;
  // POSIX kill(-1, signal) is a broadcast, not a probe of process group 1.
  // Preserve PGID 1 as live-or-unproven without ever issuing that call.
  if (processGroupId === 1) return true;
  if (!isSignalablePosixProcessGroupId(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !isDefinitelyAbsentProcessError(error);
  }
}

function windowsProcessIdentityMatchesStartedAt(
  identity: WindowsProcessTreeReceipt["root"],
  expectedStartedAt: Date | string,
) {
  const expected = expectedStartedAt instanceof Date
    ? expectedStartedAt
    : new Date(expectedStartedAt);
  const actual = new Date(identity.createdAt);
  if (Number.isNaN(expected.getTime()) || Number.isNaN(actual.getTime())) {
    return false;
  }
  return Math.abs(actual.getTime() - expected.getTime()) <= 60_000;
}

function receiptContainsRoot(receipt: WindowsProcessTreeReceipt) {
  return receipt.remaining.some((identity) => (
    identity.pid === receipt.root.pid
    && identity.createdAt === receipt.root.createdAt
  ));
}

async function waitForWindowsProcessTreeAbsence(
  initialReceipt: WindowsProcessTreeReceipt,
  waitMs: number,
) {
  const deadline = Date.now() + Math.max(250, waitMs);
  let receipt = initialReceipt;
  while (true) {
    receipt = await observeWindowsProcessTreeReceipt({
      receipt,
      timeoutMs: 5_000,
    });
    if (receipt.consecutiveAbsentSnapshots >= 2) {
      return receipt;
    }
    if (Date.now() >= deadline && receipt.consecutiveAbsentSnapshots === 0) {
      return receipt;
    }
    // Once one empty snapshot exists, always take the second identity-aware
    // sample even if the grace deadline elapsed during CIM enumeration.
    if (Date.now() >= deadline) continue;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
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
    return doesCommandLineMatch(record.command, commandLine);
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
  return normalizedLower.includes(
    `${recordedExecutable.toLowerCase()} ${argumentTailLower}`,
  ) || normalizedLower.includes(
    `${recordedExecutable.toLowerCase()}.exe ${argumentTailLower}`,
  );
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
  launchClaimNonce?: string;
}) {
  const existingInspection = await inspectLocalServiceRegistryRecord(input.serviceKey);
  if (existingInspection.state === "invalid") {
    // Corrupt or unreadable evidence is not absence. Do not discover a port
    // owner and overwrite the only durable record while an escaped descendant
    // may still be live.
    return null;
  }
  const existing = existingInspection.record;
  const record = existing
    ? await refreshLocalServiceRegistryProcessIdentity(existing)
    : await adoptLocalServiceFromPortOwner(input);
  if (!record) {
    if (
      process.platform !== "win32"
      && existing
      && !hasLiveOrUnprovenPosixRegistryProcess(existing)
    ) {
      await removeLocalServiceRegistryRecord(input.serviceKey, {
        launchClaimNonce: input.launchClaimNonce,
      });
    }
    return null;
  }
  if (!(await isLikelyMatchingCommand(record))) {
    if (process.platform !== "win32" && !hasLiveOrUnprovenPosixRegistryProcess(record)) {
      await removeLocalServiceRegistryRecord(input.serviceKey, {
        launchClaimNonce: input.launchClaimNonce,
      });
    }
    return null;
  }
  if (!(await doesLocalServiceRecordMatchCwd(record))) {
    if (process.platform !== "win32" && !hasLiveOrUnprovenPosixRegistryProcess(record)) {
      await removeLocalServiceRegistryRecord(input.serviceKey, {
        launchClaimNonce: input.launchClaimNonce,
      });
    }
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

  const processGroupId = process.platform === "win32"
    ? null
    : await readProcessGroupId(ownerPid);
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
    processGroupId,
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
  await writeLocalServiceRegistryRecord(record, { state: "absent" });
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
  await writeLocalServiceRegistryRecord(next, { state: "matches", record: existing });
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
    childProcess?: ChildProcess | null;
    /** Test seam for the root-exit/PID-reuse race immediately before signaling. */
    testOnlyBeforeWindowsRootSignal?: () => void | Promise<void>;
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
      // A dead wrapper is not proof that its Windows descendants are gone.
      // Callers must retain tracking until they obtain separate tree evidence.
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_process_tree_absence_unproven",
      };
    }
    // Windows has no safe bare-PID signaling path here. A PID can be reused
    // after the last CIM identity observation but before taskkill/process.kill
    // opens it. Only the exact live ChildProcess handle created by this host may
    // signal the root; descendants remain unproven without Job Object custody.
    // A timestamp match is supplementary evidence only.
    const childProcess = opts?.childProcess ?? null;
    const trustedIdentity = opts?.trustedPid === true
      && childProcess !== null
      && childProcess.pid === pid
      && childProcess.exitCode === null
      && childProcess.signalCode === null;
    if (!trustedIdentity) {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_root_signal_requires_live_child_process_handle",
      };
    }
    let processTreeReceipt: WindowsProcessTreeReceipt | null;
    try {
      processTreeReceipt = await captureWindowsProcessTreeReceipt({
        rootPid: pid,
        timeoutMs: 5_000,
      });
    } catch {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_process_tree_snapshot_failed",
      };
    }
    if (
      processTreeReceipt === null
      || (
        opts.expectedStartedAt !== undefined
        && opts.expectedStartedAt !== null
        && !windowsProcessIdentityMatchesStartedAt(
          processTreeReceipt.root,
          opts.expectedStartedAt,
        )
      )
    ) {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_process_tree_root_identity_unverified",
        ...(processTreeReceipt ? { processTreeReceipt } : {}),
      };
    }
    try {
      // A second pre-signal observation catches descendants created or
      // reparented while the first CIM snapshot was being collected. It is
      // advisory tree evidence, never authority to signal a numeric PID.
      processTreeReceipt = await observeWindowsProcessTreeReceipt({
        receipt: processTreeReceipt,
        timeoutMs: 5_000,
      });
    } catch {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_process_tree_snapshot_failed",
        processTreeReceipt,
      };
    }
    if (!receiptContainsRoot(processTreeReceipt)) {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_process_tree_root_identity_changed",
        processTreeReceipt,
      };
    }
    await opts?.testOnlyBeforeWindowsRootSignal?.();
    if (
      childProcess.pid !== pid
      || childProcess.exitCode !== null
      || childProcess.signalCode !== null
    ) {
      return {
        pid,
        attempted: false,
        confirmedStopped: false,
        outcome: "untrusted_identity",
        error: "windows_child_process_handle_no_longer_live",
        processTreeReceipt,
      };
    }

    let signalError: string | null = null;
    try {
      if (!childProcess.kill(opts?.signal ?? "SIGTERM")) {
        signalError = "windows_child_process_handle_signal_not_sent";
      }
    } catch (error) {
      signalError = error instanceof Error ? error.message : String(error);
    }
    try {
      processTreeReceipt = await waitForWindowsProcessTreeAbsence(
        processTreeReceipt,
        opts?.forceAfterMs ?? 2_000,
      );
    } catch {
      return {
        pid,
        attempted: true,
        confirmedStopped: false,
        outcome: "still_running",
        error: "windows_process_tree_snapshot_failed",
        processTreeReceipt,
      };
    }
    if (processTreeReceipt.consecutiveAbsentSnapshots >= 2) {
      // Snapshot absence is intentionally not stop authority. A root can spawn
      // an intermediate that spawns a grandchild, then both ancestors can exit
      // between samples. Without launch-time Job Object containment, releasing
      // leases or registry tracking here would recreate that escape race.
      return {
        pid,
        attempted: true,
        confirmedStopped: false,
        outcome: "still_running",
        error: "windows_process_tree_absence_unproven_without_job_object",
        processTreeReceipt,
      };
    }

    // Never retry through a numeric PID. Even an exact identity in the last
    // snapshot can exit and have its PID reused before the next syscall. The
    // retained ChildProcess handle was safe for the root only; descendants are
    // still unproven without Job Object membership and a kernel receipt.
    return {
      pid,
      attempted: true,
      confirmedStopped: false,
      outcome: "still_running",
      error: signalError
        ?? "windows_process_tree_absence_unproven_without_job_object",
      processTreeReceipt,
    };
  }

  // Node's POSIX ChildProcess.kill() delegates to kill(2) with the numeric PID;
  // the ChildProcess object is not a pidfd and cannot close the exit/PID-reuse
  // race. Numeric PGIDs have the same reuse problem and cannot account for
  // detached descendants. Probe-only observations may inform the operator, but
  // V1 must neither signal nor confirm tree exit without kernel custody.
  void recordedProcessGroupId;
  return {
    pid,
    attempted: false,
    confirmedStopped: false,
    outcome: "untrusted_identity",
    error: "posix_process_tree_stop_requires_kernel_custody",
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
