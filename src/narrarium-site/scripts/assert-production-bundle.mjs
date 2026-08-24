import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

if (process.env.NARRARIUM_E2E_BUILD === "1") process.exit(0);

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, "dist");
const forbidden = ["e2e-google-token", "e2e-google-user", "E2E builds use a deterministic local identity", "NARRARIUM_E2E_BUILD", "VITE_E2E", "__narrariumE2e", "E2eStorageUpgradeResult", "Simulated repository migration crash", "Simulated maintenance removal crash"];
const INITIAL_ENTRY_RAW_BUDGET = 450_000;
const INITIAL_ENTRY_GZIP_BUDGET = 150_000;
const INITIAL_GRAPH_RAW_BUDGET = 700_000;
const INITIAL_GRAPH_GZIP_BUDGET = 240_000;
const baseline = { entry: { rawBytes: 2_209_160, gzipBytes: 623_927 }, initialGraph: { rawBytes: 3_243_152, gzipBytes: 913_574 } };

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
const forbiddenPreload = preloads.find((href) => /auth|ai-vendor|github|zip|docs|BookExport|pdfFonts|jspdf|repository/i.test(href));
if (forbiddenPreload) throw new Error(`[production-bundle] Optional feature chunk '${forbiddenPreload}' leaked into the initial HTML preload graph.`);
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
const manifestPath = path.join(distRoot, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const routeSources = {
  home: "src/pages/public/PublicBasics.tsx",
  docs: "src/pages/public/PublicDocs.tsx",
  login: "src/components/auth/LoginScreen.tsx",
  appShell: "src/routes/AppShellRoute.tsx",
};
const routeGraphs = {};
for (const [name, source] of Object.entries(routeSources)) {
  const expectedName = path.basename(source, path.extname(source));
  const key = Object.keys(manifest).find((candidate) => candidate === source || manifest[candidate].src === source || manifest[candidate].name === expectedName);
  if (!key) throw new Error(`[production-bundle] Route manifest entry not found for ${source}.`);
  const files = new Set();
  const visit = (entryKey) => {
    const entry = manifest[entryKey];
    if (!entry || files.has(entry.file)) return;
    files.add(entry.file);
    for (const dependency of entry.imports ?? []) visit(dependency);
  };
  visit(key);
  const paths = [...files].map((file) => path.join(distRoot, file));
  const buffers = await Promise.all(paths.map((file) => readFile(file)));
  routeGraphs[name] = { files: [...files].sort(), rawBytes: buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0), gzipBytes: buffers.reduce((sum, buffer) => sum + gzipSync(buffer).byteLength, 0) };
}
report.current.routes = routeGraphs;
report.budgets.routes = {
  home: { rawBytes: 730_000, gzipBytes: 240_000 },
  docs: { rawBytes: 850_000, gzipBytes: 280_000 },
  login: { rawBytes: 960_000, gzipBytes: 295_000 },
  appShell: { rawBytes: 2_850_000, gzipBytes: 850_000 },
};
for (const [name, budget] of Object.entries(report.budgets.routes)) {
  const actual = routeGraphs[name];
  if (actual.rawBytes > budget.rawBytes || actual.gzipBytes > budget.gzipBytes) throw new Error(`[production-bundle] ${name} route graph ${actual.rawBytes}/${actual.gzipBytes} exceeds ${budget.rawBytes}/${budget.gzipBytes} raw/gzip bytes.`);
}
await writeFile(path.join(distRoot, "bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await rm(path.join(distRoot, ".vite"), { recursive: true, force: true });

console.log(`[production-bundle] Entry ${rawBytes}/${gzipBytes} and initial graph ${graphRawBytes}/${graphGzipBytes} raw/gzip bytes; no E2E or eager export markers found.`);
