#!/usr/bin/env -S node --import tsx
import {
  listLocalServiceRegistryInspections,
  type LocalServiceRegistryRecord,
} from "../server/src/services/local-service-supervisor.ts";
import { stopRegisteredDevServices } from "../server/src/services/dev-service-control.ts";
import { repoRoot } from "./dev-service-profile.ts";

function toDisplayLines(records: LocalServiceRegistryRecord[]) {
  return records.map((record) => {
    const childPid = typeof record.metadata?.childPid === "number" ? ` child=${record.metadata.childPid}` : "";
    const url = typeof record.metadata?.url === "string" ? ` url=${record.metadata.url}` : "";
    return `${record.serviceName} pid=${record.pid}${childPid} cwd=${record.cwd}${url}`;
  });
}

const command = process.argv[2] ?? "list";
const registryInspections = await listLocalServiceRegistryInspections();
const invalidRegistryEntries = registryInspections
  .filter((inspection) => inspection.state === "invalid");
const records = registryInspections
  .flatMap((inspection) => inspection.record ? [inspection.record] : [])
  .filter((record) => (
    record.profileKind === "paperclip-dev"
    && record.metadata?.repoRoot === repoRoot
  ))
  .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));

if (invalidRegistryEntries.length > 0) {
  console.error(
    `Needs human review: found ${invalidRegistryEntries.length} invalid local-service registry record(s). No registry evidence was removed or replaced.`,
  );
  for (const inspection of invalidRegistryEntries) {
    const claim = inspection.launchClaim;
    const generationIdentity = claim
      ? ` purpose=${claim.purpose} nonce=${claim.nonce} expectedGenerationId=${claim.expectedGenerationId ?? "null"}`
      : "";
    let spawnIdentity = "";
    if (claim?.purpose === "registry_mutation_guard") {
      spawnIdentity = ` ownerPid=${claim.ownerPid} mutationGuard=active-or-release-incomplete`;
    } else if (claim?.spawnJournalState === "partial_or_corrupt") {
      spawnIdentity = ` ownerPid=${claim.ownerPid} spawn=partial-or-corrupt-needs-human`;
    } else if (claim?.spawn) {
      spawnIdentity = ` ownerPid=${claim.ownerPid} spawnPid=${claim.spawn.pid} processGroupId=${claim.spawn.processGroupId ?? "null"} startedAt=${claim.spawn.startedAt}`;
    } else if (claim) {
      spawnIdentity = ` ownerPid=${claim.ownerPid} spawn=not-recorded-or-write-failed-needs-human`;
    }
    console.error(
      `  ${inspection.reason}: ${inspection.filePath}${generationIdentity}${spawnIdentity}`,
    );
  }
  process.exit(2);
}

if (command === "list") {
  if (records.length === 0) {
    console.log("No Paperclip dev services registered for this repo.");
    process.exit(0);
  }
  for (const line of toDisplayLines(records)) {
    console.log(line);
  }
  process.exit(0);
}

if (command === "stop") {
  if (records.length === 0) {
    console.log("No Paperclip dev services registered for this repo.");
    process.exit(0);
  }
  const result = await stopRegisteredDevServices(records);
  process.exit(result.exitCode);
}

console.error(`Unknown dev-service command: ${command}`);
process.exit(1);
