import assert from "node:assert/strict";
import test from "node:test";
import aiRouterEn from "../src/i18n/locales/aiRouter.en.ts";
import aiRouterIt from "../src/i18n/locales/aiRouter.it.ts";
import debugAttemptEn from "../src/i18n/locales/debugAttempt.en.ts";
import debugAttemptIt from "../src/i18n/locales/debugAttempt.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

const SETTINGS = [
  "settings.thinkingParameter", "settings.thinkingParameterDefault", "settings.thinkingParameterHint",
  "settings.thinkingParameterSuggestion", "settings.thinkingParameterUse", "settings.thinkingParameterUseFor",
];
const DEBUG = ["debug.attempt.reasoningParameter"];

/** @param {string} name @param {object} english @param {object} italian @param {string[]} keys */
function assertBothLanguages(name, english, italian, keys) {
  for (const key of keys) {
    assert.equal(typeof lookup(english, key), "string", `${key} (en)`);
    assert.equal(typeof lookup(italian, key), "string", `${key} (it)`);
    if (lookup(english, key).length > 12) assert.notEqual(lookup(italian, key), lookup(english, key), `${key} is translated (${name})`);
  }
}

test("every text of the thinking parameter of a model exists in English and in Italian, and the Italian is not the English", () => {
  assertBothLanguages("settings", aiRouterEn, aiRouterIt, SETTINGS);
  assertBothLanguages("debug", debugAttemptEn, debugAttemptIt, DEBUG);
});

test("the label is the one the engine's remedy quotes, in both languages, and the other words are those of the design", () => {
  assert.equal(lookup(aiRouterEn, "settings.thinkingParameter"), "Thinking parameter");
  assert.equal(lookup(aiRouterIt, "settings.thinkingParameter"), "Parametro del thinking");
  assert.equal(lookup(aiRouterEn, "settings.thinkingParameterUse"), "Use it");
  assert.equal(lookup(aiRouterIt, "settings.thinkingParameterUse"), "Usalo");
  assert.equal(lookup(aiRouterEn, "settings.thinkingParameterDefault"), "{{value}} (default)");
  assert.equal(lookup(aiRouterIt, "settings.thinkingParameterDefault"), "{{value}} (predefinito)");
});

test("the button of the suggestion has a name of its own that starts with the words on it", () => {
  for (const [name, tree] of [["en", aiRouterEn], ["it", aiRouterIt]]) {
    assert.ok(lookup(tree, "settings.thinkingParameterUseFor").startsWith(lookup(tree, "settings.thinkingParameterUse")), `the name of the button begins with its words (${name})`);
    assert.ok(lookup(tree, "settings.thinkingParameterUseFor").includes("{{name}}"), `and says which model (${name})`);
  }
});

test("the hint and the suggestion say the values as they are written, and the figures are placeholders", () => {
  for (const [name, tree] of [["en", aiRouterEn], ["it", aiRouterIt]]) {
    const hint = lookup(tree, "settings.thinkingParameterHint");
    for (const word of ["reasoning_effort", "chat_template_kwargs.reasoning_strength", "llama.cpp", "none"]) assert.ok(hint.includes(word), `${word} in the hint (${name})`);
    assert.ok(lookup(tree, "settings.thinkingParameterSuggestion").includes("{{value}}"), `the suggestion names the value it suggests (${name})`);
  }
  assert.match(lookup(aiRouterEn, "settings.thinkingParameterHint"), /does not turn thinking off/);
  assert.match(lookup(aiRouterIt, "settings.thinkingParameterHint"), /non spegne il thinking/);
});

test("the debug badge names the way the level was sent, with a placeholder", () => {
  assert.equal(lookup(debugAttemptEn, "debug.attempt.reasoningParameter"), "Level sent as {{parameter}}");
  assert.equal(lookup(debugAttemptIt, "debug.attempt.reasoningParameter"), "Livello inviato come {{parameter}}");
});

test("none of the new texts is in the catalogue the app entry carries: they are bundled with the page that shows them", () => {
  for (const [name, tree] of [["en", entryEn], ["it", entryIt]]) {
    for (const key of [...SETTINGS, ...DEBUG]) assert.equal(lookup(tree, key), undefined, `${key} must stay out of the entry catalogue (${name})`);
  }
});
