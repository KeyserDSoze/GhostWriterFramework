import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/githubApp.en.ts";
import it from "../src/i18n/locales/githubApp.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import createEn from "../src/i18n/locales/githubCreateBook.en.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();

test("Connect with GitHub speaks both languages, with the same keys and the same placeholders", () => {
  const english = new Map(leaves(en));
  const italian = new Map(leaves(it));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim() || key.endsWith("panelAppToken"), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian is written in Italian, except the names that are the same in both", () => {
  const italian = new Map(leaves(it));
  const same = leaves(en).filter(([key, value]) => italian.get(key) === value).map(([key]) => key).sort();
  assert.deepEqual(same, ["accountSync.github.books.line", "accountSync.github.pat.placeholder"]);
});

test("every count has both plural forms in both languages", () => {
  for (const [name, locale] of [["en", en], ["it", it]]) {
    const keys = leaves(locale).map(([key]) => key);
    for (const key of keys.filter((entry) => entry.endsWith("_one"))) assert.ok(keys.includes(key.replace(/_one$/, "_other")), `${name}: ${key}`);
    for (const key of keys.filter((entry) => entry.endsWith("_other"))) assert.ok(keys.includes(key.replace(/_other$/, "_one")), `${name}: ${key}`);
  }
});

test("these texts never redefine a key of the always-loaded or the creation texts", () => {
  const mine = leaves(en).map(([key]) => key);
  for (const locale of [eagerEn, createEn]) {
    const other = new Set(leaves(locale).map(([key]) => key));
    assert.deepEqual(mine.filter((key) => other.has(key)), []);
  }
});

test("the card says the three things the owner asked for in plain words", () => {
  assert.match(en.accountSync.github.notEnabled, /not enabled on this site yet/);
  assert.match(en.accountSync.github.server.warning, /App tokens last 8 hours; for a book your server runs, use a personal access token \(or keep the browser open\)\./);
  assert.match(en.accountSync.github.pat.help, /personal server/);
  assert.match(en.accountSync.github.pat.help, /several GitHub accounts/);
  assert.match(en.accountSync.github.pat.help, /organization does not allow the app/);
  assert.match(it.accountSync.github.notEnabled, /non è ancora attivo/);
  assert.match(it.accountSync.github.pat.help, /server personale/);
});

test("the guides explain both ways to sign in, the install step, the PAT permissions and the server-run books, in both languages", () => {
  const read = (name) => readFileSync(new URL(`../src/content/guides/${name}`, import.meta.url), "utf8");
  for (const [file, needles] of [
    ["github-sync.en.md", ["Connect with GitHub", "personal access token", "Choose repositories on GitHub", "Repository creation", "Workflows", "8 hours", "personal server"]],
    ["github-sync.it.md", ["Connetti con GitHub", "token di accesso personale", "Scegli i repository su GitHub", "Repository creation", "Workflows", "8 ore", "server personale"]],
    ["first-book.en.md", ["Connect with GitHub", "personal access token", "Repository creation", "Workflows"]],
    ["first-book.it.md", ["Connetti con GitHub", "token di accesso personale", "Repository creation", "Workflows"]],
  ]) for (const needle of needles) assert.ok(read(file).includes(needle), `${file}: ${needle}`);
});
