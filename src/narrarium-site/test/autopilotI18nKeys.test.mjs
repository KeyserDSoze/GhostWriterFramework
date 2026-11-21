import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

function keys(value, prefix = "") {
  return Object.entries(value ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
}

const NAMESPACES = ["autopilot", "director", "personalServer"];

test("autopilot, director and personal server texts exist in both languages", () => {
  for (const namespace of NAMESPACES) {
    assert.deepEqual(keys(it[namespace]).sort(), keys(en[namespace]).sort(), `${namespace} (always loaded)`);
    assert.deepEqual(keys(autopilotIt[namespace]).sort(), keys(autopilotEn[namespace]).sort(), `${namespace} (loaded with the views)`);
  }
  assert.deepEqual(keys(it.secretInput).sort(), keys(en.secretInput).sort());
});

test("lazily loaded texts never redefine the always-loaded labels", () => {
  for (const [eager, lazy] of [[en, autopilotEn], [it, autopilotIt]]) {
    for (const namespace of NAMESPACES) {
      const always = new Set(keys(eager[namespace]));
      assert.deepEqual(keys(lazy[namespace]).filter((key) => always.has(key)), [], namespace);
    }
  }
});

test("the autopilot and director router tasks are labelled in both languages", () => {
  for (const locale of [en, it]) {
    assert.ok(locale.settings.capability.autopilot);
    assert.ok(locale.settings.capability.director);
    assert.ok(locale.routing.task.autopilot);
    assert.ok(locale.routing.task.director);
  }
});

test("every runner message code has a translation", () => {
  const codes = ["conflictRetry", "failureRetry", "takenOver", "interventionQueued", "interventionInterrupt", "reset", "unexpectedStop", "syncFailed", "publishFailed", "finalStateFailed"];
  for (const locale of [autopilotEn, autopilotIt]) for (const code of codes) assert.ok(locale.autopilot.insight[code], code);
});
