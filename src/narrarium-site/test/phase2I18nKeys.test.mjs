import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import aiRouterEn from "../src/i18n/locales/aiRouter.en.ts";
import aiRouterIt from "../src/i18n/locales/aiRouter.it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";
import debugAttemptEn from "../src/i18n/locales/debugAttempt.en.ts";
import debugAttemptIt from "../src/i18n/locales/debugAttempt.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

const SITE = new URL("../", import.meta.url);

const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
/** A text, or the forms of a plural i18next picks from. */
const exists = (tree, key) => typeof lookup(tree, key) === "string" || (typeof lookup(tree, `${key}_one`) === "string" && typeof lookup(tree, `${key}_other`) === "string");

const NEW_AUTOPILOT = [
  "autopilot.failure.kind.config.title", "autopilot.failure.kind.config.explain", "autopilot.failure.kind.config.short",
  "autopilot.failure.config.openRouter", "autopilot.failure.config.retryHint",
  "autopilot.failure.timeout.limit", "autopilot.failure.timeout.limitNoTime", "autopilot.failure.timeout.what.start", "autopilot.failure.timeout.what.idle", "autopilot.failure.timeout.what.total",
  "autopilot.failure.timeout.field.start", "autopilot.failure.timeout.field.idle", "autopilot.failure.timeout.change", "autopilot.failure.timeout.fixed",
  "autopilot.failure.retryAfter", "autopilot.band.answering", "autopilot.band.answeringShort",
  "autopilot.result.numbers.timeSince", "autopilot.result.scores.revised", "autopilot.result.scores.reviseLegend",
];
const NEW_ROUTER = [
  "routing.toolsOnly.label", "routing.toolsOnly.hint", "routing.toolsOnly.blocked", "routing.toolsOnly.skipped", "routing.toolsOnly.remedy",
  "routing.thinking.fromEndpoint", "routing.thinking.fromEndpointWith", "routing.thinking.hint.fromEndpoint", "routing.bulk.defaultThinking",
  "settings.thinkingDefault", "settings.thinkingNone", "settings.thinkingDefaultHint", "settings.forcedToolCallsHint",
];
const NEW_DEBUG = [
  "debug.attempt.title", "debug.attempt.tools", "debug.attempt.json", "debug.attempt.streaming", "debug.attempt.notStreaming", "debug.attempt.thinking",
  "debug.attempt.calledYes", "debug.attempt.calledNo", "debug.attempt.skipped", "debug.attempt.firstByte", "debug.attempt.toolsOnlyOn", "debug.attempt.toolsOnlyOff",
  "debug.attempt.limits", "debug.attempt.limitsRaised",
];

test("every new text of the autopilot pages exists in English and in Italian, and the Italian is not the English", () => {
  for (const key of NEW_AUTOPILOT) {
    assert.ok(exists(autopilotEn, key), `${key} (en)`);
    assert.ok(exists(autopilotIt, key), `${key} (it)`);
    const base = key.replace(/_(one|other)$/, "");
    const english = lookup(autopilotEn, base) ?? lookup(autopilotEn, `${base}_other`);
    const italian = lookup(autopilotIt, base) ?? lookup(autopilotIt, `${base}_other`);
    if (String(english).length > 12) assert.notEqual(italian, english, `${key} is translated`);
  }
});

test("every new text of the Router and of the integration card exists in both languages, and the Italian is not the English", () => {
  for (const key of NEW_ROUTER) {
    assert.ok(exists(aiRouterEn, key), `${key} (en)`);
    assert.ok(exists(aiRouterIt, key), `${key} (it)`);
    const base = key.replace(/_(one|other)$/, "");
    const english = lookup(aiRouterEn, base) ?? lookup(aiRouterEn, `${base}_other`);
    const italian = lookup(aiRouterIt, base) ?? lookup(aiRouterIt, `${base}_other`);
    if (String(english).length > 12) assert.notEqual(italian, english, `${key} is translated`);
  }
});

test("every text of the debug panel's attempt details exists in both languages, with the same keys, and the Italian is not the English", () => {
  for (const key of NEW_DEBUG) {
    assert.ok(exists(debugAttemptEn, key), `${key} (en)`);
    assert.ok(exists(debugAttemptIt, key), `${key} (it)`);
  }
  assert.deepEqual(leaves(debugAttemptIt).sort(), leaves(debugAttemptEn).sort());
  // «Thinking» is the word of the product in both languages (it is the name of the column of the Router).
  const sameWord = new Set(["debug.attempt.thinking"]);
  const same = leaves(debugAttemptEn).filter((key) => !sameWord.has(key) && lookup(debugAttemptEn, key) === lookup(debugAttemptIt, key) && lookup(debugAttemptEn, key).length > 12);
  assert.deepEqual(same, []);
});

