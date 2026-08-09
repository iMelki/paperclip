import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

function loadAdditionalExcludes(): string[] {
  const excludeFile = process.env.PAPERCLIP_VITEST_EXCLUDE_FILE;
  if (!excludeFile) return [];

  const parsed: unknown = JSON.parse(readFileSync(excludeFile, "utf8"));
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(
      "PAPERCLIP_VITEST_EXCLUDE_FILE must contain a JSON array of test-path strings",
    );
  }
  return parsed;
}

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...loadAdditionalExcludes()],
    environment: "node",
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
