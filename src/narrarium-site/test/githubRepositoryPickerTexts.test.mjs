import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";
import enTexts from "../src/i18n/locales/githubRepositoryPicker.en.ts";
import itTexts from "../src/i18n/locales/githubRepositoryPicker.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

/**
 * The texts of the repository picker (`github.picker.*`) are two catalogues of their own, registered by one module that the picker and its combobox import:
 * the app entry does not carry them. Every reason a read can fail has its words, and the list is a WAI-ARIA combobox.
 */

const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]));
const placeholders = (text) => Array.from(String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

test("the two catalogues have the same keys under github.picker, none empty, each translated, with the same placeholders", () => {
  assert.deepEqual(Object.keys(enTexts), ["github"]);
  assert.deepEqual(Object.keys(itTexts), ["github"]);
  assert.deepEqual(Object.keys(enTexts.github), ["picker"]);
  const en = new Map(leaves(enTexts));
  const it = new Map(leaves(itTexts));
  assert.deepEqual([...it.keys()].sort(), [...en.keys()].sort());
  assert.ok(en.size > 60, `${en.size} texts`);
  for (const [key, text] of en) {
    assert.equal(typeof text, "string");
    assert.ok(text.trim() && String(it.get(key)).trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(it.get(key)), placeholders(text), `${key}: same placeholders`);
    // The count is the same word in both languages («repository»); everything else is translated.
    if (!/^github\.picker\.list\.count_/.test(key)) assert.notEqual(it.get(key), text, `${key} is translated`);
  }
});

test("the count has the singular and the plural form, and every reason a read can fail has its words", async () => {
  for (const texts of [enTexts, itTexts]) {
    assert.ok(texts.github.picker.list.count_one.includes("{{count}}"));
    assert.ok(texts.github.picker.list.count_other.includes("{{count}}"));
  }
  const listing = await read("src/github/repositoryListing.ts");
  const reasons = [...(/export type ListingFailureReason =([^;]*);/.exec(listing)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(reasons.length >= 6, `${reasons.length} reasons`);
  for (const reason of reasons) assert.ok(reason in enTexts.github.picker.error, `error.${reason} exists`);
  for (const context of ["add", "attach"]) for (const outcome of ["connectBook", "publishEmpty", "needsOverwrite", "publishOverwrite"]) assert.ok(enTexts.github.picker.outcome[context][outcome], `outcome.${context}.${outcome}`);
});

test("the texts are not in the catalogue of the app entry and only the picker's own modules register them", async () => {
  for (const entry of [/** @type {Record<string, unknown>} */ (entryEn), /** @type {Record<string, unknown>} */ (entryIt)]) assert.equal(entry.github, undefined);
  assert.match(await read("src/i18n/githubRepositoryPicker.ts"), /registerTranslations\(githubRepositoryPickerEn, githubRepositoryPickerIt\)/);
  for (const file of ["src/components/book/GitHubRepositoryPicker.tsx", "src/components/book/RepositoryCombobox.tsx"]) assert.match(await read(file), /import "@\/i18n\/githubRepositoryPicker";/, `${file} loads its catalogue`);
});

test("the list is a combobox with a listbox: roles, the active option, a label, a live region for the count, and targets a finger can hit", async () => {
  const combobox = await read("src/components/book/RepositoryCombobox.tsx");
  for (const expected of [/role="combobox"/, /aria-expanded=\{expanded\}/, /aria-controls=\{listId\}/, /aria-autocomplete="list"/, /aria-activedescendant=/, /role="listbox"/, /role="option"/, /<Label htmlFor=\{inputId\}>/, /role="status" aria-live="polite"/, /\[@media\(pointer:coarse\)\]:h-11/, /min-h-11/]) assert.match(combobox, expected);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]) assert.ok(combobox.includes(`"${key}"`), `${key} is handled`);
  assert.match(combobox, /<ChevronDown aria-hidden="true"/, "the icons are decoration");
  const picker = await read("src/components/book/GitHubRepositoryPicker.tsx");
  assert.match(picker, /<fieldset[^>]*>\s*<legend/, "the two modes are a group with a legend");
  assert.match(picker, /type="radio"/);
});

test("the list is never read all at once: a page is 30 repositories, the next is read when asked or when a search needs it, and a failure is not retried by itself", async () => {
  const listing = await read("src/github/repositoryListing.ts");
  assert.match(listing, /LISTING_PAGE_SIZE = 30/);
  assert.doesNotMatch(listing, /MAX_PAGES|while \(true\)/);
  const hook = await read("src/github/useRepositoryListing.ts");
  assert.match(hook, /AbortController/);
  assert.match(hook, /LISTING_CACHE_MS/);
  assert.doesNotMatch(hook, /setTimeout|setInterval/, "no retry on a timer");
});
