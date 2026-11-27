import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

const engineTypes = readFileSync(new URL("../../../packages/engine/src/autopilot/types.ts", import.meta.url), "utf8");

/** The codes the engine gives its own messages, read from where it declares them, so a new one cannot ship untranslated. */
function engineMessageCodes() {
  const declaration = /export type AutopilotMessageCode =((?:\s*\|\s*"[A-Za-z]+")+);/.exec(engineTypes);
  assert.ok(declaration, "the engine declares its message codes as a union of strings");
  return [...declaration[1].matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
}

/**
 * The codes the app shows in the engine's own words, which it says in the language of the book (and in the book's own, for a reader's name): a chapter closed under the readers' target
 * names each reader that stood in the way. The shell of the app carries no code for them, and no text: they are the only ones that are not translated here.
 */
const IN_THE_ENGINES_WORDS = ["readersTargetMissed"];

test("every message code of the engine is translated in both languages, but the ones the app shows in the engine's words", () => {
  const codes = engineMessageCodes();
  assert.ok(codes.includes("failureRetry") && codes.includes("budgetNotApplicable"), `codes read: ${codes.join(", ")}`);
  for (const code of IN_THE_ENGINES_WORDS) assert.ok(codes.includes(code), `${code} is a code of the engine`);
  for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
    for (const code of codes) {
      if (IN_THE_ENGINES_WORDS.includes(code)) assert.equal(locale.autopilot.insight[code], undefined, `${language}: ${code} has no text of the app, so that the engine's words show`);
      else assert.equal(typeof locale.autopilot.insight[code], "string", `${language}: ${code}`);
    }
  }
});

test("the retry notice has a text for each of the three ways the runner retries, with its numbers", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    const { failureRetry, failureRetry_once: once, failureRetry_larger: larger } = locale.autopilot.insight;
    for (const field of ["{{attempt}}", "{{retries}}", "{{seconds}}"]) assert.ok(failureRetry.includes(field), field);
    for (const text of [once, larger]) assert.ok(text && !text.includes("{{"), "a notice without numbers has no placeholder");
  }
});
