import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import outlineEn from "../src/i18n/locales/outline.en.ts";
import outlineIt from "../src/i18n/locales/outline.it.ts";
import outlineCopilotEn from "../src/i18n/locales/outlineCopilot.en.ts";
import outlineCopilotIt from "../src/i18n/locales/outlineCopilot.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const englishTexts = () => [...leaves(outlineEn), ...leaves(outlineCopilotEn)];
const italianTexts = () => [...leaves(outlineIt), ...leaves(outlineCopilotIt)];

test("the Outline speaks both languages, with the same texts and the same placeholders", () => {
  const english = new Map(englishTexts());
  const italian = new Map(italianTexts());
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of the Outline is written in Italian, not copied from English", () => {
  // The words that are the same in both languages: the name of a profile and a label of one word.
  const same = new Set(["outline.entry.ghostwriterLabel"]);
  const italian = new Map(italianTexts());
  const copied = englishTexts().filter(([key, value]) => !same.has(key) && italian.get(key) === value).map(([key]) => key);
  assert.deepEqual(copied, []);
  assert.equal(outlineIt.outline.title, "Scaletta");
  assert.equal(outlineEn.outline.title, "Outline");
});

test("the app entry carries only the menu label of the Outline: its page brings the rest", () => {
  assert.equal(en.nav.outline, "Outline");
  assert.equal(it.nav.outline, "Scaletta");
  assert.equal("outline" in en, false);
  assert.equal("outline" in it, false);
  const page = readFileSync(new URL("../src/pages/OutlinePage.tsx", import.meta.url), "utf8");
  assert.match(page, /^import "@\/i18n\/outline";$/m, "the page loads its texts with it");
});

test("the Copilot panel brings only the few texts of the Outline it shows, not those of the whole page", () => {
  const panel = readFileSync(new URL("../src/components/assistant/AssistantPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /^import "@\/i18n\/outlineCopilot";$/m);
  assert.doesNotMatch(panel, /^import "@\/i18n\/outline";$/m);
  const used = [...panel.matchAll(/t\("(outline\.[\w.]+)"/g)].map((match) => match[1]);
  assert.ok(used.length > 0);
  const english = new Map(leaves(outlineCopilotEn));
  assert.deepEqual(used.filter((key) => !english.has(key)), [], "every text of the Outline the panel shows is in its catalogue");
  assert.equal("copilot" in outlineEn.outline, false, "each text has one home");
});
