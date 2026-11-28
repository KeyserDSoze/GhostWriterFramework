import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

const presets = readFileSync(new URL("../../../packages/engine/src/autopilot/presets.ts", import.meta.url), "utf8");
const estimate = readFileSync(new URL("../../../packages/engine/src/autopilot/estimate.ts", import.meta.url), "utf8");

function get(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

function keys(value, prefix = "") {
  return Object.entries(value ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort();

const SIZES = keys(autopilotEn.autopilot.presets, "autopilot.presets.");
const PREVIEW = keys(autopilotEn.autopilot.estimate, "autopilot.estimate.");
const REST = keys(autopilotEn.autopilot.approval.rest, "autopilot.approval.rest.");

test("the sizes of the form and the preview of the run have their texts in the catalogue loaded with the pages of the autopilot, in both languages, and nowhere else", () => {
  assert.ok(SIZES.length >= 8, `the sizes have their texts (${SIZES.length})`);
  assert.ok(PREVIEW.length >= 50, `the preview has its texts (${PREVIEW.length})`);
  assert.deepEqual(keys(autopilotIt.autopilot.presets, "autopilot.presets.").sort(), [...SIZES].sort());
  assert.deepEqual(keys(autopilotIt.autopilot.estimate, "autopilot.estimate.").sort(), [...PREVIEW].sort());
  for (const key of [...SIZES, ...PREVIEW]) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) assert.ok(String(get(locale, key) ?? "").trim(), `${language}: ${key}`);
    // The home route has little room: nothing of this is in the catalogues every page loads.
    assert.equal(get(en, key), undefined, `${key} is not in the always-loaded catalogue (en)`);
    assert.equal(get(it, key), undefined, `${key} is not in the always-loaded catalogue (it)`);
  }
});

test("a text says the same things in both languages: the same placeholders, and a plural form for every one that counts", () => {
  for (const key of [...SIZES, ...PREVIEW, ...REST]) {
    assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
    const one = /^(.*)_one$/.exec(key);
    if (one) assert.ok(get(autopilotEn, `${one[1]}_other`) && get(autopilotIt, `${one[1]}_other`), `${key} has its other form`);
  }
});

test("every size the engine offers has a name and a plain description, and none is described that the engine does not offer", () => {
  const ids = [...presets.matchAll(/\{ id: "([a-z-]+)", chapters:/g)].map((match) => match[1]);
  assert.ok(ids.includes("story") && ids.includes("novella") && ids.includes("novel-draft"), `ids read: ${ids.join(", ")}`);
  const described = Object.keys(autopilotEn.autopilot.presets).filter((key) => autopilotEn.autopilot.presets[key]?.name);
  assert.deepEqual([...described].sort(), [...ids].sort());
  for (const id of ids) {
    for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
      assert.ok(String(locale.autopilot.presets[id].name).trim(), `${language}: name of ${id}`);
      assert.ok(String(locale.autopilot.presets[id].about).length >= 30, `${language}: description of ${id} is a sentence`);
    }
  }
  assert.deepEqual(ids.map((id) => autopilotEn.autopilot.presets[id].name), ["Short story", "Novella", "Novel draft"]);
  assert.deepEqual(ids.map((id) => autopilotIt.autopilot.presets[id].name), ["Racconto", "Romanzo breve", "Bozza di romanzo"]);
});

test("every warning the engine can give is said by the page in its own words, or shown in the engine's: a new one cannot ship unread", () => {
  const union = /export type EstimateWarning =([\s\S]*?);\n\nexport type EstimateWarningCode/.exec(estimate);
  assert.ok(union, "the engine declares its warnings as a union");
  const codes = [...union[1].matchAll(/code: "([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...codes].sort(), ["noModel", "noPrice", "noSpeed", "reasoningModel", "smallOutput", "smallWindow"]);
  // The page's own words for the notes that repeat for every role of a model; the other codes keep the engine's text, in the language of the book.
  const ENGINE_WORDS = ["smallWindow", "smallOutput"];
  for (const code of codes.filter((entry) => !ENGINE_WORDS.includes(entry))) {
    for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
      const text = code === "noModel" ? [locale.autopilot.estimate.warning.noModel, locale.autopilot.estimate.warning.noModelServer] : [locale.autopilot.estimate.warning[code]];
      for (const line of text) assert.ok(String(line ?? "").trim(), `${language}: ${code}`);
    }
  }
  for (const severity of ["error", "warning", "info"]) {
    assert.ok(autopilotEn.autopilot.estimate.severity[severity] && autopilotIt.autopilot.estimate.severity[severity], severity);
  }
});

test("the six capabilities of the autopilot are the five roles an author knows, each named in both languages", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    assert.deepEqual(Object.keys(locale.autopilot.estimate.roles).sort(), ["director", "readers", "specialists", "summaries", "writer"]);
  }
});

