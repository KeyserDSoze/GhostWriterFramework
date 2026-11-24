import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

if (process.env.NARRARIUM_E2E_BUILD === "1") process.exit(0);

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = path.join(siteRoot, "dist");
const forbidden = ["e2e-google-token", "e2e-google-user", "E2E builds use a deterministic local identity", "NARRARIUM_E2E_BUILD", "VITE_E2E", "__narrariumE2e", "E2eStorageUpgradeResult", "Simulated repository migration crash", "Simulated maintenance removal crash"];
// The limits of the entry, of the initial graph and of the routes (report.budgets.routes below) follow one rule: each is the size measured when it was
// last set, plus about 1% (rounded up to the next 1_000 raw and 500 gzip bytes). That margin is for the ordinary growth of a release or two in what
// a route already loads: new texts, a fix in a shared component, a patch release of a dependency. It is not for a new feature or a new dependency
// on a route, and it no longer has to absorb the other pages of the app: they are kept out of the entry (FIRST_VISIT_ROUTES below), so a new page
// costs the other routes only its route object, a few dozen bytes. Going over a limit is a finding, not a chore: look at what grew; if the growth is
// wanted, raise the limit in the same commit to the new size plus the same margin, and say why next to it.
// Set when the pages moved out of the entry (on 0.94.0): entry 401_552/130_526, initial graph 639_596/208_627 raw/gzip bytes.
const INITIAL_ENTRY_RAW_BUDGET = 406_000;
const INITIAL_ENTRY_GZIP_BUDGET = 132_000;
const INITIAL_GRAPH_RAW_BUDGET = 646_000;
const INITIAL_GRAPH_GZIP_BUDGET = 211_000;
// The text of each document is a chunk of its own (its source ends in `.md?raw`), loaded when the document is opened: the largest one has a limit of
// its own, so that no page of the documentation grows unseen now that the docs route no longer carries the texts.
// The largest is the engine's README, the contract of the whole engine (183_102/60_198 as a chunk in 0.94.0); the limit leaves it a quarter more to grow, and a document
// is fetched only when it is opened, so no route's weight depends on it.
const DOCUMENT_CHUNK_RAW_BUDGET = 230_000;
const DOCUMENT_CHUNK_GZIP_BUDGET = 76_000;
const baseline = { entry: { rawBytes: 2_209_160, gzipBytes: 623_927 }, initialGraph: { rawBytes: 3_243_152, gzipBytes: 913_574 } };
// Vite turns an `import()` into a call that first preloads every file the imported chunk needs, all at once (without it the browser finds them one
// level of imports at a time: up to a dozen round trips for a page of the app), and writes their names in the chunk of the call. The entry is in
// every route, so only the routes of a first visit may be imported from it with their list: the router imports every other page through
// src/routes/appPages.ts, a chunk of its own that keeps their lists. In 0.94.0 the entry carried 60 such lists, 48 of them for pages beyond the
// first visit (20_644 raw bytes with their map), and each new page made every route, the public home included, 150 to 250 bytes heavier; now it
// costs them its route object, about 35. test/routePreload.test.mjs keeps the router to this list.
const FIRST_VISIT_ROUTES = ["src/pages/public/PublicBasics.tsx", "src/pages/public/PublicDocs.tsx", "src/pages/public/McpPage.tsx", "src/routes/AuthProvidersRoute.tsx", "src/components/auth/LoginScreen.tsx", "src/pages/GitHubOAuthCallbackPage.tsx", "src/routes/AppShellRoute.tsx", "src/pages/BooksPage.tsx"];
const APP_PAGES_MODULE = "src/routes/appPages.ts";
// The map and the lists of the entry: 6_289 raw bytes when the pages moved out (163 files, almost all in the closure of the shell of the app), and room
// for about 40 more files in the closures of the routes of a first visit (each costs about 40 bytes, its name in the map and its index in a list).
const ENTRY_PRELOAD_RAW_BUDGET = 8_000;

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
/** The chunk of a source in the manifest: its own, or the one named after it when the chunking groups it with others. */
function manifestKeyOf(source) {
  const expectedName = path.basename(source, path.extname(source));
  return Object.keys(manifest).find((candidate) => candidate === source || manifest[candidate].src === source || manifest[candidate].name === expectedName);
}
// Which imports of the entry carry a list, read from the manifest as Vite computes it (with the default `build.modulePreload`): what a dynamic import
// preloads is the imported chunk, the chunks it imports in turn (not the entry, which is there already) and their CSS; one file alone has no list.
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry && manifest[key].file === entryRelative) ?? "index.html";
function preloadedWith(key) {
  const files = new Set();
  const visit = (current) => {
    const chunk = manifest[current];
    if (!chunk || current === entryKey || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit(key);
  return files;
}
const allowedLists = new Map([...FIRST_VISIT_ROUTES, APP_PAGES_MODULE].map((source) => [manifestKeyOf(source), source]));
const withList = [...new Set(manifest[entryKey]?.dynamicImports ?? [])].filter((key) => preloadedWith(key).size > 1);
const strayLists = withList.filter((key) => !allowedLists.has(key)).map((key) => manifest[key]?.src ?? key);
if (strayLists.length) throw new Error(`[production-bundle] The entry carries the preload list of ${strayLists.join(", ")}: the entry is in every route, so only the routes of a first visit (FIRST_VISIT_ROUTES) may be imported from it with their list. A page of the app is loaded through ${APP_PAGES_MODULE} (appPage("Name") in the router); anything else should be imported from a chunk that is not the entry.`);
// And what they weigh, read from the entry: the names of the files (once, in `__vite__mapDeps`) and, after each `import()`, the indices of those it needs.
const fileNames = /const __vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])\)\)\)=>i\.map\(i=>d\[i\]\);/.exec(entryText);
const lists = [...entryText.matchAll(/__vite__mapDeps\(\[[\d,]*\]\)/g)];
if (withList.length && (!fileNames || !lists.length)) throw new Error(`[production-bundle] The manifest says that ${withList.length} imports of the entry preload their files, but the entry has no preload map this check can read: Vite writes it differently now, and this check must learn the new form.`);
const entryPreload = {
  files: fileNames ? JSON.parse(fileNames[1]).length : 0,
  mapBytes: fileNames ? Buffer.byteLength(fileNames[0]) : 0,
  listBytes: lists.reduce((sum, list) => sum + Buffer.byteLength(list[0]), 0),
  routes: withList.map((key) => allowedLists.get(key)).sort(),
};
entryPreload.rawBytes = entryPreload.mapBytes + entryPreload.listBytes;
report.current.entryPreload = entryPreload;
report.budgets.entryPreload = { rawBytes: ENTRY_PRELOAD_RAW_BUDGET };
// Where the lists of the other pages went: the chunk of their loaders, asked for in the background with the shell of the app (no route waits for it
// but a page opened directly). It grows with each page by what the entry used to (120 to 230 bytes), and is reported rather than limited.
const appPagesKey = manifestKeyOf(APP_PAGES_MODULE);
if (appPagesKey) {
  const content = await readFile(path.join(distRoot, manifest[appPagesKey].file));
  report.current.appPages = { file: manifest[appPagesKey].file, rawBytes: content.byteLength, gzipBytes: gzipSync(content).byteLength, imports: new Set(manifest[appPagesKey].dynamicImports ?? []).size };
}
if (entryPreload.rawBytes > ENTRY_PRELOAD_RAW_BUDGET) throw new Error(`[production-bundle] The preload map of the entry is ${entryPreload.rawBytes} raw bytes (${entryPreload.files} files, the lists of ${entryPreload.routes.length} imports), over its ${ENTRY_PRELOAD_RAW_BUDGET}.`);
const routeSources = {
  home: "src/pages/public/PublicBasics.tsx",
  docs: "src/pages/public/PublicDocs.tsx",
  mcp: "src/pages/public/McpPage.tsx",
  login: "src/components/auth/LoginScreen.tsx",
  appShell: "src/routes/AppShellRoute.tsx",
};
const routeGraphs = {};
for (const [name, source] of Object.entries(routeSources)) {
  const key = manifestKeyOf(source);
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
// By the rule above, from the sizes measured when the pages moved out of the entry (on 0.94.0), raw/gzip: about 17_210/4_150 bytes less than in
// 0.94.0 for every public route and the sign-in, what the entry carried for the pages of the app.
report.budgets.routes = {
  home: { rawBytes: 718_000, gzipBytes: 237_500 }, // 710_852/234_987
  // The index of the documents and the page, not their texts (1_363_407/446_811 with every text inside, before they were split out).
  docs: { rawBytes: 839_000, gzipBytes: 273_000 }, // 830_444/270_211
  // The page of the MCP: the list of the tools of a book's MCP and the texts of its section load with it and with no other page (849_032/274_452 with
  // every tool of the local package and the whole docs page in it, before it was split out of the docs route).
  mcp: { rawBytes: 794_000, gzipBytes: 254_500 }, // 785_538/251_840
  login: { rawBytes: 940_000, gzipBytes: 292_500 }, // 929_737/289_244
  // Raised in 0.107.0 by the same margin (it was 2_703_000/819_500 for 2_675_530/810_894): the store of the shell follows the text of the step that runs
  // by the engine's own rule (applyLiveProgress, a chunk of 1_568/614 bytes it shares with the autopilot), so that no panel can disagree with the engine.
  appShell: { rawBytes: 2_718_000, gzipBytes: 829_000 }, // 2_690_427/819_920
};
for (const [name, budget] of Object.entries(report.budgets.routes)) {
  const actual = routeGraphs[name];
  if (actual.rawBytes > budget.rawBytes || actual.gzipBytes > budget.gzipBytes) throw new Error(`[production-bundle] ${name} route graph ${actual.rawBytes}/${actual.gzipBytes} exceeds ${budget.rawBytes}/${budget.gzipBytes} raw/gzip bytes.`);
}
const documents = await Promise.all(Object.entries(manifest).filter(([key, entry]) => (entry.src ?? key).endsWith(".md?raw")).map(async ([key, entry]) => {
  const content = await readFile(path.join(distRoot, entry.file));
  return { file: entry.file, source: entry.src ?? key, rawBytes: content.byteLength, gzipBytes: gzipSync(content).byteLength };
}));
documents.sort((left, right) => right.rawBytes - left.rawBytes || left.file.localeCompare(right.file));
report.current.documents = { count: documents.length, rawBytes: documents.reduce((sum, document) => sum + document.rawBytes, 0), gzipBytes: documents.reduce((sum, document) => sum + document.gzipBytes, 0), largest: documents[0] ?? null };
report.budgets.document = { rawBytes: DOCUMENT_CHUNK_RAW_BUDGET, gzipBytes: DOCUMENT_CHUNK_GZIP_BUDGET };
for (const document of documents) {
  if (document.rawBytes > DOCUMENT_CHUNK_RAW_BUDGET || document.gzipBytes > DOCUMENT_CHUNK_GZIP_BUDGET) throw new Error(`[production-bundle] Document chunk ${document.file} (${document.source}) ${document.rawBytes}/${document.gzipBytes} exceeds ${DOCUMENT_CHUNK_RAW_BUDGET}/${DOCUMENT_CHUNK_GZIP_BUDGET} raw/gzip bytes.`);
}
await writeFile(path.join(distRoot, "bundle-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await rm(path.join(distRoot, ".vite"), { recursive: true, force: true });

console.log(`[production-bundle] Entry ${rawBytes}/${gzipBytes} and initial graph ${graphRawBytes}/${graphGzipBytes} raw/gzip bytes; preload map of the entry ${entryPreload.rawBytes}/${ENTRY_PRELOAD_RAW_BUDGET} raw bytes (${entryPreload.files} files, the lists of ${entryPreload.routes.length} imports); no E2E or eager export markers found.`);
