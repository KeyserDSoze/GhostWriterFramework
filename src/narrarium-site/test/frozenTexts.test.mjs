import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import frozenEn from "../src/i18n/locales/frozen.en.ts";
import frozenIt from "../src/i18n/locales/frozen.it.ts";
import frozenCopilotEn from "../src/i18n/locales/frozenCopilot.en.ts";
import frozenCopilotIt from "../src/i18n/locales/frozenCopilot.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const engineTypes = readFileSync(new URL("../../../packages/engine/src/autopilot/types.ts", import.meta.url), "utf8");

/** The actions the engine offers for a change, read from where it declares them, so a new one cannot ship without a name. */
function engineFrozenActions() {
  const declaration = /export type FrozenAction =((?:\s*\|?\s*"[a-z-]+")+);/.exec(engineTypes);
  assert.ok(declaration, "the engine declares its actions as a union of strings");
  return [...declaration[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
}

test("the frozen chapters speak both languages, with the same texts and the same placeholders", () => {
  const english = new Map([...leaves(frozenEn), ...leaves(frozenCopilotEn)]);
  const italian = new Map([...leaves(frozenIt), ...leaves(frozenCopilotIt)]);
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of the frozen chapters is written in Italian, not copied from English", () => {
  const italian = new Map([...leaves(frozenIt), ...leaves(frozenCopilotIt)]);
  assert.deepEqual([...leaves(frozenEn), ...leaves(frozenCopilotEn)].filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("every decision the engine offers about a change has a name and says what it does, in both languages", () => {
  const actions = engineFrozenActions();
  assert.deepEqual(actions, ["review-and-update", "review-only", "mark-reviewed", "rewrite-to-outline", "keep-text"]);
  for (const locale of [frozenEn, frozenIt]) {
    for (const action of actions) {
      assert.ok(locale.frozen.actions[action]?.trim(), action);
      assert.ok(locale.frozen.actionHelp[action]?.trim(), action);
    }
  }
});

test("the app entry does not carry the texts of the frozen chapters: the views that show them bring them", () => {
  assert.equal("frozen" in en, false);
  assert.equal("frozen" in it, false);
  const view = readFileSync(new URL("../src/components/frozen/FrozenChapter.tsx", import.meta.url), "utf8");
  assert.match(view, /^import "@\/i18n\/frozen";$/m);
});

test("the Copilot panel brings only the few texts of the frozen chapters it shows with a proposal, not those of the chapter pages", () => {
  const notice = readFileSync(new URL("../src/components/frozen/FrozenProposalNotice.tsx", import.meta.url), "utf8");
  assert.match(notice, /^import "@\/i18n\/frozenCopilot";$/m);
  assert.doesNotMatch(notice, /^import "@\/i18n\/frozen";$/m);
  // The panel loads the reading of the chapters only for a proposal that touches one.
  assert.doesNotMatch(notice, /^import [^t].*from "@\/frozen\/proposal";$/m);
  for (const mode of ["ask", "auto", "notify", "unfrozen"]) assert.ok(frozenCopilotEn.frozen.copilot[mode]?.trim(), mode);
  assert.equal("copilot" in frozenEn.frozen, false, "each text has one home");
});
