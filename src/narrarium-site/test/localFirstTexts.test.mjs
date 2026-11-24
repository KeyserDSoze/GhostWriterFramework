import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import localFirstEn from "../src/i18n/locales/localFirst.en.ts";
import localFirstIt from "../src/i18n/locales/localFirst.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const SITE = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, SITE), "utf8");

test("what a book kept on this device, or offline, says speaks both languages, with the same texts and the same placeholders", () => {
  const english = new Map(leaves(localFirstEn));
  const italian = new Map(leaves(localFirstIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of those texts is written in Italian, not copied from English", () => {
  const italian = new Map(leaves(localFirstIt));
  assert.deepEqual(leaves(localFirstEn).filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("the texts travel with the shell of the app, not with its entry", () => {
  for (const tree of [en, it]) assert.equal("localFirst" in tree, false);
  for (const file of ["src/components/layout/Topbar.tsx", "src/components/layout/FloatingActions.tsx", "src/components/repository/RepositoryStatusDialog.tsx"]) {
    assert.match(source(file), /import "@\/i18n\/localFirst";/, file);
  }
});

test("every localFirst key the app uses exists", () => {
  const files = ["src/components/layout/Topbar.tsx", "src/components/layout/FloatingActions.tsx", "src/components/repository/RepositoryStatusDialog.tsx", "src/pages/BookSettingsPage.tsx", "src/pages/BookDashboardPage.tsx", "src/hooks/useBookStructure.ts", "src/components/assistant/AssistantPanel.tsx"];
  const keys = new Set(leaves(localFirstEn).map(([key]) => key));
  for (const file of files) {
    for (const match of source(file).matchAll(/"(localFirst\.[A-Za-z.]+)"/g)) assert.ok(keys.has(match[1]), `${file}: ${match[1]}`);
  }
});

test("the stale warning about a missing token no longer says the book will not load: it loads from this device", () => {
  assert.doesNotMatch(en.bookSettings.noTokenWarning, /will not load/);
  assert.doesNotMatch(it.bookSettings.noTokenWarning, /non verrà caricato/);
});
