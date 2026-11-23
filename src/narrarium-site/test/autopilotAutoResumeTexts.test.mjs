import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

// «Resume after a restart»: the switch of the «Retries» card and the notice of a run the server resumed by itself, in the bundle loaded with the autopilot,
// in both languages, with what the switch does in one line.

const get = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

test("the switch says what it is and what it does, in one line, in both languages, in the bundle of the autopilot", () => {
  const english = get(autopilotEn, "autopilot.config.autoResume");
  const italian = get(autopilotIt, "autopilot.config.autoResume");
  assert.deepEqual(Object.keys(italian).sort(), Object.keys(english).sort(), "the same texts in both languages");
  assert.equal(english.label, "Resume by itself after a server restart");
  assert.equal(italian.label, "Riprendi da solo dopo un riavvio del server");
  for (const [language, hint] of [["en", english.hint], ["it", italian.hint]]) {
    assert.equal(typeof hint, "string", language);
    assert.doesNotMatch(hint, /\n/, `${language}: one line`);
    assert.doesNotMatch(hint, /\{\{/, `${language}: nothing to fill in`);
  }
  // Resumed only if it was running, at most three times a day, a paused run never.
  assert.match(english.hint, /running when the server stopped/);
  assert.match(english.hint, /three times a day/);
  assert.match(english.hint, /paused is never resumed/);
  assert.match(italian.hint, /in esecuzione quando il server si è fermato/);
  assert.match(italian.hint, /tre volte al giorno/);
  assert.match(italian.hint, /in pausa non riparte mai/);
  for (const key of ["autopilot.config.autoResume.label", "autopilot.config.autoResume.hint"]) {
    assert.equal(get(en, key), undefined, `${key} is not in the always-loaded bundle`);
    assert.equal(get(it, key), undefined, `${key} is not in the always-loaded bundle`);
  }
});

test("the notices of a run stopped by the server and resumed after a restart are said in the language of the app", () => {
  assert.equal(get(autopilotEn, "autopilot.insight.serverShutdown"), "Paused because the server stopped.");
  assert.equal(get(autopilotIt, "autopilot.insight.serverShutdown"), "In pausa perché il server si è fermato.");
  assert.equal(get(autopilotEn, "autopilot.insight.resumedAfterRestart"), "Resumed by itself after the server restarted.");
  assert.equal(get(autopilotIt, "autopilot.insight.resumedAfterRestart"), "Ripreso da solo dopo il riavvio del server.");
});
