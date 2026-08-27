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
    else if (!relative.startsWith(".vite/") && !relative.endsWith(".map") && !["sw.js", "precache-manifest.js"].includes(relative)) files.push(relative);
  }
  return files;
}

const assets = (await filesBelow(distRoot)).sort();
const manifest = JSON.parse(await readFile(path.join(distRoot, ".vite", "manifest.json"), "utf8"));
const sourceKeys = ["index.html", "src/pages/public/PublicBasics.tsx", "src/pages/public/PublicDocs.tsx"];
const shellModuleAssets = new Set();
function addManifestEntry(key, target = shellModuleAssets) {
  const entry = manifest[key];
  if (!entry || target.has(entry.file)) return;
  target.add(entry.file);
  for (const file of [...(entry.css ?? []), ...(entry.assets ?? [])]) target.add(file);
  for (const dependency of entry.imports ?? []) addManifestEntry(dependency, target);
}
for (const source of sourceKeys) {
  const expectedName = path.basename(source, path.extname(source));
  const key = Object.keys(manifest).find((candidate) => candidate === source || manifest[candidate].src === source || (source === "index.html" ? manifest[candidate].isEntry : manifest[candidate].name === expectedName));
  if (!key) throw new Error(`Precache manifest entry not found for ${source}.`);
  addManifestEntry(key);
}
const shellAssets = [
  "index.html",
  "404.html",
  "app/index.html",
  "app/books/index.html",
  "app/patch-notes/index.html",
  "login/index.html",
  "docs/index.html",
  "mcp/index.html",
  "privacy/index.html",
  "terms/index.html",
  "site.webmanifest",
  ...assets.filter((asset) => /^(?:docs|mcp|privacy|terms)\/(?:.*\/)?index\.html$/.test(asset)),
  ...assets.filter((asset) => /^(?:favicon|apple-touch-icon|android-chrome-)/.test(asset)),
  ...shellModuleAssets,
].filter((asset, index, list) => assets.includes(asset) && list.indexOf(asset) === index);
const appShellAssets = new Set();
for (const source of ["src/routes/AuthProvidersRoute.tsx", "src/routes/AppShellRoute.tsx", "src/pages/BooksPage.tsx"]) {
  const expectedName = path.basename(source, path.extname(source));
  const key = Object.keys(manifest).find((candidate) => candidate === source || manifest[candidate].src === source || manifest[candidate].name === expectedName);
  if (!key) throw new Error(`App-shell manifest entry not found for ${source}.`);
  addManifestEntry(key, appShellAssets);
}
for (const asset of shellAssets) appShellAssets.delete(asset);
const optionalAssets = assets.filter((asset) => asset.startsWith("assets/") && !shellAssets.includes(asset) && !appShellAssets.has(asset));
const source = `self.__NARRARIUM_RELEASE__=${JSON.stringify(pkg.version)};self.__NARRARIUM_PRECACHE__=${JSON.stringify(shellAssets.sort())};self.__NARRARIUM_APP_SHELL_ASSETS__=${JSON.stringify([...appShellAssets].sort())};self.__NARRARIUM_OPTIONAL_ASSETS__=${JSON.stringify(optionalAssets)};\n`;
await writeFile(path.join(distRoot, "precache-manifest.js"), source);
