import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, process.env.NARRARIUM_E2E_BUILD === "1" ? "dist-e2e" : "dist");

await copyFile(path.join(distRoot, "index.html"), path.join(distRoot, "404.html"));

for (const route of ["app", "app/patch-notes", "login"]) {
  const routeRoot = path.join(distRoot, route);
  await mkdir(routeRoot, { recursive: true });
  await copyFile(path.join(distRoot, "index.html"), path.join(routeRoot, "index.html"));
}
