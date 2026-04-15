import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
    exclude: ["**/node_modules/**"],
  },
});
