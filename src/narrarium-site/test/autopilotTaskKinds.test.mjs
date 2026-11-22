import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

const engineTypes = readFileSync(new URL("../../../packages/engine/src/autopilot/types.ts", import.meta.url), "utf8");

/** The kinds of step the engine declares, read from where it declares them, so a new one cannot ship without a name. */
function engineTaskKinds() {
  // A kind may carry its own doc comment inside the union (`freeze` does): the comments are not part of the declaration.
  const source = engineTypes.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const declaration = /export type AutopilotTaskKind =((?:\s*\|\s*"[a-z-]+")+);/.exec(source);
  assert.ok(declaration, "the engine declares its kinds of step as a union of strings");
  return [...declaration[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
}

const LOCALES = { en: autopilotEn, it: autopilotIt };

test("every kind of step of the engine has a name in both languages", () => {
  const kinds = engineTaskKinds();
  assert.ok(kinds.includes("summarize-imported") && kinds.includes("consolidate") && kinds.includes("final"), `kinds read: ${kinds.join(", ")}`);
  for (const [language, locale] of Object.entries(LOCALES)) {
    for (const kind of kinds) {
      assert.equal(typeof locale.autopilot.task[kind], "string", `${language}: ${kind}`);
      assert.ok(locale.autopilot.task[kind].trim(), `${language}: ${kind} is not empty`);
    }
  }
});

test("a step this version does not know has a plain name to fall back on, in both languages", () => {
  for (const [language, locale] of Object.entries(LOCALES)) {
    assert.equal(typeof locale.autopilot.task.unknown, "string", language);
    assert.ok(!locale.autopilot.task.unknown.includes("{{"), `${language}: the fallback needs nothing to be filled in`);
  }
});

test("the summary of a chapter the author wrote says which chapter, as the engine's own wording does", () => {
  assert.equal(autopilotEn.autopilot.task["summarize-imported"], "Summarizing imported chapter {{number}}");
  assert.equal(autopilotIt.autopilot.task["summarize-imported"], "Riassunto del capitolo importato {{number}}");
});

test("the names of the steps are written in Italian, not copied from English", () => {
  for (const kind of [...engineTaskKinds(), "unknown"]) {
    assert.notEqual(autopilotIt.autopilot.task[kind], autopilotEn.autopilot.task[kind], kind);
  }
});
