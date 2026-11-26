import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import designEn from "../src/i18n/locales/design.en.ts";
import designIt from "../src/i18n/locales/design.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** The files of the tabs of the Synopsis page that show these texts. */
function tabFiles() {
  return ["components/outline/bible", "components/outline/studio"].flatMap((folder) => {
    const url = new URL(`../src/${folder}/`, import.meta.url);
    return existsSync(url) ? readdirSync(url).filter((name) => /\.tsx?$/.test(name)).map((name) => `${folder}/${name}`) : [];
  });
}

test("the texts of the tabs speak both languages, with the same keys and the same placeholders", () => {
  const english = new Map(leaves(designEn));
  const italian = new Map(leaves(designIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of the tabs is written in Italian, not copied from English", () => {
  const italian = new Map(leaves(designIt));
  assert.deepEqual(leaves(designEn).filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("every text the tabs ask for is in the catalogue, the labels of the facts of the canon and the parts of the Bible included", () => {
  const english = new Map(leaves(designEn));
  const files = tabFiles();
  const used = files.flatMap((file) => [...source(file).matchAll(/\bt\("(design\.[\w.]+)"/g)].map((match) => match[1]));
  assert.ok(used.length > 10, `texts read: ${used.length}`);
  // A plural is asked for by its stem: its `_one` and `_other` say it.
  assert.deepEqual(used.filter((key) => !english.has(key) && !english.has(`${key}_other`)), []);
  const facts = /const FACTS[^=]*= \{([\s\S]*?)\n\};/.exec(source("outline/bibleModel.ts"));
  assert.ok(facts, "the Bible declares the facts it shows");
  const keys = [...facts[1].matchAll(/"(\w+)"/g)].map((match) => match[1]);
  assert.ok(keys.includes("arc") && keys.includes("significance"), `facts read: ${keys.join(", ")}`);
  for (const key of keys) assert.ok(english.has(`design.bible.fields.${key}`), key);
  const sections = /const SECTION_IDS = \{([^}]+)\}/.exec(source("components/outline/bible/BibleTab.tsx"));
  assert.ok(sections, "the Bible declares its parts");
  for (const [, key] of sections[1].matchAll(/(\w+): "/g)) assert.ok(english.has(`design.bible.sections.${key}`), key);
  for (const key of ["cast", "places", "factions", "items", "secrets"]) assert.ok(english.has(`design.bible.empty.${key}`), key);
});

test("the texts of the tabs come with them, never with the app or with the Synopsis page", () => {
  assert.equal("design" in en, false);
  assert.equal("design" in it, false);
  assert.doesNotMatch(source("pages/OutlinePage.tsx"), /@\/i18n\/design/);
  const tabs = tabFiles().filter((name) => /Tab\.tsx$/.test(name));
  assert.ok(tabs.length > 0);
  for (const file of tabs) assert.match(source(file), /^import "@\/i18n\/design";$/m, file);
});
