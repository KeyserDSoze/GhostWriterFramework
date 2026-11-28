import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import copilotApplyEn from "../src/i18n/locales/copilotApply.en.ts";
import copilotApplyIt from "../src/i18n/locales/copilotApply.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const SITE = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, SITE), "utf8");
const english = new Map(leaves(copilotApplyEn));
const italian = new Map(leaves(copilotApplyIt));
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

test("the texts travel with the Copilot panel and its choice, not with the shell", () => {
  for (const tree of [en, it]) assert.equal("copilotApply" in tree, false);
  assert.match(source("src/components/assistant/AssistantPanel.tsx"), /import "@\/i18n\/copilotApply";/);
  assert.match(source("src/components/assistant/ApplyConflict.tsx"), /import "@\/i18n\/copilotApply";/);
  assert.match(source("src/components/assistant/AssistantPanel.tsx"), /lazy\(\(\) => import\("@\/components\/assistant\/ApplyConflict"\)\)/);
});

test("every copilotApply key the code asks for exists, including those composed from a reason", () => {
  for (const file of ["src/components/assistant/AssistantPanel.tsx", "src/components/assistant/ApplyConflict.tsx", "src/assistant/applyDelivery.ts"]) {
    for (const match of source(file).matchAll(/"(copilotApply\.[A-Za-z.-]+)"/g)) assert.ok(asked(match[1]), `${file}: ${match[1]}`);
  }
  // Every way a change can be kept on this device has its words (a book kept here says nothing more), and both kinds of changed file.
  for (const reason of ["no-credential", "offline", "unreachable", "branch-unpublished", "held", "failed"]) assert.ok(english.has(`copilotApply.saved.${reason}`), reason);
  for (const kind of ["local-edits", "changed"]) assert.ok(english.has(`copilotApply.conflictChoice.${kind}`), kind);
});

test("the sentence of a delivery says what happened and what to do, and never shows the raw text of an error", () => {
  for (const [key, value] of english) {
    if (key.startsWith("copilotApply.saved.")) assert.match(value, /saved on this device/i, key);
  }
  assert.match(english.get("copilotApply.appliedSynced_other"), /Applied and synchronised: 1 change of yours and \{\{count\}\} earlier ones/);
  assert.ok(![...english.values()].some((value) => /\{\{error\}\}/.test(value)), "no raw error");
});
