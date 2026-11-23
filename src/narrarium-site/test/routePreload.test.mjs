import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const router = await read("src/router.tsx");
const appPages = await read("src/routes/appPages.ts").catch(() => "");
const bundleCheck = await read("scripts/assert-production-bundle.mjs");

/**
 * Vite writes, in the chunk where an `import()` is, the list of every file the imported chunk needs (to preload them together). The router is in the
 * entry, which every route loads, the public home included: the routes of a first visit are imported by the router itself, every other page through
 * `src/routes/appPages.ts`, whose chunk keeps their lists. The build checks the entry against the same list (FIRST_VISIT_ROUTES in
 * scripts/assert-production-bundle.mjs): a route added there is a choice, paid by every route.
 */
const listed = (name) => {
  const match = new RegExp(`const ${name} = (\\[[^\\]]*\\]|"[^"]*");`).exec(bundleCheck);
  assert.ok(match, `${name} is in scripts/assert-production-bundle.mjs`);
  return JSON.parse(match[1]);
};
const specifierOf = (source) => source.replace(/^src\//, "@/").replace(/\.tsx?$/, "");
const FIRST_VISIT = listed("FIRST_VISIT_ROUTES").map(specifierOf);
const APP_PAGES = specifierOf(listed("APP_PAGES_MODULE"));

const importsOf = (source) => [...source.matchAll(/import\("([^"]+)"\)/g)].map((match) => match[1]);

test("the router imports by itself the routes of a first visit, each once, and the loaders of the other pages", () => {
  assert.equal(APP_PAGES, "@/routes/appPages");
  assert.ok(FIRST_VISIT.length >= 8 && FIRST_VISIT.includes("@/pages/public/PublicBasics") && FIRST_VISIT.includes("@/routes/AppShellRoute"), FIRST_VISIT.join(", "));
  const imported = importsOf(router);
  assert.deepEqual(imported.filter((module) => module !== APP_PAGES && !FIRST_VISIT.includes(module)), [], "a page beyond the first visit is loaded through src/routes/appPages.ts");
  assert.deepEqual(imported.filter((module, index) => imported.indexOf(module) !== index), [], "one import() for each module: every call carries its own list of files");
  assert.deepEqual([...FIRST_VISIT, APP_PAGES].filter((module) => !imported.includes(module)), [], "every route the build allows a list to is one the router imports");
  assert.doesNotMatch(router, /^import (?!type )[^;]*from "@\/routes\/appPages";/m, "the loaders of the pages are not part of the entry");
});

test("every page of the app beyond its first page is in the loaders, once, and every loader is a page of a route", () => {
  assert.ok(appPages, "src/routes/appPages.ts exists");
  const names = [...appPages.matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]);
  assert.ok(names.length >= 30, `the loaders of the pages are listed (${names.length})`);
  assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], "one loader for each name");
  const used = [...router.matchAll(/appPage\("(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(used)].filter((name) => !names.includes(name)).sort(), [], "every page a route names has a loader");
  assert.deepEqual(names.filter((name) => !used.includes(name)).sort(), [], "every loader is used by a route");
  const modules = importsOf(appPages);
  assert.deepEqual(modules.filter((module, index) => modules.indexOf(module) !== index), [], "one import() for each module in the loaders too");
  assert.deepEqual(modules.filter((module) => FIRST_VISIT.includes(module)), [], "the routes of a first visit are not loaded a second way");
});

test("the loaders of the pages are asked for with the shell of the app, so that opening a page later costs no request more", () => {
  assert.match(router, /const appShell = \(\) => \{\s*void loadAppPages\(\)/);
  assert.match(router, /path: "\/app", lazy: appShell,/);
});
