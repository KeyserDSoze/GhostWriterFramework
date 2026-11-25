import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import brainstormEn from "../src/i18n/locales/brainstorm.en.ts";
import brainstormIt from "../src/i18n/locales/brainstorm.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Brainstorming speaks both languages, with the same texts and the same placeholders", () => {
  const english = new Map(leaves(brainstormEn));
  const italian = new Map(leaves(brainstormIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of Brainstorming is written in Italian, not copied from English", () => {
  // Its name is the same word in both languages, and so is the title of its chats; «file» is Italian too.
  const same = new Set(["brainstorm.name", "brainstorm.open", "brainstorm.sessionTitle", "brainstorm.proposal.files_one"]);
  const italian = new Map(leaves(brainstormIt));
  assert.deepEqual(leaves(brainstormEn).filter(([key, value]) => !same.has(key) && italian.get(key) === value).map(([key]) => key), []);
  assert.equal(brainstormIt.brainstorm.back, "Torna al Copilot");
});

test("the texts of Brainstorming travel with the Synopsis page and Brainstorming's own parts, never with the app entry or the Copilot panel", () => {
  assert.equal("brainstorm" in en, false, "the always-loaded catalogue has none of them");
  for (const path of ["../src/components/assistant/brainstorm/BrainstormLauncher.tsx", "../src/components/assistant/brainstorm/BrainstormPanelParts.tsx"]) {
    assert.match(read(path), /^import "@\/i18n\/brainstorm";$/m, `${path} loads them`);
  }
  const panel = read("../src/components/assistant/AssistantPanel.tsx");
  assert.doesNotMatch(panel, /@\/i18n\/brainstorm/, "the panel does not bundle them: only the Synopsis page enters the mode");
  assert.doesNotMatch(panel, /^import [^;]*@\/(?:assistant|components\/assistant)\/brainstorm\//m, "Brainstorming's code is imported lazily by the panel");
  const page = read("../src/pages/OutlinePage.tsx");
  assert.match(page, /@\/components\/assistant\/brainstorm\/BrainstormLauncher/);
});
