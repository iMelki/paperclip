import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tsc emits test copies into dist. Run authored suites only, including the
    // maintenance scripts, while preserving Vitest's default exclusions.
    include: ["src", "scripts"].flatMap((root) =>
      configDefaults.include.map((pattern) => `${root}/${pattern}`),
    ),
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
