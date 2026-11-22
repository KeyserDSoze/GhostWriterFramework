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

test("every message code of the engine is translated in both languages", () => {
  const codes = engineMessageCodes();
  assert.ok(codes.includes("failureRetry") && codes.includes("budgetNotApplicable"), `codes read: ${codes.join(", ")}`);
  for (const [language, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
    for (const code of codes) assert.equal(typeof locale.autopilot.insight[code], "string", `${language}: ${code}`);
  }
});

test("the retry notice has a text for each of the three ways the runner retries, with its numbers", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    const { failureRetry, failureRetry_once: once, failureRetry_larger: larger } = locale.autopilot.insight;
    for (const field of ["{{attempt}}", "{{retries}}", "{{seconds}}"]) assert.ok(failureRetry.includes(field), field);
    for (const text of [once, larger]) assert.ok(text && !text.includes("{{"), "a notice without numbers has no placeholder");
  }
});
