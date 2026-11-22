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

/** Every text under a key, with its path: `autopilot.quick.run.step`, … */
function leaves(tree, prefix) {
  return Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}.${key}`) : [`${prefix}.${key}`]));
}

test("the texts of the quick commands are in the bundle loaded with the autopilot, in both languages, written in Italian and with the same values to fill in", () => {
  const keys = leaves(autopilotEn.autopilot.quick, "autopilot.quick");
  assert.ok(keys.length > 90, `the quick commands have their texts (saw ${keys.length})`);
  for (const key of keys) {
    for (const [language, locale] of [["en", autopilotEn], ["it", autopilotIt]]) {
      assert.equal(typeof get(locale, key), "string", `${language}: ${key}`);
      assert.ok(get(locale, key).trim(), `${language}: ${key} is not empty`);
    }
    assert.equal(get(en, key), undefined, `${key} is not repeated in the always-loaded bundle`);
    assert.deepEqual(placeholders(get(autopilotIt, key)), placeholders(get(autopilotEn, key)), key);
  }
  assert.deepEqual(leaves(autopilotIt.autopilot.quick, "autopilot.quick").sort(), keys.sort(), "the same texts in both languages");
  // The Italian is Italian: the words of the site (passo, capitolo, in diretta), not the English ones. Three texts are only a form to fill in (a name and its
  // context, a book and its panel, the brand GitHub and a way to publish) and read the same in both languages.
  const forms = new Set(["autopilot.quick.named", "autopilot.quick.contextDock", "autopilot.quick.publish.label"]);
  const same = keys.filter((key) => !forms.has(key) && get(autopilotIt, key) === get(autopilotEn, key) && get(autopilotEn, key).length > 12);
  assert.deepEqual(same, [], "texts copied from English");
});

test("the quick commands speak of steps and chapters in the words of the site, in each language", () => {
  const it_ = autopilotIt.autopilot.quick;
  const en_ = autopilotEn.autopilot.quick;
  assert.equal(it_.run.pauseStep, "Pausa dopo questo passo");
  assert.equal(it_.run.pauseChapter, "Pausa a fine capitolo");
  assert.equal(it_.run.step, "Esegui un solo passo");
  assert.equal(it_.run.chapter, "Esegui un solo capitolo");
  assert.equal(it_.publish.choice.off, "Mai");
  assert.equal(it_.publish.choice.chapter, "A ogni capitolo");
  assert.equal(it_.publish.choice.step, "A ogni passo");
  assert.equal(it_.publish.mode.chapter, "a fine capitolo", "GitHub: a fine capitolo");
  assert.equal(it_.where.hostBrowser, "Questo browser");
  assert.equal(it_.where.hostServer, "Il mio server");
  assert.equal(it_.status.pauseStep, "In pausa dopo questo passo");
  assert.equal(en_.run.pauseStep, autopilotEn.autopilot.actions.pause, "the pause of the bar is the one the site always had");
  assert.equal(it_.run.pauseStep, autopilotIt.autopilot.actions.pause);
});

test("every text that names a count has a form for one and for many, in both languages", () => {
  for (const base of ["autopilot.quick.status.stepLimit", "autopilot.quick.status.chapterLimit"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `${base}_one`), "string", `${base}_one`);
      assert.ok(placeholders(get(locale, `${base}_other`)).includes("count"), `${base}_other says how many`);
    }
  }
  for (const side of ["server", "browser"]) {
    for (const locale of [autopilotEn, autopilotIt]) {
      assert.equal(typeof get(locale, `autopilot.quick.handover.runningThere.${side}_one`), "string", `${side}_one`);
      assert.ok(placeholders(get(locale, `autopilot.quick.handover.runningThere.${side}_other`)).includes("count"), `${side}_other`);
    }
  }
});

test("the texts that name a version of the server say which one, so they can be kept right when it changes", () => {
  for (const locale of [autopilotEn, autopilotIt]) {
    assert.ok(placeholders(get(locale, "autopilot.errors.controlsUnsupported")).includes("version"));
    assert.ok(placeholders(get(locale, "autopilot.quick.serverTooOld")).includes("version"));
  }
});
