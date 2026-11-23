import assert from "node:assert/strict";
import test from "node:test";
import { read } from "./support/sources.mjs";
import enTexts from "../src/i18n/locales/githubCreateBook.en.ts";
import itTexts from "../src/i18n/locales/githubCreateBook.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

/**
 * The texts of the creation of a repository on GitHub (`github.createBook.*`) are two catalogues of their own, registered by one module that the two pages
 * that create a repository import: the app entry does not carry them. Every failure code of the service has its words in both languages.
 */

const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]]));
const placeholders = (text) => Array.from(String(text).matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

test("the two catalogues have the same keys under github.createBook, none empty, each translated, with the same placeholders", () => {
  assert.deepEqual(Object.keys(enTexts), ["github"]);
  assert.deepEqual(Object.keys(itTexts), ["github"]);
  assert.deepEqual(Object.keys(enTexts.github), ["createBook"]);
  const en = new Map(leaves(enTexts));
  const it = new Map(leaves(itTexts));
  assert.deepEqual([...it.keys()].sort(), [...en.keys()].sort());
  assert.ok(en.size > 100, `${en.size} texts`);
  for (const [key, text] of en) {
    assert.equal(typeof text, "string");
    assert.ok(text.trim() && String(it.get(key)).trim(), `${key} is not empty`);
    assert.notEqual(it.get(key), text, `${key} is translated`);
    assert.deepEqual(placeholders(it.get(key)), placeholders(text), `${key}: same placeholders`);
  }
});

test("every failure the service can report has its words, and every reason of a failed first commit too", async () => {
  const service = await read("src/github/bookRepository.ts");
  const codes = [...(/export type BookRepositoryErrorCode =([^;]*);/.exec(service)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(codes.length >= 14, `${codes.length} codes`);
  for (const code of codes) assert.ok(code in enTexts.github.createBook.error, `error.${code} exists`);
  for (const reason of ["rate-limit", "rate-limit-unknown", "abuse-limit", "credential-invalid", "permission", "permission-unverified", "network", "service-unavailable", "other"]) assert.ok(reason in enTexts.github.createBook.error.reason, `error.reason.${reason} exists`);
  const preflight = [...(/export type BookRepositoryPreflightIssue =([^;]*);/.exec(service)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
  const panel = await read("src/components/book/GitHubRepositoryPanel.tsx");
  for (const issue of preflight) assert.match(panel, new RegExp(`"${issue}": "`), `the panel says ${issue}`);
});

test("the texts are not in the catalogue of the app entry and only the creation's own modules register them", async () => {
  for (const entry of [/** @type {Record<string, unknown>} */ (entryEn), /** @type {Record<string, unknown>} */ (entryIt)]) assert.equal(entry.github, undefined);
  const registration = await read("src/i18n/githubCreateBook.ts");
  assert.match(registration, /registerTranslations\(githubCreateBookEn, githubCreateBookIt\)/);
  for (const file of ["src/pages/AddBookPage.tsx", "src/pages/BookSettingsPage.tsx", "src/components/book/GitHubRepositoryPanel.tsx", "src/components/book/GitHubRepositoryOutcome.tsx"]) {
    assert.match(await read(file), /import "@\/i18n\/githubCreateBook";/, `${file} loads its catalogue`);
  }
});

test("the interface of the creation has real labels, a group for the visibility, a live region for the progress and 44 px targets under a finger", async () => {
  const panel = await read("src/components/book/GitHubRepositoryPanel.tsx");
  assert.match(panel, /<Label htmlFor=\{`\$\{base\}-owner`\}>/, "the owner select has a label");
  assert.match(panel, /<fieldset[^>]*>\s*<legend/, "the visibility is a fieldset with a legend");
  assert.match(panel, /type="radio"/);
  assert.match(panel, /\[@media\(pointer:coarse\)\]:h-11/, "the fields are 44 px under a finger");
  const outcome = await read("src/components/book/GitHubRepositoryOutcome.tsx");
  assert.match(outcome, /role="status" aria-live="polite"/, "the progress is polite");
  assert.match(outcome, /tabIndex=\{-1\}/, "the result can take the focus");
  assert.match(outcome, /\[@media\(pointer:coarse\)\]:min-h-11/, "the buttons are 44 px under a finger");
  assert.match(outcome, /rel="noopener noreferrer"/);
});
