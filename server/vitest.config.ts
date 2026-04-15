import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [
      "**/node_modules/**",
      "**/cli-auth-routes.test.ts",
      "**/*environment.test.ts",
      "**/server-startup-feedback-export.test.ts",
      "**/*execute.test.ts",
      "**/feedback-service.test.ts",
      "**/heartbeat-comment-wake-batching.test.ts",
      "**/worktree.test.ts",
    ],
  },
});
