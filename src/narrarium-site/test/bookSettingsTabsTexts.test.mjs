import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/bookSettingsTabs.en.ts";
import it from "../src/i18n/locales/bookSettingsTabs.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import bookGithubEn from "../src/i18n/locales/bookGithub.en.ts";

const leaves = (tree, prefix = "") => Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1]).sort();

test("the texts of the tabs of a book's settings have the same keys and placeholders in English and Italian, none empty", () => {
  const italian = new Map(leaves(it));
  assert.deepEqual([...italian.keys()].sort(), leaves(en).map(([key]) => key).sort());
  for (const [key, value] of leaves(en)) {
    assert.ok(value.trim(), key);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian is Italian, except the names that are the same in both", () => {
  const italian = new Map(leaves(it));
  assert.deepEqual(leaves(en).filter(([key, value]) => italian.get(key) === value).map(([key]) => key).sort(), ["bookSettings.tabs.audit", "bookSettings.tabs.github", "bookSettings.tabs.repositoryTitle"]);
});

test("they never redefine a key of the always-loaded texts or of the connect card", () => {
  for (const locale of [eagerEn, bookGithubEn]) {
    const other = new Set(leaves(locale).map(([key]) => key));
    assert.deepEqual(leaves(en).map(([key]) => key).filter((key) => other.has(key)), []);
  }
});
