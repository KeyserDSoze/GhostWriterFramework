import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";
import conflictsEn from "../src/i18n/locales/githubConflicts.en.ts";
import conflictsIt from "../src/i18n/locales/githubConflicts.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();

test("the conflicts with GitHub speak both languages, with the same texts and the same placeholders", () => {
  const english = new Map(leaves(conflictsEn));
  const italian = new Map(leaves(conflictsIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian of the conflicts with GitHub is written in Italian, not copied from English", () => {
  const italian = new Map(leaves(conflictsIt));
  assert.deepEqual(leaves(conflictsEn).filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("every text that counts has its plural forms in both languages", () => {
  for (const [name, locale] of [["en", conflictsEn], ["it", conflictsIt]]) {
    const keys = leaves(locale).map(([key]) => key);
    for (const key of keys.filter((entry) => entry.endsWith("_one"))) assert.ok(keys.includes(key.replace(/_one$/, "_other")), `${name}: ${key} has its other form`);
    for (const key of keys.filter((entry) => entry.endsWith("_other"))) assert.ok(keys.includes(key.replace(/_other$/, "_one")), `${name}: ${key} has its one form`);
  }
});

test("the labels the author reads are the ones the specification names, in both languages", () => {
  const english = conflictsEn.githubConflicts;
  const italian = conflictsIt.githubConflicts;
  assert.equal(english.resolve, "Resolve the conflicts");
  assert.equal(italian.resolve, "Risolvi i conflitti");
  assert.equal(english.choose.server, "Keep the server's version");
  assert.equal(italian.choose.server, "Tieni la versione del server");
  assert.equal(english.choose.github, "Take GitHub's version");
  assert.equal(italian.choose.github, "Prendi quella di GitHub");
  assert.equal(english.rest.legend, "For all the others");
  assert.equal(italian.rest.legend, "Per tutti gli altri");
  assert.equal(english.error.title, "The book changed on both GitHub and the server");
  assert.equal(italian.error.title, "Il libro è cambiato sia su GitHub sia sul server");
  assert.equal(english.done.summary, "Resolved: {{kept}}, {{taken}}. Resume the autopilot whenever you want.");
  assert.equal(italian.done.summary, "Risolto: {{kept}}, {{taken}}. Riprendi l'autopilot quando vuoi.");
  assert.equal(english.actions.pause, "Pause the autopilot");
  assert.equal(italian.actions.pause, "Metti in pausa l'autopilot");
});

test("what the version that is not kept becomes is said where it is chosen, in both languages: it stays in the git history", () => {
  for (const locale of [conflictsEn.githubConflicts, conflictsIt.githubConflicts]) {
    assert.match(locale.intro, /git/);
    assert.match(locale.confirm.server, /git/);
    assert.match(locale.confirm.github, /git/);
  }
});

test("the app entry does not carry the texts of the conflicts with GitHub, and the autopilot texts do not repeat them", () => {
  assert.equal("githubConflicts" in en, false);
  assert.equal("githubConflicts" in it, false);
  assert.equal("githubConflicts" in autopilotEn, false);
  assert.equal("githubConflicts" in autopilotIt, false);
  for (const [name, locale] of Object.entries({ en: autopilotEn, it: autopilotIt })) {
    assert.ok(locale.autopilot.operation.githubConflicts?.trim(), `${name}: the operation has a name`);
    assert.ok(locale.autopilot.errors.busyWith.githubConflicts?.trim(), `${name}: the operation that holds the book is said`);
    assert.ok(locale.autopilot.errors.githubConflict_one?.trim() && locale.autopilot.errors.githubConflict_other?.trim(), `${name}: the sync that met a conflict is said`);
  }
});

test("the views that show the texts bring them, and the app entry never imports them", () => {
  const register = readFileSync(new URL("../src/i18n/githubConflicts.ts", import.meta.url), "utf8");
  assert.match(register, /registerTranslations\(githubConflictsEn, githubConflictsIt\)/);
  for (const view of ["components/autopilot/GithubConflictsAction.tsx", "components/autopilot/GithubConflictsDialog.tsx"]) {
    assert.match(readFileSync(new URL(`../src/${view}`, import.meta.url), "utf8"), /^import "@\/i18n\/githubConflicts";$/m, view);
  }
  for (const entry of ["main.tsx", "App.tsx", "i18n/index.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../src/${entry}`, import.meta.url), "utf8"), /githubConflicts/, entry);
  }
});