test("a book that never ran has no «No activity yet» and no «Nothing has happened yet»: one line says what happens once it starts", () => {
  assert.equal(get(autopilotEn, "autopilot.activity.empty"), undefined);
  assert.equal(get(autopilotIt, "autopilot.activity.empty"), undefined);
  for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
    const lines = [locale.autopilot.activity.idle, locale.autopilot.feedEmpty];
    for (const line of lines) {
      assert.ok(line.trim().length > 20, `${language}: a line`);
      assert.doesNotMatch(line, /No activity yet|Nothing has happened yet|Nessuna attività|Non è ancora successo nulla/i, `${language}: ${line}`);
    }
  }
});

test("the title of the preview is the one the owner asked for, in both languages", () => {
  assert.equal(autopilotEn.autopilot.estimate.title, "What to expect from this run");
  assert.equal(autopilotIt.autopilot.estimate.title, "Cosa aspettarsi da questa corsa");
});

test("what the rest will cost, at the end of the plan, has its texts in the catalogue loaded with the pages of the autopilot, in both languages, and nowhere else", () => {
  assert.deepEqual([...REST].sort(), ["autopilot.approval.rest.again", "autopilot.approval.rest.full", "autopilot.approval.rest.intro", "autopilot.approval.rest.router", "autopilot.approval.rest.smallOutput", "autopilot.approval.rest.smallWindow", "autopilot.approval.rest.smallWindowDefault", "autopilot.approval.rest.tightWindow", "autopilot.approval.rest.tightWindowDefault", "autopilot.approval.rest.title", "autopilot.approval.rest.tokens", "autopilot.approval.rest.working"]);
  assert.deepEqual(keys(autopilotIt.autopilot.approval.rest, "autopilot.approval.rest.").sort(), [...REST].sort());
  for (const key of REST) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) assert.ok(String(get(locale, key) ?? "").trim().length > 3, `${language}: ${key}`);
    assert.equal(get(en, key), undefined, `${key} is not in the always-loaded catalogue (en)`);
    assert.equal(get(it, key), undefined, `${key} is not in the always-loaded catalogue (it)`);
  }
});

test("the card at the end of the plan is called what the owner asked for, in both languages, and says what it is: an estimate, not a quote", () => {
  assert.equal(autopilotEn.autopilot.approval.rest.title, "What the rest will cost");
  assert.equal(autopilotIt.autopilot.approval.rest.title, "Quanto costerà il resto");
  assert.match(autopilotEn.autopilot.approval.rest.intro, /estimate, not a quote/i);
  assert.match(autopilotIt.autopilot.approval.rest.intro, /stima, non un preventivo/i);
});

test("the words the card shares with the preview of the form are the same words: it adds no second way to say a figure that is not known", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    for (const key of ["notKnown", "notEstimated", "costWhy", "minutesWhy", "minutesWhyRoles"]) assert.ok(String(locale.autopilot.estimate[key]).trim(), key);
    assert.equal(get(locale, "autopilot.approval.rest.notKnown"), undefined);
    assert.equal(get(locale, "autopilot.approval.rest.notEstimated"), undefined);
  }
});
