import assert from "node:assert/strict";
import test from "node:test";
import pageEn from "../src/i18n/locales/annotationsPage.en.ts";
import pageIt from "../src/i18n/locales/annotationsPage.it.ts";
import annotationsEn from "../src/i18n/locales/annotations.en.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import shellEn from "../src/i18n/locales/shell.en.ts";
import shellIt from "../src/i18n/locales/shell.it.ts";

const leaves = (tree, prefix = "") => Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1]).sort();

test("the texts of the notes page have the same keys and placeholders in English and Italian, none empty, the Italian translated", () => {
  const italian = new Map(leaves(pageIt));
  assert.deepEqual([...italian.keys()].sort(), leaves(pageEn).map(([key]) => key).sort());
  for (const [key, value] of leaves(pageEn)) {
    assert.ok(value.trim(), key);
    assert.ok(italian.get(key).trim(), `${key} (it)`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
    if (value.length > 12) assert.notEqual(italian.get(key), value, `${key}: not translated`);
  }
});

test("the notes page texts live under annotationsPage and never redefine another bundle's key", () => {
  const ours = leaves(pageEn).map(([key]) => key);
  assert.deepEqual(ours.filter((key) => !key.startsWith("annotationsPage.")), []);
  for (const locale of [eagerEn, shellEn, annotationsEn]) {
    const other = new Set(leaves(locale).map(([key]) => key));
    assert.deepEqual(ours.filter((key) => other.has(key)), []);
  }
});

test("the menu entry of the notes of a book is in the always-loaded shell texts, in both languages", () => {
  assert.equal(shellEn.nav.bookAnnotations, "Annotations");
  assert.equal(shellIt.nav.bookAnnotations, "Appunti");
});

test("the guide of the reader describes the notes page and the triage keys in both languages", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name) => readFileSync(new URL(`../src/content/guides/${name}`, import.meta.url), "utf8");
  const english = read("reader-export.en.md");
  const italian = read("reader-export.it.md");
  for (const word of ["**Annotations** page", pageEn.annotationsPage.fix.title.replace(/^/, "**").concat("**"), "**Let's reason together**", "**Go through them one by one**", "**H** handled", "**S** skip"]) assert.ok(english.includes(word), `en: ${word}`);
  for (const word of ["pagina **Appunti**", `**${pageIt.annotationsPage.fix.title}**`, "**Ragioniamo insieme**", "**Passali uno per uno**", "**H** fatto", "**S** salta"]) assert.ok(italian.includes(word), `it: ${word}`);
});
