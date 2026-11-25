import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import aiRouterEn from "../src/i18n/locales/aiRouter.en.ts";
import aiRouterIt from "../src/i18n/locales/aiRouter.it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";
import autopilotCallsEn from "../src/i18n/locales/autopilotCalls.en.ts";
import autopilotCallsIt from "../src/i18n/locales/autopilotCalls.it.ts";
import debugAttemptEn from "../src/i18n/locales/debugAttempt.en.ts";
import debugAttemptIt from "../src/i18n/locales/debugAttempt.it.ts";

// The texts of the API protocol of a model, of the address it may have of its own and of the notice that offers the Responses API: each exists in English and in Italian, is translated (but for the names of an
// API, which are the same in both), keeps its placeholders, and every text that the editor asks for is there.

const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)[\s,}]/g)].map((match) => match[1]).sort();

const SETTINGS = [
  "settings.apiProtocol", "settings.apiProtocolChat", "settings.apiProtocolResponses", "settings.modelRequestHint", "settings.modelEndpointUrl", "settings.modelEndpointUrlPlaceholder",
  "settings.modelEndpointUrlProblem.invalid", "settings.modelEndpointUrlProblem.scheme", "settings.modelEndpointUrlProblem.credentials", "settings.modelEndpointUrlSecret",
  "settings.modelEndpointUrlVersionsIgnored", "settings.modelApiVersionIgnored", "settings.modelResponsesSuggestion", "settings.modelResponsesUse", "settings.modelResponsesUseFor", "settings.modelRequestsGoTo",
  "settings.modelNoResponsesApi", "settings.modelNoAddress", "settings.modelResponsesVersionNote", "settings.noThinkingWithToolsUnused",
];
const LEARNED = [
  "autopilot.learned.titleResponses", "autopilot.learned.wayResponses", "autopilot.learned.useResponses", "autopilot.learned.doneResponses", "autopilot.learned.responsesFailed",
  "autopilot.learned.toast", "autopilot.learned.toastResponses",
];
const TRAIL = [
  [autopilotEn, autopilotIt, ["autopilot.route.protocolResponses", "autopilot.failure.facts.protocol", "autopilot.failure.facts.protocolResponses", "autopilot.failure.transport.end.doneResponses", "autopilot.failure.transport.end.closedResponses"]],
  [autopilotCallsEn, autopilotCallsIt, ["autopilot.calls.attemptFacts.protocolResponses"]],
  [debugAttemptEn, debugAttemptIt, ["debug.attempt.protocolResponses", "debug.attempt.end.doneResponses", "debug.attempt.end.closedResponses"]],
];
/** The same words in both languages: the name of an API. */
const NAMES = new Set(["settings.apiProtocolChat", "settings.apiProtocolResponses"]);

function assertBoth(english, italian, keys, label) {
  for (const key of keys) {
    const en = lookup(english, key);
    const it = lookup(italian, key);
    assert.equal(typeof en, "string", `${label}: ${key} (en)`);
    assert.equal(typeof it, "string", `${label}: ${key} (it)`);
    assert.ok(en.trim() && it.trim(), `${label}: ${key} is not empty`);
    assert.deepEqual(placeholders(it), placeholders(en), `${label}: ${key} has the same placeholders in both languages`);
    if (en.length > 12 && !NAMES.has(key) && !/^(?:Responses API|API Responses)$/.test(en)) assert.notEqual(it, en, `${label}: ${key} is translated`);
  }
}

test("every text of the API protocol and the address of a model exists in English and in Italian, and the Italian is not the English", () => {
  assertBoth(aiRouterEn, aiRouterIt, SETTINGS, "settings");
});

test("every text of the notice that offers the Responses API, and of the trail that says the protocol, exists in both languages", () => {
  assertBoth(autopilotEn, autopilotIt, LEARNED, "learned");
  for (const [english, italian, keys] of TRAIL) assertBoth(english, italian, keys, keys[0]);
});

