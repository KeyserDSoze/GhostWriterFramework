import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

const engineTypes = readFileSync(new URL("../../../packages/engine/src/autopilot/types.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The kinds of question the engine asks, read from where it declares them, so a new one cannot ship without a heading. */
function engineQuestionKinds() {
  const declaration = /export type DirectorQuestionKind =((?:\s*\|?\s*"[a-z-]+")+);/.exec(engineTypes);
  assert.ok(declaration, "the engine declares its kinds of question as a union of strings");
  return [...declaration[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
}

/** The questions of the director share one heading; every other kind says what it is about. */
const DIRECTOR_KINDS = new Set(["plan-approval", "chapter-approval", "round-limit", "director"]);

test("every kind of question the engine asks has a heading in both languages", () => {
  const kinds = engineQuestionKinds();
  assert.ok(kinds.includes("director") && kinds.includes("frozen-change") && kinds.includes("outline-change"), `kinds read: ${kinds.join(", ")}`);
  for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
    for (const kind of kinds) {
      const heading = DIRECTOR_KINDS.has(kind) ? locale.autopilot.question.title : locale.autopilot.question.kinds?.[kind];
      assert.equal(typeof heading, "string", `${language}: ${kind}`);
      assert.ok(heading.trim(), `${language}: ${kind} is not empty`);
    }
  }
});

test("the headings of the questions about a change are written in Italian, not copied from English", () => {
  for (const kind of engineQuestionKinds().filter((entry) => !DIRECTOR_KINDS.has(entry))) {
    assert.notEqual(autopilotIt.autopilot.question.kinds[kind], autopilotEn.autopilot.question.kinds[kind], kind);
  }
});
