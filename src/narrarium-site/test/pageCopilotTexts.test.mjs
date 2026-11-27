import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import pageCopilotEn from "../src/i18n/locales/pageCopilot.en.ts";
import pageCopilotIt from "../src/i18n/locales/pageCopilot.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the page-aware Copilot speaks both languages, with the same keys and the same placeholders", () => {
  const english = new Map(leaves(pageCopilotEn));
  const italian = new Map(leaves(pageCopilotIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("its Italian is written in Italian, not copied from English", () => {
  // A word that is the same in both languages (a name, a label of one word) is said here.
  const same = new Set(["pageCopilot.pages.ghostwriters", "pageCopilot.pages.assets"]);
  const italian = new Map(leaves(pageCopilotIt));
  const words = (text) => /\p{L}/u.test(text.replace(/\{\{[^}]*\}\}/g, ""));
  assert.deepEqual(leaves(pageCopilotEn).filter(([key, value]) => !same.has(key) && italian.get(key) === value && words(value)).map(([key]) => key), []);
});

test("its texts come with the Copilot panel, never with the app", () => {
  assert.equal("pageCopilot" in en, false);
  assert.equal("pageCopilot" in it, false);
  assert.match(source("components/assistant/AssistantPanel.tsx"), /^import "@\/i18n\/pageCopilot";$/m);
  // Every page of the registry has its name in both languages.
  const registry = source("assistant/pages/registry.ts");
  const pages = [...registry.matchAll(/^\s+(?:"([\w-]+)"|([\w-]+)): \(\) => import\(/gm)].map((match) => match[1] ?? match[2]);
  assert.ok(pages.includes("readers"), `pages read: ${pages.join(", ")}`);
  for (const id of pages) {
    assert.equal(typeof pageCopilotEn.pageCopilot.pages[id], "string", id);
    assert.equal(typeof pageCopilotIt.pageCopilot.pages[id], "string", id);
  }
});
