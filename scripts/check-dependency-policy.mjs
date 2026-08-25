import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const site = JSON.parse(await readFile(path.join(root, "src/narrarium-site/package.json"), "utf8"));
const reader = JSON.parse(await readFile(path.join(root, "packages/astro-reader/package.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(root, "packages/mcp-server/package.json"), "utf8"));
const creator = JSON.parse(await readFile(path.join(root, "packages/create-narrarium-book/package.json"), "utf8"));
const vite = await readFile(path.join(root, "src/narrarium-site/vite.config.ts"), "utf8");
const readerScaffold = await readFile(path.join(root, "packages/astro-reader/src/scaffold.ts"), "utf8");
const allDirect = { ...site.dependencies, ...site.devDependencies };
const atLeast = (range, minimum) => {
  const version = range?.match(/\d+(?:\.\d+){2}/)?.[0].split(".").map(Number);
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
};

for (const name of ["@azure/openai", "mammoth", "@radix-ui/react-collapsible", "@radix-ui/react-tooltip"]) {
  if (name in allDirect) throw new Error(`[dependency-policy] Removed dependency ${name} was reintroduced.`);
}
if (site.dependencies["fast-glob"] || !site.devDependencies["fast-glob"]) throw new Error("[dependency-policy] fast-glob must remain dev-only in the browser site workspace.");
if (!atLeast(site.dependencies["react-router-dom"], [7, 18, 2])) throw new Error("[dependency-policy] React Router must remain at or above 7.18.2.");
if (!atLeast(site.devDependencies.postcss, [8, 5, 23])) throw new Error("[dependency-policy] PostCSS must remain at or above 8.5.23.");
if (!atLeast(reader.dependencies.astro, [7, 2, 6])) throw new Error("[dependency-policy] Astro must remain at or above 7.2.6.");
if (!atLeast(mcp.dependencies["@modelcontextprotocol/sdk"], [1, 30, 0])) throw new Error("[dependency-policy] MCP SDK must remain at or above 1.30.0.");
if (!atLeast(reader.engines.node, [22, 12, 0]) || !atLeast(creator.engines.node, [22, 12, 0])) throw new Error("[dependency-policy] Reader packages must require Node 22.12 or newer.");
if (!readerScaffold.includes('astro: "^7.2.6"') || readerScaffold.includes('"js-yaml"')) throw new Error("[dependency-policy] Generated readers must use the audited Astro 7 baseline without a direct js-yaml dependency.");
for (const marker of ["pdf-vendor", "docx-vendor", "@azure/openai", "mammoth"]) {
  if (vite.includes(marker)) throw new Error(`[dependency-policy] Obsolete manual chunk marker ${marker} was reintroduced.`);
}

console.log("[dependency-policy] Direct dependencies, build-only placement, security floors, and manual chunks are valid.");