test("the Italian says the Responses API as the rest of the Italian texts of the app do, and the names of the two protocols are those of the engine", () => {
  assert.equal(lookup(aiRouterIt, "settings.apiProtocolResponses"), "API Responses");
  assert.equal(lookup(aiRouterEn, "settings.apiProtocolResponses"), "Responses API");
  assert.match(lookup(aiRouterEn, "settings.apiProtocolChat"), /^Chat Completions/);
  assert.match(lookup(aiRouterIt, "settings.apiProtocolChat"), /^Chat Completions/);
  assert.match(lookup(autopilotIt, "autopilot.learned.wayResponses"), /API Responses/);
  assert.ok(!/Responses API/.test(lookup(autopilotIt, "autopilot.learned.wayResponses")));
});

test("the engine's remedy and the editor say the same name for the setting: «API protocol» and «Responses API»", () => {
  assert.equal(lookup(aiRouterEn, "settings.apiProtocol"), "API protocol");
  assert.equal(lookup(aiRouterEn, "settings.apiProtocolResponses"), "Responses API");
});

test("the hint of the card says what each of the two settings does, the address as it is written and the warning about keys", () => {
  for (const [name, tree] of [["en", aiRouterEn], ["it", aiRouterIt]]) {
    const hint = lookup(tree, "settings.modelRequestHint");
    for (const word of ["Chat Completions", "reasoning_effort"]) assert.ok(hint.includes(word), `${word} in the hint (${name})`);
    assert.ok(/Responses/.test(hint), `Responses in the hint (${name})`);
  }
  assert.match(lookup(aiRouterEn, "settings.modelRequestHint"), /Do not put a key in it/);
  assert.match(lookup(aiRouterIt, "settings.modelRequestHint"), /Non metterci una chiave/);
  assert.match(lookup(aiRouterEn, "settings.modelEndpointUrlSecret"), /\{\{names\}\}/);
});

test("the button of the suggestion and of the notice have a name of their own that starts with the words on them and names the model", () => {
  for (const [name, tree, notice] of [["en", aiRouterEn, autopilotEn], ["it", aiRouterIt, autopilotIt]]) {
    assert.ok(lookup(tree, "settings.modelResponsesUseFor").startsWith(lookup(tree, "settings.modelResponsesUse")), `the name of the button begins with its words (${name})`);
    assert.ok(lookup(tree, "settings.modelResponsesUseFor").includes("{{name}}"), `and says which model (${name})`);
    assert.ok(lookup(notice, "autopilot.learned.useResponses").includes("{{model}}"), `the button of the notice says which model (${name})`);
  }
});

test("every text the editor of the model asks for is in the texts of the settings, in both languages", async () => {
  const source = await readFile(new URL("../src/components/settings/ModelRequestFields.tsx", import.meta.url), "utf8");
  const asked = new Set();
  for (const match of source.matchAll(/t\("(settings\.[A-Za-z0-9_.]+)"/g)) asked.add(match[1]);
  for (const match of source.matchAll(/t\(`(settings\.[A-Za-z0-9_.]+)\.\$\{(\w+)\}`/g)) for (const problem of ["invalid", "scheme", "credentials"]) asked.add(`${match[1]}.${problem}`);
  for (const match of source.matchAll(/t\((?:[\w.]+ === "[\w-]+" \? )?"(settings\.[A-Za-z0-9_.]+)" : "(settings\.[A-Za-z0-9_.]+)"/g)) { asked.add(match[1]); asked.add(match[2]); }
  assert.ok(asked.size >= 12, `the editor asks for its texts (${asked.size})`);
  for (const key of asked) {
    assert.equal(typeof lookup(aiRouterEn, key), "string", `${key} (en)`);
    assert.equal(typeof lookup(aiRouterIt, key), "string", `${key} (it)`);
  }
});
