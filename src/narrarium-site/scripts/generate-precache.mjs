import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, process.env.NARRARIUM_E2E_BUILD === "1" ? "dist-e2e" : "dist");
const pkg = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8"));

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
    else if (!relative.endsWith(".map") && !["sw.js", "precache-manifest.js"].includes(relative)) files.push(relative);
  }
  return files;
}

const assets = (await filesBelow(distRoot)).sort();
const source = `self.__NARRARIUM_RELEASE__=${JSON.stringify(pkg.version)};self.__NARRARIUM_PRECACHE__=${JSON.stringify(assets)};\n`;
await writeFile(path.join(distRoot, "precache-manifest.js"), source);
