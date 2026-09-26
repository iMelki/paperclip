import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded teardown includes a bounded graceful stop followed by Windows
    // process identity checks and tree termination; together these exceed 10s.
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
