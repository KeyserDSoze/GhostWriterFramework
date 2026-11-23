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
  for (const key of ["title", "description", "owner", "repository", "overwrite", "overwriteHint", "submit", "noToken", "done"]) {
    assert.ok(page.includes(`t("bookSettings.connectGithub.${key}")`), `${key} comes from the catalogue`);
  }
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
  assert.equal(it.get("bookSettings.connectGithub.owner"), "Proprietario");
  assert.notEqual(it.get("bookSettings.connectGithub.submit"), en.get("bookSettings.connectGithub.submit"));
});
