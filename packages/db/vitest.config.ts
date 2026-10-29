import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded teardown includes a bounded graceful stop followed by Windows
    // process identity checks and tree termination; together these exceed 10s.
    hookTimeout: 30_000,
    // tsc emits test copies into dist. Run authored suites only, including the
    // maintenance scripts, while preserving Vitest's default exclusions.
    include: ["src", "scripts"].flatMap((root) =>
      configDefaults.include.map((pattern) => `${root}/${pattern}`),
    ),
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
