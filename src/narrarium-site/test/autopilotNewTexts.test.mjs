import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

function get(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)[\s,}]/g)].map((match) => match[1]).sort();

/** Read at once by the app shell or by pages that load no autopilot texts: they must be in the always-loaded bundle. */
const EAGER = [
  "autopilot.launcherProfileProblems",
  "profileFile.warningsTitle_one",
  "profileFile.warningsTitle_other",
  "profileFile.warningsBody",
  "profileFile.saveConfirm",
  "profileFile.directorOpinionNote",
  "readerPersonas.hasProblems",
];

/** Loaded with the views of the autopilot, the director and the personal server. */
const LAZY = [
  "autopilot.insight.profileProblems",
  "autopilot.profileProblems.title",
  "autopilot.profileProblems.explain",
  "autopilot.profileProblems.listLabel",
  "autopilot.profileProblems.linksLabel",
  "autopilot.profileProblems.openDirector",
  "autopilot.profileProblems.openGhostwriters",
  "autopilot.profileProblems.openReaders",
  "autopilot.profileProblems.resumeHint",
  "autopilot.fileError.openFile",
  "autopilot.fileError.openFileNamed",
  "autopilot.fileError.hint",
  "autopilot.setup.budgetTokens",
  "autopilot.setup.budgetTokensHint",
  "autopilot.progress.usageUnknown_one",
  "autopilot.progress.usageUnknown_other",
  "autopilot.progress.usageUnknownHint",
  "autopilot.progress.costUnknown_one",
  "autopilot.progress.costUnknown_other",
  "autopilot.progress.costUnknownHint",
  "autopilot.where.partial",
  "autopilot.where.skippedTitle_one",
  "autopilot.where.skippedTitle_other",
  "autopilot.where.skippedHint",
  "autopilot.where.skipReason.too-large",
  "autopilot.where.skipReason.unsafe-path",
  "autopilot.where.skipReason.not-text",
  "personalServer.pair.verification",
  "personalServer.pair.verificationWarning",
  "personalServer.pair.doneCode",
  "personalServer.compat.older",
  "personalServer.compat.newer",
];

test("the texts the app shell and the profile pages read are in the always-loaded bundle, in both languages", () => {
  for (const key of EAGER) {
    for (const [language, locale] of [["en", en], ["it", it]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(autopilotEn, key), undefined, `${key} is not repeated in the lazily loaded bundle`);
  }
});

test("the texts of the autopilot, the director and the personal server are in the bundle loaded with their views, in both languages", () => {
  for (const key of LAZY) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
  }
});

test("each text keeps the same values to fill in, in both languages", () => {
  for (const key of EAGER) assert.deepEqual(placeholders(get(it, key)), placeholders(get(en, key)), key);
  for (const key of LAZY) assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
});

test("each text is written in Italian, not copied from English", () => {
  for (const key of EAGER) assert.notEqual(get(it, key), get(en, key), key);
  for (const key of LAZY) assert.notEqual(get(autopilotIt, key), get(autopilotEn, key), key);
});

test("the notices that name a count have a form for one and for many, in both languages", () => {
  for (const base of ["profileFile.warningsTitle", "autopilot.progress.usageUnknown", "autopilot.progress.costUnknown", "autopilot.where.skippedTitle"]) {
    let found = 0;
    for (const [language, locale] of [["en", en], ["en", autopilotEn], ["it", it], ["it", autopilotIt]]) {
      const one = get(locale, `${base}_one`);
      const other = get(locale, `${base}_other`);
      if (one === undefined && other === undefined) continue;
      found += 1;
      assert.equal(typeof one, "string", `${language}: ${base}_one`);
      assert.ok(placeholders(other).includes("count"), `${language}: ${base}_other says how many`);
    }
    assert.equal(found, 2, `${base} exists once in each language`);
  }
});

test("the explanation of a stop for profiles points at the button that resumes", () => {
  for (const locale of [autopilotEn, autopilotIt]) assert.ok(get(locale, "autopilot.profileProblems.resumeHint").includes("{{action}}"));
});
