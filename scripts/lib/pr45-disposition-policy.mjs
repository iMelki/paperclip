export const DISPOSITIONS = new Set([
  "selective-extraction candidate",
  "semantically rederive",
  "landed-with-evidence",
]);

const CLUSTERS = {
  tracking: {
    id: "pr45-preservation-and-tracking",
    issues: [80],
    disposition: "semantically rederive",
  },
  migrations: {
    id: "coordination-and-runtime-migrations",
    issues: [28, 29],
    disposition: "semantically rederive",
  },
  coordination: {
    id: "task-coordination-authority-and-evidence",
    issues: [28, 29, 30, 52, 53, 82],
    disposition: "semantically rederive",
    landedEvidence: [
      { pr: 81, sha: "7239123cf598a8935d2e3b1be6d0b033c9340314" },
      { pr: 83, sha: "5efbc05824656b00d474fd47a2e55be17029a167" },
    ],
  },
  processCustody: {
    id: "windows-process-and-runtime-custody",
    issues: [20, 32, 42, 65],
    disposition: "selective-extraction candidate",
  },
  privateAsset: {
    id: "private-executable-asset-acl-bootstrap",
    issues: [20, 32],
    disposition: "semantically rederive",
  },
  portability: {
    id: "adapter-shell-path-and-workspace-portability",
    issues: [47, 59, 60, 61, 62, 63, 64],
    disposition: "selective-extraction candidate",
    landedEvidence: [
      { pr: 66, sha: "90bd179dd8a9442005b74a7d3ccc903b18d13804" },
      { pr: 69, sha: "987700f91c48726683741452d6d3dde2282c6122" },
    ],
  },
  integration: {
    id: "runtime-integration-and-plugin-compatibility",
    issues: [31, 80],
    disposition: "semantically rederive",
  },
  mergeResolution: {
    id: "pr45-merge-resolution-manual-review",
    issues: [80],
    disposition: "semantically rederive",
  },
};

const MIGRATION_PATHS = new Set([
  "doc/DATABASE.md",
  "packages/db/src/coordination-lease-credential-migration.test.ts",
  "packages/db/src/coordination-schema.test.ts",
  "packages/db/src/issue-comment-derived-attribution-migration.test.ts",
  "packages/db/src/migrations/0197_coordination_lease_credentials.sql",
  "packages/db/src/migrations/0198_workspace_runtime_service_process_group.sql",
  "packages/db/src/migrations/meta/_journal.json",
  "packages/db/src/schema/coordination_claim_idempotency_keys.ts",
  "packages/db/src/schema/index.ts",
  "packages/db/src/schema/mutation_leases.ts",
  "packages/db/src/schema/workspace_runtime_services.ts",
  "packages/db/src/workspace-runtime-process-group-migration.test.ts",
]);

const PROCESS_CUSTODY_PATTERNS = [
  /^packages\/db\/src\/(backup-lib|index|test-embedded-postgres|test-windows-process-tree|windows-test-job-warden)/,
  /^scripts\/(dev-runner|dev-service|kill-workspaces|run-vitest-stable)/,
  /^server\/package\.json$/,
  new RegExp(
    "^server/src/(index\\.ts|services/(dev-runner|dev-service|heartbeat|" +
      "local-service-supervisor|recovery|windows-process-tree|workspace-runtime))",
  ),
  new RegExp(
    "^server/src/__tests__/(dev-runner|dev-service|heartbeat-active-run-output-watchdog|" +
      "heartbeat-process-recovery|heartbeat-runtime-skills|kill-workspaces|" +
      "server-package-build-script|workspace-runtime)",
  ),
  /^cli\/src\/__tests__\/company-import-export-e2e\.test\.ts$/,
];

const PORTABILITY_PATTERNS = [
  /^packages\/adapter-utils\//,
  /^packages\/adapters\//,
  /^server\/src\/services\/environment-execution-target\.ts$/,
  /^server\/src\/__tests__\/(claude-local|codex-local|cursor-local)/,
];

export function classifyPath(filePath, { mergeArtifact = false } = {}) {
  let cluster;
  if ([".gitignore", "CHANGELOG.md", "OPEN_TASKS.md", "pnpm-lock.yaml"].includes(filePath)) {
    cluster = CLUSTERS.tracking;
  } else if (MIGRATION_PATHS.has(filePath)) {
    cluster = CLUSTERS.migrations;
  } else if (
    filePath.startsWith("server/src/__tests__/contracts/") ||
    filePath.startsWith("server/src/__tests__/coordination-") ||
    filePath.startsWith("server/src/routes/coordination") ||
    filePath.startsWith("server/src/services/coordination")
  ) {
    cluster = CLUSTERS.coordination;
  } else if (filePath.includes("private-executable-asset")) {
    cluster = CLUSTERS.privateAsset;
  } else if (PROCESS_CUSTODY_PATTERNS.some((pattern) => pattern.test(filePath))) {
    cluster = CLUSTERS.processCustody;
  } else if (PORTABILITY_PATTERNS.some((pattern) => pattern.test(filePath))) {
    cluster = CLUSTERS.portability;
  } else if (filePath.startsWith("packages/plugins/plugin-workspace-diff/")) {
    cluster = CLUSTERS.integration;
  } else if (mergeArtifact) {
    cluster = CLUSTERS.mergeResolution;
  } else {
    throw new Error(`No owner cluster for preserved path: ${filePath}`);
  }
  return {
    ownerCluster: cluster.id,
    ownerIssues: cluster.issues.map((number) => ({
      number,
      url: `https://github.com/iMelki/paperclip/issues/${number}`,
    })),
    disposition: mergeArtifact ? "semantically rederive" : cluster.disposition,
    landedEvidence: cluster.landedEvidence ?? [],
  };
}
