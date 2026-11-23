import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

// «Retry now» and «Retry later»: the texts of the wait, of the configuration and of the new codes of the engine. They are loaded with the views of
// the autopilot (the home route has no room for them), in both languages, written in Italian, with the same values to fill in.

function get(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

function leaves(tree, prefix) {
  return Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}.${key}`) : [`${prefix}.${key}`]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)[\s,}]/g)].map((match) => match[1]).sort();

const TREES = ["autopilot.retry", "autopilot.config.retryLater"];

test("the texts of «Retry now» and «Retry later» are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  for (const tree of TREES) {
    const keys = leaves(get(autopilotEn, tree), tree);
    assert.ok(keys.length >= 10, `${tree} has its texts (saw ${keys.length})`);
    assert.deepEqual(leaves(get(autopilotIt, tree), tree).sort(), [...keys].sort(), `${tree}: the same texts in both languages`);
    for (const key of keys) {
      for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
        assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
        assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
      }
      assert.equal(get(en, key), undefined, `${key} is not in the always-loaded bundle`);
      assert.equal(get(it, key), undefined, `${key} is not in the always-loaded bundle`);
      assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
      if (get(autopilotEn, key).length > 12) assert.notEqual(get(autopilotIt, key), get(autopilotEn, key), `${key} is written in Italian`);
    }
  }
  for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
    assert.equal(typeof get(locale, "autopilot.config.sections.retry"), "string", `${language}: the section of the configuration has a title`);
  }
});

test("the new codes of the engine say what happened in each language, with their numbers", () => {
  const codes = {
    longRetryWait: ["cycle", "cycles", "wait"],
    longRetryWait_unlimited: ["cycle", "wait"],
    retrySkipped: [],
    longRetryExhausted: [],
    longRetryExhausted_one: ["count"],
    longRetryExhausted_other: ["count"],
    longRetryOff: [],
    outlineChangedWhileWriting: ["number"],
    outlineRemovedWritten: ["number"],
    outlineWrittenChanged: ["number"],
  };
  for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
    for (const [code, fields] of Object.entries(codes)) {
      const text = get(locale, `autopilot.insight.${code}`);
      assert.equal(typeof text, "string", `${language}: ${code}`);
      assert.deepEqual(placeholders(text), fields, `${language}: ${code} fills in ${fields.join(", ") || "nothing"}`);
    }
  }
  // The wait of «Retry later» counts its restarts, never its quick retries: two counters with two words.
  assert.match(autopilotEn.autopilot.insight.longRetryWait, /restart \{\{cycle\}\} of \{\{cycles\}\}/);
  assert.match(autopilotIt.autopilot.insight.longRetryWait, /ripartenza \{\{cycle\}\} di \{\{cycles\}\}/);
  assert.match(autopilotIt.autopilot.insight.longRetryWait_unlimited, /illimitate/);
  assert.equal(autopilotEn.autopilot.insight.retrySkipped, "Wait skipped: retrying now.");
  assert.equal(autopilotIt.autopilot.insight.retrySkipped, "Attesa saltata: riprovo subito.");
  // A written chapter whose outline changed is only reported now (frozenEdits: notify): the text no longer promises anything else.
  assert.match(autopilotEn.autopilot.insight.outlineWrittenChanged, /only reported/);
  assert.match(autopilotIt.autopilot.insight.outlineWrittenChanged, /solo segnalato/);
});

test("the wait, the outcome of «Retry now» and the restarts use the words of the site, in each language", () => {
  const en_ = autopilotEn.autopilot;
  const it_ = autopilotIt.autopilot;
  assert.equal(en_.retry.now, "Retry now");
  assert.equal(it_.retry.now, "Riprova ora");
  assert.equal(en_.retry.now, en_.failure.actions.retry, "the same words as the retry of a run that stopped");
  assert.equal(it_.retry.now, it_.failure.actions.retry);
  assert.equal(en_.retry.outcome.skipped, "Retrying now.");
  assert.equal(it_.retry.outcome.skipped, "Riprovo adesso.");
  assert.equal(en_.retry.waiting, "Waiting to retry");
  assert.equal(it_.retry.waiting, "In attesa di riprovare");
  assert.equal(it_.retry.restart, "ripartenza {{cycle}} di {{cycles}}");
  assert.equal(it_.retry.notBefore, "non prima delle {{time}}");
  assert.equal(en_.retry.settings, "Change settings");
  assert.equal(it_.retry.settings, "Cambia le impostazioni");
  assert.equal(en_.config.retryLater.label, "Retry later");
  assert.equal(it_.config.retryLater.label, "Riprova più tardi");
  assert.equal(it_.config.retryLater.cycles.unlimited, "Continua finché riesce o finché non lo fermo");
  assert.equal(it_.config.retryLater.cycles.legend, "Numero massimo di ripartenze");
  assert.equal(it_.config.retryLater.recommended, "Usa i valori consigliati");
  assert.equal(en_.config.retryLater.recommended, "Use recommended values");
  for (const locale of [en_, it_]) {
    assert.ok(placeholders(locale.retry.oldServer).includes("version"), "the server to update to is named");
    assert.ok(placeholders(locale.config.retryLater.oldServer).includes("version"));
  }
});

test("the consent says what «Retry later» does and costs before it is turned on, in each language", () => {
  const en_ = autopilotEn.autopilot.config.retryLater.consent;
  const it_ = autopilotIt.autopilot.config.retryLater.consent;
  for (const word of [/this book/i, /billed/i, /network/i, /overload/i, /rate limits/i, /discarded/i, /key/i, /budget/i, /browser/i, /server/i]) assert.match(en_, word);
  for (const word of [/questo libro/i, /addebitat/i, /rete/i, /sovraccarico/i, /limiti/i, /scartate/i, /chiave/i, /budget/i, /browser/i, /server/i]) assert.match(it_, word);
});
