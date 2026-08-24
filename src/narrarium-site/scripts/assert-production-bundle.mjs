import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

if (process.env.NARRARIUM_E2E_BUILD === "1") process.exit(0);

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, "dist");
const forbidden = ["e2e-google-token", "e2e-google-user", "E2E builds use a deterministic local identity", "NARRARIUM_E2E_BUILD", "VITE_E2E", "__narrariumE2e", "E2eStorageUpgradeResult", "Simulated repository migration crash", "Simulated maintenance removal crash"];
const INITIAL_ENTRY_RAW_BUDGET = 2_300_000;
const INITIAL_ENTRY_GZIP_BUDGET = 700_000;
const INITIAL_GRAPH_RAW_BUDGET = 3_400_000;
const INITIAL_GRAPH_GZIP_BUDGET = 1_000_000;
const baseline = { entry: { rawBytes: 4_205_130, gzipBytes: 1_633_350 } };

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(target));
    else files.push(target);
  }
  return files;
}

for (const file of await filesUnder(distRoot)) {
  const content = await readFile(file, "utf8").catch(() => "");
  const match = forbidden.find((value) => content.includes(value));
  if (match) throw new Error(`[production-bundle] Forbidden E2E marker '${match}' found in ${path.relative(distRoot, file)}.`);
}

const indexHtml = await readFile(path.join(distRoot, "index.html"), "utf8");
const entryMatch = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(indexHtml);
if (!entryMatch) throw new Error("[production-bundle] Initial module entry was not found in index.html.");
const assetOffset = entryMatch[1].indexOf("/assets/");
const entryRelative = assetOffset >= 0 ? entryMatch[1].slice(assetOffset + 1) : entryMatch[1].replace(/^\.?\//, "").replace(/^\//, "");
const entryPath = path.join(distRoot, entryRelative);
const entry = await readFile(entryPath);
const entryText = entry.toString("utf8");
for (const marker of ["LiberationSerif-Regular.ttf", "font/ttf;base64"]) {
  if (entryText.includes(marker)) throw new Error(`[production-bundle] Lazy export marker '${marker}' leaked into the initial entry.`);
}
const preloads = [...indexHtml.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((match) => match[1]);
const eagerExport = preloads.find((href) => /BookExport|pdfFonts|jspdf/i.test(href));
if (eagerExport) throw new Error(`[production-bundle] Export chunk '${eagerExport}' is eagerly preloaded.`);
const rawBytes = (await stat(entryPath)).size;
const gzipBytes = gzipSync(entry).byteLength;
if (rawBytes > INITIAL_ENTRY_RAW_BUDGET) throw new Error(`[production-bundle] Initial entry ${rawBytes} bytes exceeds ${INITIAL_ENTRY_RAW_BUDGET}.`);
if (gzipBytes > INITIAL_ENTRY_GZIP_BUDGET) throw new Error(`[production-bundle] Initial entry gzip ${gzipBytes} bytes exceeds ${INITIAL_ENTRY_GZIP_BUDGET}.`);
const staticPaths = [entryPath, ...preloads.map((href) => {
  const offset = href.indexOf("/assets/");
  return path.join(distRoot, offset >= 0 ? href.slice(offset + 1) : href.replace(/^\/?/, ""));
})];
let graphRawBytes = 0;
let graphGzipBytes = 0;
for (const file of staticPaths) {
  const content = await readFile(file);
  const text = content.toString("utf8");
  for (const marker of ["LiberationSerif-Regular.ttf", "font/ttf;base64", "submission-package.zip", "application/epub+zip"]) {
    if (text.includes(marker)) throw new Error(`[production-bundle] Eager export implementation marker '${marker}' found in ${path.relative(distRoot, file)}.`);
  }
  graphRawBytes += content.byteLength;
  graphGzipBytes += gzipSync(content).byteLength;
}
if (graphRawBytes > INITIAL_GRAPH_RAW_BUDGET) throw new Error(`[production-bundle] Initial graph ${graphRawBytes} bytes exceeds ${INITIAL_GRAPH_RAW_BUDGET}.`);
if (graphGzipBytes > INITIAL_GRAPH_GZIP_BUDGET) throw new Error(`[production-bundle] Initial graph gzip ${graphGzipBytes} bytes exceeds ${INITIAL_GRAPH_GZIP_BUDGET}.`);
const report = {
  baseline,
  current: {
    entry: { file: path.relative(distRoot, entryPath), rawBytes, gzipBytes },
    initialGraph: { files: staticPaths.map((file) => path.relative(distRoot, file)), rawBytes: graphRawBytes, gzipBytes: graphGzipBytes },
  },
  budgets: { entry: { rawBytes: INITIAL_ENTRY_RAW_BUDGET, gzipBytes: INITIAL_ENTRY_GZIP_BUDGET }, initialGraph: { rawBytes: INITIAL_GRAPH_RAW_BUDGET, gzipBytes: INITIAL_GRAPH_GZIP_BUDGET } },
};
await writeFile(path.join(distRoot, "bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`[production-bundle] Entry ${rawBytes}/${gzipBytes} and initial graph ${graphRawBytes}/${graphGzipBytes} raw/gzip bytes; no E2E or eager export markers found.`);
