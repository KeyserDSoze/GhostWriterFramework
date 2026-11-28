import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import bibleStudioEn from "../src/i18n/locales/bibleStudio.en.ts";
import bibleStudioIt from "../src/i18n/locales/bibleStudio.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const SITE = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, SITE), "utf8");
const english = new Map(leaves(bibleStudioEn));
const italian = new Map(leaves(bibleStudioIt));
// A key with a plural is written once for each form: the code asks for the key without it.
const asked = (key) => english.has(key) || english.has(`${key}_one`) || english.has(`${key}_other`);

test("what the Copilot says of a change it applied (sent, kept on this device, a conflict) and of a file that changed speaks both languages, with the same placeholders", () => {
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian is written in Italian, not copied from English", () => {
  assert.deepEqual([...english].filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("the texts travel with the Bible, the Studio and the Copilot panel, not with the shell", () => {
  for (const tree of [en, it]) assert.equal("bibleStudio" in tree, false);
  for (const file of ["src/components/outline/bible/bibleParts.tsx", "src/components/outline/bible/DecisionsSection.tsx", "src/components/outline/bible/DesignTable.tsx", "src/components/assistant/ApplyHold.tsx", "src/components/assistant/AssistantPanel.tsx"]) {
    assert.match(source(file), /import "@\/i18n\/bibleStudio";/, file);
  }
  assert.match(source("src/components/assistant/AssistantPanel.tsx"), /lazy\(\(\) => import\("@\/components\/assistant\/ApplyHold"\)\)/);
});

test("every bibleStudio key the code asks for exists, with the plural forms it needs", () => {
  const files = [
    "src/components/outline/bible/BibleTab.tsx", "src/components/outline/bible/ChecksSection.tsx", "src/components/outline/bible/DecisionsSection.tsx", "src/components/outline/bible/DesignTable.tsx",
    "src/components/outline/bible/GuidelinesSection.tsx", "src/components/outline/bible/SpoilerCheck.tsx", "src/components/outline/bible/ThreadsSection.tsx", "src/components/outline/bible/TimelineSection.tsx",
    "src/components/outline/studio/StudioTab.tsx", "src/components/assistant/ApplyHold.tsx", "src/components/assistant/AssistantPanel.tsx",
  ];
  for (const file of files) {
    for (const match of source(file).matchAll(/"(bibleStudio\.[A-Za-z.]+)"/g)) assert.ok(asked(match[1]), `${file}: ${match[1]}`);
  }
  // Keys composed from a value: who made a decision, a thread's state, the severity of a finding.
  for (const who of ["author", "brainstorming", "copilot", "director", "autopilot"]) assert.ok(english.has(`bibleStudio.decisions.who.${who}`), who);
  for (const state of ["open", "paid", "dropped"]) assert.ok(english.has(`bibleStudio.threads.state.${state}`), state);
  for (const severity of ["warning", "info"]) assert.ok(english.has(`bibleStudio.checks.severity.${severity}`), severity);
});
