import assert from "node:assert/strict";
import test from "node:test";
import annotationsEn from "../src/i18n/locales/annotations.en.ts";
import annotationsIt from "../src/i18n/locales/annotations.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import shellEn from "../src/i18n/locales/shell.en.ts";
import shellIt from "../src/i18n/locales/shell.it.ts";
import localFirstEn from "../src/i18n/locales/localFirst.en.ts";

const leaves = (tree, prefix = "") => Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1]).sort();

test("the texts of the annotations have the same keys and placeholders in English and Italian, none empty, the Italian in Italian", () => {
  const italian = new Map(leaves(annotationsIt));
  assert.deepEqual([...italian.keys()].sort(), leaves(annotationsEn).map(([key]) => key).sort());
  for (const [key, value] of leaves(annotationsEn)) {
    assert.ok(value.trim(), key);
    assert.ok(italian.get(key).trim(), `${key} (it)`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
    assert.notEqual(italian.get(key), value, `${key}: not translated`);
  }
});

test("the texts of the annotations never redefine a key of the always-loaded texts, of the shell or of the local-first texts", () => {
  const ours = leaves(annotationsEn).map(([key]) => key);
  for (const locale of [eagerEn, shellEn, localFirstEn]) {
    const other = new Set(leaves(locale).map(([key]) => key));
    assert.deepEqual(ours.filter((key) => other.has(key)), []);
  }
  // Every key is under `annotations.`: the bundle loads with the reader, the list of a chapter, the badges and Settings, never with the shell.
  assert.deepEqual(ours.filter((key) => !key.startsWith("annotations.")), []);
});

test("the shortcut that annotates is in the list of the keyboard shortcuts, in both languages", () => {
  const english = new Map(leaves(shellEn));
  const italian = new Map(leaves(shellIt));
  assert.ok(english.get("shortcuts.items.annotate")?.trim());
  assert.ok(italian.get("shortcuts.items.annotate")?.trim());
  assert.notEqual(italian.get("shortcuts.items.annotate"), english.get("shortcuts.items.annotate"));
});
