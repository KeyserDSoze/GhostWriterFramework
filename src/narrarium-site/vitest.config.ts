import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test-browser/setup.ts"],
    include: ["test-browser/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/assistant/actionValidation.ts",
        "src/assistant/mediaOwnership.ts",
        "src/assistant/orchestratorRules.ts",
        "src/assistant/sessionOwnership.ts",
        "src/assistant/targetRules.ts",
        "src/assistant/toolPolicy.ts",
        "src/drive/migrationSafety.ts",
      ],
      thresholds: {
        perFile: true,
        statements: 25,
        branches: 18,
        functions: 33,
        lines: 30,
      },
    },
  },
});