test("the Router's lazy catalogue has the same keys in both languages, `settings` included", () => {
  assert.deepEqual(leaves(aiRouterIt).sort(), leaves(aiRouterEn).sort());
  assert.ok(aiRouterEn.settings && aiRouterIt.settings, "the integration card's texts are bundled with the settings page too");
});

test("none of the new texts is in the catalogue the app entry carries: they are bundled with the page that shows them", () => {
  for (const [name, tree] of [["en", entryEn], ["it", entryIt]]) {
    assert.equal(lookup(tree, "debug.attempt"), undefined, `debug.attempt (${name})`);
    for (const key of NEW_ROUTER) assert.ok(!exists(tree, key), `${key} (${name}) must stay out of the entry catalogue`);
  }
  // The texts the lazy catalogues add to a group the entry already has must not repeat a key of the entry: i18next would ignore it.
  for (const [name, entry, lazy] of [["en", entryEn, aiRouterEn], ["it", entryIt, aiRouterIt]]) {
    const collisions = leaves(lazy).filter((key) => typeof lookup(entry, key) === "string");
    assert.deepEqual(collisions, [], `keys of the lazy catalogue that the entry has too (${name})`);
  }
  for (const [name, entry, lazy] of [["en", entryEn, debugAttemptEn], ["it", entryIt, debugAttemptIt]]) {
    assert.deepEqual(leaves(lazy).filter((key) => typeof lookup(entry, key) === "string"), [], `debug keys that the entry has too (${name})`);
  }
});

test("the field names the timeout notice quotes are the ones on the card of the integration", () => {
  for (const [name, autopilot, entry] of [["en", autopilotEn, entryEn], ["it", autopilotIt, entryIt]]) {
    assert.ok(lookup(entry, "settings.requestTimeoutMs").startsWith(lookup(autopilot, "autopilot.failure.timeout.field.start")), `provider timeout (${name})`);
    assert.ok(lookup(entry, "settings.idleTimeoutMs").startsWith(lookup(autopilot, "autopilot.failure.timeout.field.idle")), `idle timeout (${name})`);
  }
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.field.start"), "Timeout provider");
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.field.idle"), "Inattività massima");
});

test("the words of the design are in the Italian texts as the owner wrote them", () => {
  assert.equal(lookup(aiRouterIt, "routing.toolsOnly.label"), "Solo tool per l'autopilot");
  assert.equal(lookup(aiRouterIt, "routing.toolsOnly.hint"), "Ogni agente (scrittore, direttore, lettori, specialisti, riassunti) risponde chiamando la propria funzione; i modelli senza tool call vengono saltati e una risposta in testo al posto della chiamata viene rifiutata.");
  assert.equal(lookup(autopilotIt, "autopilot.failure.kind.config.title"), "Configurazione dell'AI da correggere");
  assert.equal(lookup(autopilotIt, "autopilot.failure.config.openRouter"), "Apri il Router AI");
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.what.start"), "attesa dell'inizio della risposta");
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.what.idle"), "silenzio tra due pezzi");
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.what.total"), "tetto totale");
  assert.equal(lookup(autopilotIt, "autopilot.failure.timeout.limit"), "Limite scaduto: {{what}} ({{time}})");
  assert.equal(lookup(autopilotIt, "autopilot.failure.retryAfter"), "Il provider chiede di aspettare {{time}}");
});

test("every plural text of the new keys has a form for one and for many", () => {
  const base = "routing.toolsOnly.blocked";
  for (const tree of [aiRouterEn, aiRouterIt]) {
    assert.equal(typeof lookup(tree, `${base}_one`), "string", base);
    assert.equal(typeof lookup(tree, `${base}_other`), "string", base);
  }
});

test("only the debug panel imports the catalogue of the attempt details, so that the app entry cannot pull it in", async () => {
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = await readFile(new URL(`src/${entry}`, SITE), "utf8");
    if (/["']@\/i18n\/debugAttempt["']|locales\/debugAttempt\./.test(text)) importers.push(`src/${entry}`);
  }
  assert.deepEqual(importers.sort(), ["src/components/debug/LlmDebugPanel.tsx", "src/i18n/debugAttempt.ts"]);
});
