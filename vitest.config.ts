import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
    exclude: [
      "**/node_modules/**",
      "**/*environment.test.ts",
      "**/feedback-service.test.ts",
      "**/heartbeat-comment-wake-batching.test.ts",
      "**/worktree.test.ts",
    ],
    coverage: {
      provider: "v8",
      all: true,
      include: [
        "packages/**/src/**/*.{ts,tsx}",
        "server/**/*.{ts,tsx}",
        "ui/**/*.{ts,tsx}",
        "cli/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/__tests__/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.d.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
