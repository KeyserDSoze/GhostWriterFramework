import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";
import bookGithubEn from "../src/i18n/locales/bookGithub.en.ts";
import bookGithubIt from "../src/i18n/locales/bookGithub.it.ts";

/**
 * The card «Connect this book to GitHub» of the settings of a local book had its English and Italian texts in the code (`language === "it" ? … : …`),
 * and two labels in English only: they are in catalogues, loaded with the page (the app entry does not carry them).
 */

const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]));

test("the page has no text of its own written in the code for one language or the other", async () => {
  const page = await read("src/pages/BookSettingsPage.tsx");
  assert.doesNotMatch(page, /language === "it" \?/, "no inline Italian/English pair");
  assert.doesNotMatch(page, /<Label htmlFor="attach-(owner|repo)">(Owner|Repository)<\/Label>/, "the labels of the fields are translated");
  // The owner is chosen in the panel that the page shares with the page that adds a book (its texts are `github.createBook.*`), no longer typed in a field of the card.
  assert.match(page, /<GitHubRepositoryPicker\s/, "the repository (one that is there, or a new one with its owner, visibility and Pages) is chosen in the shared picker");
  for (const key of ["title", "description", "submit", "noToken"]) {
    assert.ok(page.includes(`t("bookSettings.connectGithub.${key}")`), `${key} comes from the catalogue`);
  }
  // The switch that replaces what is in a repository that is there lives in the picker now (the same one where a book is added), with the same words.
  const picker = await read("src/components/book/GitHubRepositoryPicker.tsx");
  for (const key of ["overwrite", "overwriteHint", "noToken"]) assert.ok(picker.includes(`t("bookSettings.connectGithub.${key}")`), `${key} comes from the catalogue, in the picker`);
  assert.ok(page.includes('t("bookSettings.deviceOnly")'), "and the line that says the book is on this device only");
  assert.match(page, /import "@\/i18n\/bookGithub";/, "the page loads its catalogue");
});

test("the catalogue has the same texts in English and in Italian, none empty and none the same as the other language but the name of GitHub", () => {
  const en = new Map(leaves(bookGithubEn));
  const it = new Map(leaves(bookGithubIt));
  assert.deepEqual([...it.keys()].sort(), [...en.keys()].sort());
  for (const [key, text] of en) {
    assert.equal(typeof text, "string");
    assert.ok(text.trim(), `${key} (en) is not empty`);
    assert.ok(String(it.get(key)).trim(), `${key} (it) is not empty`);
  }
  assert.equal(it.get("bookSettings.connectGithub.title"), "Collega il libro a GitHub");
  assert.notEqual(it.get("bookSettings.connectGithub.submit"), en.get("bookSettings.connectGithub.submit"));
});
