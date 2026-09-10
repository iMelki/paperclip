import {
  isPidAlive,
  isProcessGroupAlive,
  removeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "./local-service-supervisor.js";

type DevServiceControlDependencies = {
  platform: NodeJS.Platform;
  isPidAlive: typeof isPidAlive;
  isProcessGroupAlive: typeof isProcessGroupAlive;
  removeRegistryRecord: typeof removeLocalServiceRegistryRecord;
  log: (message: string) => void;
  error: (message: string) => void;
};

const defaultDependencies: DevServiceControlDependencies = {
  platform: process.platform,
  isPidAlive,
  isProcessGroupAlive,
  removeRegistryRecord: removeLocalServiceRegistryRecord,
  log: console.log,
  error: console.error,
};

export async function stopRegisteredDevServices(
  records: LocalServiceRegistryRecord[],
  dependencies: Partial<DevServiceControlDependencies> = {},
) {
  const deps = { ...defaultDependencies, ...dependencies };
  let staleRegistrationsRemoved = 0;
  let needsHuman = 0;

  for (const record of records) {
    const pidAlive = deps.isPidAlive(record.pid);
    const processGroupAlive = deps.isProcessGroupAlive(record.processGroupId);
    const metadataChildPid = typeof record.metadata?.childPid === "number"
      && Number.isInteger(record.metadata.childPid)
      && record.metadata.childPid > 0
      ? record.metadata.childPid
      : null;
    const metadataChildAlive = metadataChildPid !== null && deps.isPidAlive(metadataChildPid);
    // Persisted PID/PGID/childPid values are useful liveness observations, never
    // stable tree identity. On POSIX, numeric absence cannot rule out detached
    // descendants or identifier reuse; on Windows, no Job receipt exists.
    // V1 therefore retains every record until the launcher persists an
    // OS-backed tree-exit receipt.
    const treeAbsenceUnproven = true;
    if (pidAlive || processGroupAlive || metadataChildAlive || treeAbsenceUnproven) {
      needsHuman += 1;
      deps.error(
        `Needs human review: ${record.serviceName} still has live or unproven persisted PID/process-group/tree evidence, but dev:stop has no pidfd/cgroup/namespace, Windows Job receipt, or other OS-stable tree identity. No signal was sent and registry evidence was retained.`,
      );
      continue;
    }

    await deps.removeRegistryRecord(record.serviceKey);
    staleRegistrationsRemoved += 1;
    deps.log(`Removed stale registration for ${record.serviceName} (pid ${record.pid})`);
  }

  return {
    staleRegistrationsRemoved,
    needsHuman,
    exitCode: needsHuman > 0 ? 2 : 0,
  };
}
