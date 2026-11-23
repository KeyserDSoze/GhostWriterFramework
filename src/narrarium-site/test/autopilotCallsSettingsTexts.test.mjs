import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/autopilotCallsSettings.en.ts";
import it from "../src/i18n/locales/autopilotCallsSettings.it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import eagerEn from "../src/i18n/locales/en.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();

test("the AI calls tab speaks both languages, with the same keys and the same placeholders", () => {
  const english = new Map(leaves(en));
  const italian = new Map(leaves(it));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian is written in Italian, except the names that are the same in both languages", () => {
  const italian = new Map(leaves(it));
  const same = leaves(en).filter(([key, value]) => italian.get(key) === value).map(([key]) => key).sort();
  assert.deepEqual(same, ["autopilot.callsSettings.place.github", "autopilot.callsSettings.place.google-drive", "autopilot.callsSettings.place.onedrive", "autopilot.callsSettings.copy.choice.google-drive", "autopilot.callsSettings.copy.choice.onedrive", "autopilot.callsSettings.status.offline"].sort());
});

test("every count has both plural forms in both languages", () => {
  for (const [name, locale] of [["en", en], ["it", it]]) {
    const keys = leaves(locale).map(([key]) => key);
    for (const key of keys.filter((entry) => entry.endsWith("_one"))) assert.ok(keys.includes(key.replace(/_one$/, "_other")), `${name}: ${key}`);
    for (const key of keys.filter((entry) => entry.endsWith("_other"))) assert.ok(keys.includes(key.replace(/_other$/, "_one")), `${name}: ${key}`);
  }
});

test("the privacy sentence says what the owner asked, in both languages", () => {
  assert.equal(en.autopilot.callsSettings.privacy, "These records hold what the autopilot sent to the AI (your book's text, its secrets, your notes and your director's notes) and what it wrote back. Keys and passwords are never recorded. A copy stays in the account you choose until you delete it there. GitHub keeps history after deletion, so public repositories are refused.");
  for (const word of ["segreti", "note", "direttore", "chiavi", "password", "GitHub", "pubblici"]) assert.match(it.autopilot.callsSettings.privacy.toLowerCase(), new RegExp(word.toLowerCase()), word);
});

test("these texts never redefine a label of the always-loaded or the lazily loaded autopilot texts", () => {
  const mine = leaves(en.autopilot).map(([key]) => key);
  for (const locale of [eagerEn.autopilot, autopilotEn.autopilot]) {
    const other = new Set(leaves(locale).map(([key]) => key));
    assert.deepEqual(mine.filter((key) => other.has(key)), []);
  }
});

test("the guide has the section «Where the messages are kept» in both languages, with the privacy sentence and the three places", () => {
  const read = (name) => readFileSync(new URL(`../src/content/guides/autopilot.${name}.md`, import.meta.url), "utf8");
  const english = read("en");
  const italian = read("it");
  assert.match(english, /^## Where the messages are kept$/m);
  assert.match(italian, /^## Dove sono conservati i messaggi$/m);
  assert.ok(english.includes(en.autopilot.callsSettings.privacy));
  assert.ok(italian.includes(it.autopilot.callsSettings.privacy));
  for (const place of ["GitHub", "Google Drive", "OneDrive"]) { assert.ok(english.includes(place)); assert.ok(italian.includes(place)); }
});

test("the spec documents the file format, the three targets and their limits", () => {
  const spec = readFileSync(new URL("../../../docs/autopilot-spec.md", import.meta.url), "utf8");
  for (const needle of ["## Where the AI calls are kept: the copies", "YYYY/MM/DD/<HHmmss>-<activityId>.ndjson.gz", "formatVersion", "narrarium-ai-calls", "ai-calls/<bookId>/YYYY/MM/DD", "Apps/Narrarium/ai-calls/<bookId>", "512 MiB", "2 GiB", "Public repositories are refused"]) assert.ok(spec.includes(needle), needle);
});
