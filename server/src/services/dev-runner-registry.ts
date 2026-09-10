import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  findAdoptableLocalService,
  inspectLocalServiceRegistryRecord,
  type LocalServiceRegistryDirectoryIdentity,
  type LocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "./local-service-supervisor.js";

type DevRunnerAdoptionInput = Parameters<typeof findAdoptableLocalService>[0];
type DevRunnerAdoptionResult = Awaited<ReturnType<typeof findAdoptableLocalService>>;

export type LocalServiceSpawnIdentity = {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
};

export interface LocalServiceLaunchClaim {
  readonly filePath: string;
  /** Unique identity for the generation that may be published by this claim. */
  readonly generationId: string;
  /** Published generation this claim fenced, or null for the first launch. */
  readonly expectedGenerationId: string | null;
  /** Persist the spawned process identity on the already-open exact claim inode. */
  recordSpawn(identity: LocalServiceSpawnIdentity): void;
  /**
   * Publish a new generation only while the registry still matches the
   * generation observed when this exact claim was acquired.
   */
  publishNextGeneration(record: LocalServiceRegistryRecord): Promise<void>;
  /**
   * Patch terminal/deferred evidence for the expected generation without
   * allowing a stale writer to replace a newer generation.
   */
  patchExpectedGeneration(patch: {
    lastSeenAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LocalServiceRegistryRecord>;
  /** Exact-identity, retryable release after the durable registry is published. */
  release(): Promise<void>;
  /** Process-exit fallback used only before any runner child has spawned. */
  releaseSync(): void;
}

export type DevRunnerLaunchClaim = LocalServiceLaunchClaim;

export interface LocalServiceLaunchGate {
  adopted: DevRunnerAdoptionResult;
  launchClaim: LocalServiceLaunchClaim | null;
}

export type DevRunnerLaunchGate = LocalServiceLaunchGate;

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Persist a claim-file namespace transition on POSIX. Windows does not expose
 * a supported directory-fsync primitive through Node, so Windows durability is
 * limited to the claim file's fsync plus the filesystem's rename/unlink rules.
 */
function fsyncClaimDirectory(directoryPath: string): void {
  if (process.platform === "win32") return;
  let flags = fsSync.constants.O_RDONLY;
  if (typeof fsSync.constants.O_DIRECTORY === "number") {
    flags |= fsSync.constants.O_DIRECTORY;
  }
  const directoryDescriptor = fsSync.openSync(directoryPath, flags);
  try {
    fsSync.fsyncSync(directoryDescriptor);
  } finally {
    fsSync.closeSync(directoryDescriptor);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function captureClaimDirectoryFence(
  registryFilePath: string,
  expected: LocalServiceRegistryDirectoryIdentity,
) {
  const directoryPath = path.dirname(registryFilePath);
  const realPath = fsSync.realpathSync.native(directoryPath);
  const directoryStat = fsSync.lstatSync(directoryPath, { bigint: true });
  const realStat = fsSync.lstatSync(realPath, { bigint: true });
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || realStat.isSymbolicLink()
    || !realStat.isDirectory()
    || !sameFileIdentity(directoryStat, realStat)
    || !sameResolvedPath(directoryPath, realPath)
    || !sameResolvedPath(realPath, expected.realPath)
    || realStat.dev.toString() !== expected.dev
    || realStat.ino.toString() !== expected.ino
  ) {
    throw new Error("Local service launch claim directory is not a trusted regular directory.");
  }
  const identity = { dev: realStat.dev, ino: realStat.ino };
  const assertCurrent = () => {
    const currentDirectoryStat = fsSync.lstatSync(directoryPath, { bigint: true });
    const currentRealPath = fsSync.realpathSync.native(directoryPath);
    const currentRealStat = fsSync.lstatSync(currentRealPath, { bigint: true });
    if (
      currentDirectoryStat.isSymbolicLink()
      || !currentDirectoryStat.isDirectory()
      || currentRealStat.isSymbolicLink()
      || !currentRealStat.isDirectory()
      || !sameFileIdentity(currentDirectoryStat, identity)
      || !sameFileIdentity(currentRealStat, identity)
      || !sameResolvedPath(currentRealPath, realPath)
      || currentRealStat.dev.toString() !== expected.dev
      || currentRealStat.ino.toString() !== expected.ino
    ) {
      throw new Error(
        "Local service launch claim directory identity changed; evidence was retained.",
      );
    }
  };
  return { assertCurrent };
}

function registryGenerationId(record: LocalServiceRegistryRecord): string | null {
  const value = record.metadata?.childGenerationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameDirectoryIdentity(
  left: LocalServiceRegistryDirectoryIdentity,
  right: LocalServiceRegistryDirectoryIdentity,
) {
  return sameResolvedPath(left.realPath, right.realPath)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function createLaunchClaim(
  serviceKey: string,
  registryFilePath: string,
  expectedGenerationId: string | null,
  expectedDirectoryIdentity: LocalServiceRegistryDirectoryIdentity,
): LocalServiceLaunchClaim {
  const nonce = randomUUID();
  const claimPath = `${registryFilePath}.launch-claim`;
  const directoryFence = captureClaimDirectoryFence(
    registryFilePath,
    expectedDirectoryIdentity,
  );
  directoryFence.assertCurrent();
  let descriptor: number;
  try {
    let flags = fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL;
    if (process.platform !== "win32") {
      if (typeof fsSync.constants.O_NOFOLLOW !== "number") {
        throw new Error("Local service launch claim requires O_NOFOLLOW support.");
      }
      flags |= fsSync.constants.O_NOFOLLOW;
    }
    descriptor = fsSync.openSync(claimPath, flags, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Local service launch claim already exists. Another launch may be active or may have exited without publishing authoritative process-tree evidence; the claim was retained for human review.",
      );
    }
    throw error;
  }

  try {
    directoryFence.assertCurrent();
  } catch (error) {
    fsSync.closeSync(descriptor);
    throw error;
  }

  const identity = fsSync.fstatSync(descriptor, { bigint: true });
  let state:
    | { kind: "active" }
    | { kind: "moved"; cleanupPath: string }
    | { kind: "unlinked" }
    | { kind: "released" } = { kind: "active" };
  let descriptorOpen = true;
  let releaseRequested = false;
  let operationTail: Promise<void> = Promise.resolve();
  let releasePromise: Promise<void> | null = null;
  const createdAt = new Date().toISOString();
  let spawnIdentity: LocalServiceSpawnIdentity | null = null;
  let spawnWriteFailed = false;
  let spawnEventBytes: Buffer | null = null;
  let publicationVerified = false;

  const initialPayload = `${JSON.stringify({
    version: 1,
    serviceKey,
    purpose: "generation_launch",
    ownerPid: process.pid,
    createdAt,
    nonce,
    expectedGenerationId,
    spawn: null,
  })}\n`;
  const initialPayloadBytes = Buffer.from(initialPayload, "utf8");

  const assertActiveIdentity = () => {
    if (state.kind !== "active" || !descriptorOpen) {
      throw new Error("Local service launch claim is no longer active.");
    }
    const currentIdentity = fsSync.lstatSync(claimPath, { bigint: true });
    if (!sameFileIdentity(identity, currentIdentity)) {
      throw new Error(
        "Local service launch claim identity changed; replacement evidence was retained.",
      );
    }
    directoryFence.assertCurrent();
  };

  const expectedClaimBytes = () => spawnEventBytes
    ? Buffer.concat([initialPayloadBytes, spawnEventBytes])
    : initialPayloadBytes;

  const assertExactClaimEvidence = (filePath: string) => {
    directoryFence.assertCurrent();
    let flags = fsSync.constants.O_RDONLY;
    if (process.platform !== "win32") {
      if (
        typeof fsSync.constants.O_NOFOLLOW !== "number"
        || typeof fsSync.constants.O_NONBLOCK !== "number"
      ) {
        throw new Error("Local service launch claim exact read requires safe open flags.");
      }
      flags |= fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK;
    }
    const readDescriptor = fsSync.openSync(filePath, flags);
    try {
      const expected = expectedClaimBytes();
      const opened = fsSync.fstatSync(readDescriptor, { bigint: true });
      const named = fsSync.lstatSync(filePath, { bigint: true });
      if (
        !opened.isFile()
        || named.isSymbolicLink()
        || !named.isFile()
        || !sameFileIdentity(opened, identity)
        || !sameFileIdentity(named, identity)
        || opened.size !== BigInt(expected.length)
      ) {
        throw new Error(
          "Local service launch claim exact identity or length changed; evidence was retained.",
        );
      }
      const observed = Buffer.alloc(expected.length + 1);
      let offset = 0;
      while (offset < observed.length) {
        const bytesRead = fsSync.readSync(
          readDescriptor,
          observed,
          offset,
          observed.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const afterOpened = fsSync.fstatSync(readDescriptor, { bigint: true });
      const afterNamed = fsSync.lstatSync(filePath, { bigint: true });
      if (
        offset !== expected.length
        || !observed.subarray(0, offset).equals(expected)
        || !sameFileIdentity(afterOpened, identity)
        || !sameFileIdentity(afterNamed, identity)
      ) {
        throw new Error(
          "Local service launch claim exact content changed; evidence was retained.",
        );
      }
    } finally {
      fsSync.closeSync(readDescriptor);
    }
    directoryFence.assertCurrent();
  };

  const assertExactActiveEvidence = () => {
    assertActiveIdentity();
    assertExactClaimEvidence(claimPath);
    assertActiveIdentity();
  };

  const writeInitialPayload = () => {
    assertActiveIdentity();
    const before = fsSync.fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(identity, before) || before.size !== 0n) {
      throw new Error("Local service launch claim was not empty before initialization.");
    }
    let offset = 0;
    while (offset < initialPayloadBytes.length) {
      const written = fsSync.writeSync(
        descriptor,
        initialPayloadBytes,
        offset,
        initialPayloadBytes.length - offset,
        offset,
      );
      if (written <= 0) {
        throw new Error("Local service launch claim write made no progress.");
      }
      offset += written;
    }
    fsSync.fsyncSync(descriptor);
    assertExactActiveEvidence();
    fsyncClaimDirectory(path.dirname(claimPath));
    assertExactActiveEvidence();
  };

  const appendSpawnPayload = (nextIdentity: LocalServiceSpawnIdentity) => {
    assertActiveIdentity();
    if (spawnWriteFailed) {
      throw new Error(
        "Local service launch claim retains a partial spawn-write attempt; exact evidence requires human review.",
      );
    }
    const before = fsSync.fstatSync(descriptor, { bigint: true });
    if (
      !sameFileIdentity(identity, before)
      || before.size !== BigInt(initialPayloadBytes.length)
    ) {
      spawnWriteFailed = true;
      throw new Error(
        "Local service launch claim journal length changed before spawn recording; evidence was retained.",
      );
    }
    const eventBytes = Buffer.from(`${JSON.stringify({
      version: 1,
      serviceKey,
      nonce,
      spawn: nextIdentity,
    })}\n`, "utf8");
    let offset = 0;
    try {
      while (offset < eventBytes.length) {
        const written = fsSync.writeSync(
          descriptor,
          eventBytes,
          offset,
          eventBytes.length - offset,
          initialPayloadBytes.length + offset,
        );
        if (written <= 0) {
          throw new Error("Local service launch claim spawn write made no progress.");
        }
        offset += written;
      }
      fsSync.fsyncSync(descriptor);
      spawnEventBytes = eventBytes;
      assertExactActiveEvidence();
    } catch (error) {
      spawnWriteFailed = true;
      throw error;
    }
  };

  const closeDescriptor = () => {
    if (!descriptorOpen) return;
    fsSync.closeSync(descriptor);
    descriptorOpen = false;
  };

  const releaseSync = () => {
    if (spawnWriteFailed || (spawnIdentity !== null && !publicationVerified)) {
      throw new Error(
        "Local service launch claim has spawn evidence without a verified registry publication; the exact claim was retained.",
      );
    }
    releaseRequested = true;
    if (state.kind === "released") return;
    if (state.kind === "active") {
      assertExactActiveEvidence();
      const cleanupPath = `${claimPath}.released-${nonce}`;
      fsSync.renameSync(claimPath, cleanupPath);
      state = { kind: "moved", cleanupPath };
      fsyncClaimDirectory(path.dirname(claimPath));
      directoryFence.assertCurrent();
    }

    if (state.kind === "moved") {
      assertExactClaimEvidence(state.cleanupPath);
      closeDescriptor();
      directoryFence.assertCurrent();
      fsSync.unlinkSync(state.cleanupPath);
      state = { kind: "unlinked" };
    }
    fsyncClaimDirectory(path.dirname(claimPath));
    directoryFence.assertCurrent();
    state = { kind: "released" };
  };

  const runSerialized = <T>(operation: () => Promise<T>): Promise<T> => {
    if (releaseRequested) {
      return Promise.reject(new Error("Local service launch claim release is already pending."));
    }
    const result = operationTail.then(async () => {
      assertExactActiveEvidence();
      return await operation();
    });
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const recordSpawn = (nextIdentity: LocalServiceSpawnIdentity) => {
    if (releaseRequested) {
      throw new Error("Local service launch claim release is already pending.");
    }
    if (!Number.isSafeInteger(nextIdentity.pid) || nextIdentity.pid <= 0) {
      throw new Error("Local service launch claim requires a positive spawn PID.");
    }
    if (
      nextIdentity.processGroupId !== null
      && (
        !Number.isSafeInteger(nextIdentity.processGroupId)
        || nextIdentity.processGroupId <= 0
      )
    ) {
      throw new Error("Local service launch claim process-group identity is invalid.");
    }
    if (!Number.isFinite(Date.parse(nextIdentity.startedAt))) {
      throw new Error("Local service launch claim start timestamp is invalid.");
    }
    if (spawnIdentity) {
      if (
        spawnIdentity.pid === nextIdentity.pid
        && spawnIdentity.processGroupId === nextIdentity.processGroupId
        && spawnIdentity.startedAt === nextIdentity.startedAt
      ) {
        assertExactActiveEvidence();
        return;
      }
      throw new Error("Local service launch claim already records a different spawn identity.");
    }
    appendSpawnPayload(nextIdentity);
    spawnIdentity = { ...nextIdentity };
  };

  const inspectExpectedRegistry = async () => {
    assertExactActiveEvidence();
    const inspection = await inspectLocalServiceRegistryRecord(serviceKey);
    assertExactActiveEvidence();
    if (expectedGenerationId === null) {
      if (inspection.state !== "absent") {
        throw new Error(
          "Local service initial-generation claim no longer observes an absent registry; existing evidence was retained.",
        );
      }
      return null;
    }
    if (
      inspection.state !== "valid"
      || registryGenerationId(inspection.record) !== expectedGenerationId
    ) {
      throw new Error(
        "Local service registry generation changed while claimed; stale evidence was not written.",
      );
    }
    return inspection.record;
  };

  const publishNextGenerationUnlocked = async (record: LocalServiceRegistryRecord) => {
    if (record.serviceKey !== serviceKey) {
      throw new Error("Local service generation claim cannot publish a different service key.");
    }
    if (registryGenerationId(record) !== nonce) {
      throw new Error("Local service generation publication must use the claim generation identity.");
    }
    if (!spawnIdentity) {
      throw new Error("Local service generation publication requires durable spawn identity first.");
    }
    if (
      record.metadata?.childPid !== spawnIdentity.pid
      || record.metadata?.childGenerationStartedAt !== spawnIdentity.startedAt
      || record.metadata?.childProcessGroupId !== spawnIdentity.processGroupId
    ) {
      throw new Error(
        "Local service generation publication does not match the fsynced spawn identity.",
      );
    }
    const existing = await inspectExpectedRegistry();
    if (existing && record.pid !== existing.pid) {
      throw new Error("Local service generation publication cannot replace the wrapper process identity.");
    }
    assertActiveIdentity();
    await writeLocalServiceRegistryRecord(
      record,
      existing
        ? { state: "matches", record: existing, launchClaimNonce: nonce }
        : { state: "absent", launchClaimNonce: nonce },
    );
    assertActiveIdentity();
    const readback = await inspectLocalServiceRegistryRecord(serviceKey);
    if (
      readback.state !== "valid"
      || registryGenerationId(readback.record) !== nonce
      || stableStringify(readback.record) !== stableStringify(record)
    ) {
      throw new Error("Local service generation publication could not be read back exactly.");
    }
    publicationVerified = true;
  };

  const patchExpectedGenerationUnlocked = async (patch: {
    lastSeenAt?: string;
    metadata?: Record<string, unknown>;
  }) => {
    if (expectedGenerationId === null) {
      throw new Error("Initial-generation claims cannot patch an unpublished generation.");
    }
    const existing = await inspectExpectedRegistry();
    if (!existing) {
      throw new Error("Local service expected generation is absent.");
    }
    const next: LocalServiceRegistryRecord = {
      ...existing,
      lastSeenAt: patch.lastSeenAt ?? new Date().toISOString(),
      metadata: {
        ...(existing.metadata ?? {}),
        ...(patch.metadata ?? {}),
        childGenerationId: expectedGenerationId,
      },
    };
    assertActiveIdentity();
    await writeLocalServiceRegistryRecord(next, {
      state: "matches",
      record: existing,
      launchClaimNonce: nonce,
    });
    assertActiveIdentity();
    const readback = await inspectLocalServiceRegistryRecord(serviceKey);
    if (
      readback.state !== "valid"
      || registryGenerationId(readback.record) !== expectedGenerationId
      || stableStringify(readback.record) !== stableStringify(next)
    ) {
      throw new Error("Local service expected-generation patch could not be read back exactly.");
    }
    return readback.record;
  };

  const publishNextGeneration = async (record: LocalServiceRegistryRecord) => (
    await runSerialized(async () => await publishNextGenerationUnlocked(record))
  );
  const patchExpectedGeneration = async (patch: {
    lastSeenAt?: string;
    metadata?: Record<string, unknown>;
  }) => await runSerialized(async () => await patchExpectedGenerationUnlocked(patch));
  const release = () => {
    if (!releasePromise) {
      releaseRequested = true;
      releasePromise = operationTail.then(() => releaseSync()).catch((error) => {
        if (state.kind === "active") releaseRequested = false;
        releasePromise = null;
        throw error;
      });
    }
    return releasePromise;
  };

  try {
    writeInitialPayload();
  } catch (error) {
    try {
      releaseSync();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Dev runner launch claim initialization and exact cleanup both failed.",
      );
    }
    throw error;
  }

  return {
    filePath: claimPath,
    generationId: nonce,
    expectedGenerationId,
    recordSpawn,
    publishNextGeneration,
    patchExpectedGeneration,
    release,
    releaseSync,
  };
}

/**
 * Adopts the existing dev runner or proves there is no retained registry
 * evidence before a new runner may spawn.
 *
 * A valid-but-unadoptable or invalid record is custody evidence, not absence:
 * its wrapper may have left escaped descendants on either platform. The caller
 * must stop before spawning instead of overwriting the only durable record.
 */
export async function claimLocalServiceLaunchOrAdopt(
  input: DevRunnerAdoptionInput,
  options?: {
    evidenceLabel?: string;
    requireRegistryAbsentBeforeReconciliation?: boolean;
  },
): Promise<LocalServiceLaunchGate> {
  const evidenceLabel = options?.evidenceLabel ?? "Local service";
  const requireRegistryAbsentBeforeReconciliation =
    options?.requireRegistryAbsentBeforeReconciliation ?? true;
  // The inspection gives us the validated, instance-scoped registry path. The
  // exclusive create below is the actual linearization point; all custody
  // decisions are re-read only after the claim is held.
  const registryLocation = await inspectLocalServiceRegistryRecord(input.serviceKey);
  if (registryLocation.state === "invalid") {
    throw new Error(
      `${evidenceLabel} has invalid pre-existing registry evidence (${registryLocation.reason}); it was retained for human review.`,
    );
  }
  await fs.mkdir(path.dirname(registryLocation.filePath), { recursive: true });
  const preparedLocation = await inspectLocalServiceRegistryRecord(input.serviceKey);
  if (preparedLocation.filePath !== registryLocation.filePath) {
    throw new Error("Local service registry location changed while preparing the launch claim.");
  }
  if (preparedLocation.state === "invalid") {
    throw new Error(
      `${evidenceLabel} has an invalid registry record (${preparedLocation.reason}). The registry evidence was retained for human review instead of creating a launch claim.`,
    );
  }
  if (
    registryLocation.directoryIdentity
    && (
      !preparedLocation.directoryIdentity
      || !sameDirectoryIdentity(
        registryLocation.directoryIdentity,
        preparedLocation.directoryIdentity,
      )
    )
  ) {
    throw new Error(
      "Local service registry directory identity changed while preparing the launch claim; prior evidence may be hidden and no claim was created.",
    );
  }
  if (!preparedLocation.directoryIdentity) {
    throw new Error(
      "Local service registry directory identity is unavailable after preparation; no launch claim was created.",
    );
  }
  const launchClaim = createLaunchClaim(
    input.serviceKey,
    preparedLocation.filePath,
    null,
    preparedLocation.directoryIdentity,
  );

  try {
    const before = await inspectLocalServiceRegistryRecord(input.serviceKey);
    if (before.state === "invalid") {
      throw new Error(
        `${evidenceLabel} has an invalid registry record (${before.reason}). The registry evidence was retained for human review instead of being replaced.`,
      );
    }

    const adopted = await findAdoptableLocalService({
      ...input,
      launchClaimNonce: launchClaim.generationId,
    });
    if (adopted) {
      await launchClaim.release();
      return { adopted, launchClaim: null };
    }

    const after = await inspectLocalServiceRegistryRecord(input.serviceKey);
    if (
      after.state !== "absent"
      || (requireRegistryAbsentBeforeReconciliation && before.state !== "absent")
    ) {
      throw new Error(
        `${evidenceLabel} has unverified registry process evidence. The process and registry were retained for human review instead of being replaced.`,
      );
    }
    return { adopted: null, launchClaim };
  } catch (error) {
    try {
      await launchClaim.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Dev runner custody check failed and its exact launch claim could not be released.",
      );
    }
    throw error;
  }
}

/**
 * Acquire the fixed per-service generation transition claim and compare the
 * published generation again after exclusive creation. A stale exit handler
 * therefore cannot mutate the registry after a replacement generation wins.
 */
export async function claimLocalServiceGeneration(input: {
  serviceKey: string;
  expectedGenerationId: string;
}): Promise<LocalServiceLaunchClaim> {
  if (!input.expectedGenerationId) {
    throw new Error("Local service generation claim requires an expected generation identity.");
  }
  const before = await inspectLocalServiceRegistryRecord(input.serviceKey);
  if (
    before.state !== "valid"
    || registryGenerationId(before.record) !== input.expectedGenerationId
    || !before.directoryIdentity
  ) {
    throw new Error(
      "Local service registry generation does not match the requested claim; stale evidence was not written.",
    );
  }
  const claim = createLaunchClaim(
    input.serviceKey,
    before.filePath,
    input.expectedGenerationId,
    before.directoryIdentity,
  );
  try {
    const after = await inspectLocalServiceRegistryRecord(input.serviceKey);
    if (
      after.state !== "valid"
      || registryGenerationId(after.record) !== input.expectedGenerationId
    ) {
      throw new Error(
        "Local service registry generation changed while acquiring the claim; stale evidence was not written.",
      );
    }
    return claim;
  } catch (error) {
    try {
      await claim.release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Local service generation claim failed and its exact claim could not be released.",
      );
    }
    throw error;
  }
}

export async function claimDevRunnerGeneration(input: {
  serviceKey: string;
  expectedGenerationId: string;
}): Promise<LocalServiceLaunchClaim> {
  return await claimLocalServiceGeneration(input);
}

export async function claimDevRunnerLaunchOrAdopt(
  input: DevRunnerAdoptionInput,
): Promise<DevRunnerLaunchGate> {
  return await claimLocalServiceLaunchOrAdopt(input, {
    evidenceLabel: "Dev runner",
    requireRegistryAbsentBeforeReconciliation: true,
  });
}
