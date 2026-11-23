import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const SITE = new URL("../", import.meta.url);

// The browser's store of the AI calls and the copier of a server's records are chunks of their own: the bundle of the app is tight, and these are for a page that
// runs the autopilot. What the rest of the site imports is `autopilot/calls/wire.ts`, which is small and opens them lazily; types are imported as types.

const sources = [];
for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
  if (!/\.(ts|tsx)$/.test(entry)) continue;
  sources.push({ path: `src/${entry}`, name: entry, text: await readFile(new URL(`src/${entry}`, SITE), "utf8") });
}

/** The static imports (not `import type`, not `import()`) of a module of the calls folder. */
function staticImports(text, module) {
  const found = [];
  for (const match of text.matchAll(/^import\s+(?!type\b)(?:[^;]*?\bfrom\s+)?["']@\/autopilot\/calls\/([a-z]+)["']/gm)) if (match[1] === module) found.push(match[0].replace(/\s+/g, " "));
  return found;
}

test("nothing imports the store, the compression or the database helpers statically but the store itself: the rest of the site opens them with import()", () => {
  const offenders = [];
  for (const source of sources) {
    for (const module of ["store", "gzip", "idb"]) {
      if (source.name === `autopilot/calls/${module}.ts`) continue;
      // The store imports its own helpers.
      if (source.name === "autopilot/calls/store.ts" && module !== "store") continue;
      for (const found of staticImports(source.text, module)) offenders.push(`${source.path}: ${found}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("nothing imports the copier statically: the wiring module starts it with import(), and the types are imported as types", () => {
  const offenders = [];
  for (const source of sources) {
    if (source.name === "autopilot/calls/copier.ts") continue;
    for (const found of staticImports(source.text, "copier")) offenders.push(`${source.path}: ${found}`);
  }
  assert.deepEqual(offenders, []);
});

test("the session code imports only the small modules of the folder (wire, host, recording): the store loads from wire, and the copier and the copies from host, with import()", () => {
  const wire = sources.find((source) => source.name === "autopilot/calls/wire.ts");
  const host = sources.find((source) => source.name === "autopilot/calls/host.ts");
  assert.ok(wire && host);
  assert.match(wire.text, /import\("@\/autopilot\/calls\/store"\)/);
  assert.match(host.text, /import\("@\/autopilot\/calls\/copier"\)/);
  assert.match(host.text, /import\("@\/autopilot\/calls\/copies\/services"\)/);
  assert.match(host.text, /import\("@\/autopilot\/calls\/copies\/runtime"\)/);
  const runtime = sources.find((source) => source.name === "autopilot/runtime.ts");
  assert.match(runtime.text, /from "@\/autopilot\/calls\/wire"/);
  assert.match(runtime.text, /from "@\/autopilot\/calls\/host"/);
  assert.match(runtime.text, /\.\.\.wireBrowserCalls\(/);
});

test("the copies are not imported statically by anything but the settings tab and the copies themselves (their small vocabulary, `copies/types`, may be)", () => {
  const offenders = [];
  for (const source of sources) {
    if (source.name.startsWith("autopilot/calls/copies/") || source.name.startsWith("components/autopilot/config/")) continue;
    if (/^import\s+(?!type\b)[^;]*?from\s+["']@\/autopilot\/calls\/copies\/(?!types["'])/m.test(source.text)) offenders.push(source.path);
  }
  assert.deepEqual(offenders, []);
});

test("the wiring module names the one line that turns the recording on, as a literal boolean", () => {
  const wire = sources.find((source) => source.name === "autopilot/calls/wire.ts");
  assert.match(wire.text, /export const ENGINE_RECORDS_CALLS = (?:true|false);/);
});
