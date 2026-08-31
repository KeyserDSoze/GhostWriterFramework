import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

function run(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Fallback generator exited with ${code}.`)));
  });
}

test("SPA fallback emits physical 200 entry points for finite public routes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-spa-fallback-"));
  try {
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    await mkdir(scripts);
    await mkdir(dist);
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    const source = new URL("../scripts/write-spa-fallback.mjs", import.meta.url);
    const script = path.join(scripts, "write-spa-fallback.mjs");
    await writeFile(script, await readFile(source));
    await writeFile(path.join(root, "src", "lib", "public-doc-routes.json"), JSON.stringify(["overview", "reader-password"]));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Narrarium</title>");

    await run(script, root);

    for (const file of [
      "404.html",
      "app/index.html",
      "app/patch-notes/index.html",
      "login/index.html",
      "docs/index.html",
      "docs/overview/index.html",
      "docs/reader-password/index.html",
      "mcp/index.html",
      "privacy/index.html",
      "terms/index.html",
    ]) {
      assert.equal(await readFile(path.join(dist, file), "utf8"), "<!doctype html><title>Narrarium</title>");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Pages dynamic deep-link behavior is documented as an accepted hosting contract", async () => {
  const contract = await readFile(new URL("../../../docs/deployment-routing.md", import.meta.url), "utf8");
  assert.match(contract, /GitHub Pages returns the shared `404\.html` application shell/);
  assert.match(contract, /initial origin status is therefore 404/);
  assert.match(contract, /explicitly chosen to remain entirely on GitHub Pages/);
  assert.match(contract, /server-side SPA fallback/);
});

test("service-worker updates wire patch-note requests to the physical route instead of public home", async () => {
  const source = await readFile(new URL("../src/pwa.ts", import.meta.url), "utf8");
  assert.match(source, /controllerchange[\s\S]*handleServiceWorkerControllerChange/);
  assert.match(source, /browserLocation\.replace\(patchNotesPhysicalUrl\(baseUrl\)\)/);
  assert.doesNotMatch(source, /OPEN_PATCH_NOTES[\s\S]*location\.(?:replace|assign)\(import\.meta\.env\.BASE_URL\s*\|\|\s*["']\/["']\)/);
});

test("precache generation includes application entry points, chunks, styles, and workers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-precache-"));
  try {
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    await mkdir(scripts);
    await mkdir(path.join(dist, "assets"), { recursive: true });
    await mkdir(path.join(dist, "docs", "reader-password"), { recursive: true });
    await mkdir(path.join(dist, ".vite"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(path.join(dist, "index.html"), "index");
    await writeFile(path.join(dist, "docs", "index.html"), "docs");
    await writeFile(path.join(dist, "docs", "reader-password", "index.html"), "reader-password");
    await writeFile(path.join(dist, "assets", "entry.js"), "entry");
    await writeFile(path.join(dist, "assets", "style.css"), "style");
    await writeFile(path.join(dist, "assets", "worker.js"), "worker");
    await writeFile(path.join(dist, "assets", "docx-index.js"), "docx");
    await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify({
      "../../node_modules/docx/dist/index.mjs": { file: "assets/docx-index.js", name: "index", isDynamicEntry: true },
      "src/main.tsx": { file: "assets/entry.js", src: "src/main.tsx", isEntry: true, imports: ["framework"] },
      framework: { file: "assets/framework.js" },
      "src/pages/public/PublicBasics.tsx": { file: "assets/home.js", src: "src/pages/public/PublicBasics.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/pages/public/PublicDocs.tsx": { file: "assets/docs.js", src: "src/pages/public/PublicDocs.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/routes/AuthProvidersRoute.tsx": { file: "assets/auth.js", name: "AuthProvidersRoute", src: "src/routes/AuthProvidersRoute.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/routes/AppShellRoute.tsx": { file: "assets/app-shell.js", name: "AppShellRoute", src: "src/routes/AppShellRoute.tsx", isDynamicEntry: true, imports: ["framework"] },
      "src/pages/BooksPage.tsx": { file: "assets/books.js", name: "BooksPage", src: "src/pages/BooksPage.tsx", isDynamicEntry: true, imports: ["framework"] },
    }));
    await writeFile(path.join(dist, "assets", "framework.js"), "framework");
    await writeFile(path.join(dist, "assets", "home.js"), "home");
    await writeFile(path.join(dist, "assets", "docs.js"), "docs");
    await writeFile(path.join(dist, "assets", "auth.js"), "auth");
    await writeFile(path.join(dist, "assets", "app-shell.js"), "app-shell");
    await writeFile(path.join(dist, "assets", "books.js"), "books");
    const source = new URL("../scripts/generate-precache.mjs", import.meta.url);
    const script = path.join(scripts, "generate-precache.mjs");
    await writeFile(script, await readFile(source));

    await run(script, root);

    const manifest = await readFile(path.join(dist, "precache-manifest.js"), "utf8");
    const precache = JSON.parse(/__NARRARIUM_PRECACHE__=(\[[^;]+\])/.exec(manifest)?.[1] ?? "[]");
    assert.match(manifest, /__NARRARIUM_RELEASE__="1\.2\.3"/);
    for (const file of ["index.html", "docs/index.html", "docs/reader-password/index.html", "assets/entry.js", "assets/framework.js", "assets/home.js", "assets/docs.js"]) assert.match(manifest, new RegExp(file.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")));
    assert.doesNotMatch(precache.join("\n"), /docx-index/);
    assert.match(manifest, /__NARRARIUM_OPTIONAL_ASSETS__/);
    for (const file of ["assets/auth.js", "assets/app-shell.js", "assets/books.js"]) assert.match(manifest, new RegExp(file.replace(".", "\\.")));
    assert.match(manifest, /assets\/worker\.js/);
    assert.doesNotMatch(manifest, /precache-manifest\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service worker uses release caches, precaches the generated manifest, and preserves unrelated caches", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /importScripts\(`\.\/precache-manifest\.js\?v=\$\{encodeURIComponent\(REQUESTED_RELEASE\)\}`\)/);
  assert.match(source, /const RELEASE = REQUESTED_RELEASE/);
  assert.match(source, /Precache release mismatch/);
  assert.match(source, /narrarium-precache-\$\{RELEASE\}/);
  assert.match(source, /new Request\(scopeUrl\(\), \{ cache: "reload" \}\)/);
  assert.match(source, /key\.startsWith\(OWNED_CACHE_PREFIX\)/);
  assert.match(source, /MAX_RUNTIME_ENTRIES = 192/);
  assert.match(source, /new URL\("assets\/", scopeUrl\(\)\)\.pathname/);
  assert.match(source, /url\.pathname\.startsWith\(assetRoot\)/);
  assert.match(source, /ignoreVary: true/);
  assert.match(source, /CACHE_APP_SHELL_ASSETS/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /url\.pathname === microsoftPopupPath/);
  assert.match(source, /fetch\(request, \{ cache: "no-store" \}\)/);
  assert.ok(source.indexOf("url.pathname === microsoftPopupPath") < source.indexOf('if (request.mode === "navigate") {\n    event.respondWith(\n      caches.open'));
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /caches\.open\(PRECACHE_NAME\)[\s\S]*cache\.match\(scopeUrl\(\)\)[\s\S]*return fetch\(request\)/);
  assert.doesNotMatch(source, /request\.mode === "navigate"[\s\S]*fetch\(request\)[\s\S]*cache\.match\(scopeUrl\(\)\)/);
});

test("Microsoft popup callback runs the MSAL redirect bridge outside the SPA", async () => {
  const callback = await readFile(new URL("../msal-popup.html", import.meta.url), "utf8");
  const bridge = await readFile(new URL("../src/msalPopup.ts", import.meta.url), "utf8");
  const vite = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(callback, /src="\/src\/msalPopup\.ts"/);
  assert.match(bridge, /@azure\/msal-browser\/redirect-bridge/);
  assert.match(bridge, /broadcastResponseToMainFrame\(\)/);
  assert.match(vite, /"msal-popup": path\.resolve\(__dirname, "msal-popup\.html"\)/);
});

test("service-worker registration bypasses the HTTP cache for root and imported script updates", async () => {
  const source = await readFile(new URL("../src/pwa.ts", import.meta.url), "utf8");
  assert.equal((source.match(/updateViaCache: "none"/g) ?? []).length, 2);
  assert.match(source, /version\.json\?_=/);
  assert.match(source, /fetch\(versionUrl, \{ cache: "no-store" \}\)/);
});

test("the paragraph overview uses the shared interactive prose-assist dialog", async () => {
  const source = await readFile(new URL("../src/pages/ParagraphPage.tsx", import.meta.url), "utf8");
  assert.match(source, /useProseAssist\(\{/);
  assert.match(source, /\{proseAssist\.dialogs\}/);
  assert.doesNotMatch(source, /<FileDiff previous=\{improveSelection/);
  assert.doesNotMatch(source, /function regenerateImprove\(/);
});

test("route splitting keeps accessible loading and error fallbacks", async () => {
  const router = await readFile(new URL("../src/router.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const loading = await readFile(new URL("../src/components/layout/RouteLoadingFallback.tsx", import.meta.url), "utf8");
  const error = await readFile(new URL("../src/components/layout/RouteErrorFallback.tsx", import.meta.url), "utf8");
  assert.match(router, /lazy:\s*component\(/);
  assert.match(router, /errorElement:\s*routeError/);
  assert.doesNotMatch(app, /fallbackElement=/);
  assert.match(router, /HydrateFallback:\s*RouteLoadingFallback/);
  assert.match(loading, /role="status"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(error, /role="alert"/);
});

test("repository maintenance loads JSZip only inside backup operations", async () => {
  const source = await readFile(new URL("../src/repository/repositoryMaintenance.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import JSZip from "jszip";/m);
  assert.match(source, /import type JSZip from "jszip"/);
  assert.equal((source.match(/await import\("jszip"\)/g) ?? []).length, 2);
});

test("authenticated startup does not warm the app shell again after route assets loaded", async () => {
  const route = await readFile(new URL("../src/routes/AppShellRoute.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(route, /cacheAppShellPwaAssets/);
});
