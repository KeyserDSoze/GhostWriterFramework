import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, process.env.NARRARIUM_E2E_BUILD === "1" ? "dist-e2e" : "dist");

await copyFile(path.join(distRoot, "index.html"), path.join(distRoot, "404.html"));

const publicDocSlugs = JSON.parse(await readFile(path.join(siteRoot, "src", "lib", "public-doc-routes.json"), "utf8"));
if (!Array.isArray(publicDocSlugs) || publicDocSlugs.some((slug) => typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
  throw new Error("Generated public documentation routes contain an invalid slug.");
}

const routes = new Set([
  "app",
  "app/books",
  "app/patch-notes",
  "login",
  "docs",
  "mcp",
  "privacy",
  "terms",
  ...publicDocSlugs.map((slug) => `docs/${slug}`),
]);

for (const route of routes) {
  const routeRoot = path.join(distRoot, route);
  await mkdir(routeRoot, { recursive: true });
  await copyFile(path.join(distRoot, "index.html"), path.join(routeRoot, "index.html"));
}
