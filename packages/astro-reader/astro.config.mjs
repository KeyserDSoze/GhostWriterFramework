import { defineConfig } from "astro/config";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.SITE_BASE ?? (process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/");
const site = process.env.SITE_URL;

export default defineConfig({
  output: "static",
  site,
  base,
  trailingSlash: "always",
});
