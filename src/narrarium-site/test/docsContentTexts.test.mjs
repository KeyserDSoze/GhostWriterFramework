import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";
import textsEn from "../src/i18n/locales/docsContent.en.ts";
import textsIt from "../src/i18n/locales/docsContent.it.ts";

const SITE = new URL("../", import.meta.url);
const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
const placeholders = (text) => Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

test("the texts of a document that loads or fails exist in both languages, translated, under their own name", () => {
  assert.deepEqual(Object.keys(textsEn), ["docsContent"]);
  assert.deepEqual(Object.keys(textsIt), ["docsContent"]);
  assert.deepEqual(leaves(textsIt).sort(), leaves(textsEn).sort());
  for (const key of leaves(textsEn)) {
    assert.ok(lookup(textsEn, key).trim() && lookup(textsIt, key).trim(), `${key} is not empty`);
    assert.notEqual(lookup(textsIt, key), lookup(textsEn, key), `${key} is translated`);
    assert.deepEqual(placeholders(lookup(textsIt, key)), placeholders(lookup(textsEn, key)), `${key}: same placeholders`);
  }
  assert.equal(textsEn.docsContent.retry, "Retry");
  assert.equal(textsIt.docsContent.retry, "Riprova");
  assert.match(textsEn.docsContent.error.body, /connection/);
  assert.match(textsEn.docsContent.error.body, /reload/);
  assert.match(textsIt.docsContent.error.body, /connessione/);
  assert.match(textsIt.docsContent.error.body, /ricarica/);
});

test("the texts are not in the catalogue of the app entry, and only the content of a document imports them", async () => {
  for (const entry of [/** @type {Record<string, unknown>} */ (entryEn), /** @type {Record<string, unknown>} */ (entryIt)]) assert.equal(entry.docsContent, undefined);
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    const relative = `src/${entry.split("\\").join("/")}`;
    if (!/\.(ts|tsx)$/.test(relative)) continue;
    if (/["']@\/i18n\/docsContent["']|locales\/docsContent\./.test(await readFile(new URL(relative, SITE), "utf8"))) importers.push(relative);
  }
  assert.deepEqual(importers.sort(), ["src/components/docs/DocContent.tsx", "src/i18n/docsContent.ts"]);
});
