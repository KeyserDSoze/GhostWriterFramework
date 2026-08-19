import { defineConfig, devices } from "@playwright/test";

function siteBasePath(): string {
  const configured = process.env.SITE_BASE
    ?? (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY
      ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
      : "/");
  const normalized = configured.startsWith("/") ? configured : `/${configured}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

const basePath = siteBasePath();

export default defineConfig({
  testDir: ".",
  testMatch: "e2e/**/*.spec.ts",
  testIgnore: "src/narrarium-site/test-browser/**",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:4173${basePath}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run preview -w narrarium-site -- --host 127.0.0.1 --port 4173 --outDir dist-e2e",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
