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
    // A component test goes through jsdom, IndexedDB and several async steps: on a busy machine (parallel workers, other suites, coverage) it takes several times what it takes alone,
    // and five seconds is not enough for a test that is right. A test that is wrong still fails, only later; the waits inside a test (`asyncUtilTimeout`, in `test-browser/setup.ts`)
    // stay shorter than the test, and a test that says its own timeout is given at least this one.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
