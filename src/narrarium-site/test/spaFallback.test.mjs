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

test("SPA fallback emits physical 200 entry points for update and patch-note routes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "narrarium-spa-fallback-"));
  try {
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    await mkdir(scripts);
    await mkdir(dist);
    const source = new URL("../scripts/write-spa-fallback.mjs", import.meta.url);
    const script = path.join(scripts, "write-spa-fallback.mjs");
    await writeFile(script, await readFile(source));
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Narrarium</title>");

    await run(script, root);

    for (const file of ["404.html", "app/index.html", "app/patch-notes/index.html", "login/index.html"]) {
      assert.equal(await readFile(path.join(dist, file), "utf8"), "<!doctype html><title>Narrarium</title>");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(path.join(dist, "index.html"), "index");
    await writeFile(path.join(dist, "assets", "entry.js"), "entry");
    await writeFile(path.join(dist, "assets", "style.css"), "style");
    await writeFile(path.join(dist, "assets", "worker.js"), "worker");
    const source = new URL("../scripts/generate-precache.mjs", import.meta.url);
    const script = path.join(scripts, "generate-precache.mjs");
    await writeFile(script, await readFile(source));

    await run(script, root);

    const manifest = await readFile(path.join(dist, "precache-manifest.js"), "utf8");
    assert.match(manifest, /__NARRARIUM_RELEASE__="1\.2\.3"/);
    for (const file of ["index.html", "assets/entry.js", "assets/style.css", "assets/worker.js"]) assert.match(manifest, new RegExp(file.replace(".", "\\.")));
    assert.doesNotMatch(manifest, /precache-manifest\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service worker uses release caches, precaches the generated manifest, and preserves unrelated caches", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /importScripts\(`\.\/precache-manifest\.js\?v=\$\{encodeURIComponent\(REQUESTED_RELEASE\)\}`\)/);
  assert.match(source, /const RELEASE = REQUESTED_RELEASE/);
  assert.match(source, /Precache release mismatch/);
  assert.match(source, /narrarium-precache-\$\{RELEASE\}/);
  assert.match(source, /new Request\(scopeUrl\(\), \{ cache: "reload" \}\)/);
  assert.match(source, /key\.startsWith\(OWNED_CACHE_PREFIX\)/);
  assert.match(source, /MAX_RUNTIME_ENTRIES = 64/);
  assert.match(source, /\["script", "style", "worker", "image", "font"\]\.includes\(request\.destination\)/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /caches\.open\(PRECACHE_NAME\)[\s\S]*cache\.match\(scopeUrl\(\)\)[\s\S]*return fetch\(request\)/);
  assert.doesNotMatch(source, /request\.mode === "navigate"[\s\S]*fetch\(request\)[\s\S]*cache\.match\(scopeUrl\(\)\)/);
});

test("service-worker registration bypasses the HTTP cache for root and imported script updates", async () => {
  const source = await readFile(new URL("../src/pwa.ts", import.meta.url), "utf8");
  assert.equal((source.match(/updateViaCache: "none"/g) ?? []).length, 2);
  assert.match(source, /version\.json\?_=/);
  assert.match(source, /fetch\(versionUrl, \{ cache: "no-store" \}\)/);
});
