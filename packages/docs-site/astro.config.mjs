import { defineConfig } from "astro/config";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.DOCS_BASE ?? (process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/");

export default defineConfig({
  output: "static",
  base,
  trailingSlash: "always",
});
