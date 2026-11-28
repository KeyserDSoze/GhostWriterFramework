import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import wildcardsEn from "../src/i18n/locales/wildcards.en.ts";
import wildcardsIt from "../src/i18n/locales/wildcards.it.ts";
import {
  liveAccountWildcards, mergeAccountWildcards, newerWildcardEntry, pruneAccountWildcardTombstones, removeAccountWildcard, upsertAccountWildcard, WILDCARD_TOMBSTONE_DAYS,
} from "../src/wildcards/accountWildcards.ts";

// The wildcards of the account (`settings.wildcards`): the texts of their files, kept with the account and synchronised; a deletion is a tombstone, and two
// copies that diverged keep every wildcard, each in its newest version. And the texts of the wildcards, in both languages, travel with their page.

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const file = (name) => `---\ntype: wildcard\nid: wildcard:custom:${name}\nname: ${name}\ngroup: provocateur\n---\n\nThink like ${name}.\n`;
const at = (minutes) => new Date(Date.UTC(2026, 10, 28, 8, minutes));

test("a wildcard is written into the account, changed in its place, and removed as a tombstone that keeps no text", () => {
  let settings = upsertAccountWildcard(undefined, { id: "wildcard:custom:hacker", slug: "hacker", text: file("hacker") }, at(0));
  settings = upsertAccountWildcard(settings, { id: "wildcard:custom:lawyer", slug: "lawyer", text: file("lawyer") }, at(1));
  settings = upsertAccountWildcard(settings, { id: "wildcard:custom:hacker", slug: "hacker", text: file("hacker2") }, at(2));
  assert.equal(settings.version, 1);
  assert.deepEqual(liveAccountWildcards(settings).map((entry) => [entry.slug, entry.updatedAt]), [["hacker", at(2).toISOString()], ["lawyer", at(1).toISOString()]]);
  assert.match(liveAccountWildcards(settings)[0].text, /hacker2/);
  settings = removeAccountWildcard(settings, "wildcard:custom:lawyer", at(3));
  assert.deepEqual(liveAccountWildcards(settings).map((entry) => entry.slug), ["hacker"]);
  assert.deepEqual(settings.entries[1], { id: "wildcard:custom:lawyer", slug: "lawyer", text: "", updatedAt: at(3).toISOString(), deletedAt: at(3).toISOString() });
  // An entry of a newer app that this one cannot read is kept as it is.
  const odd = /** @type {any} */ ({ id: 7, future: true });
  assert.deepEqual(upsertAccountWildcard({ entries: [odd] }, { id: "wildcard:custom:x", slug: "x", text: file("x") }, at(4)).entries[0], odd);
});

test("two copies that diverged keep every wildcard, each in its newest version; a deletion is not brought back, and wins a tie", () => {
  const base = upsertAccountWildcard(undefined, { id: "a", slug: "a", text: file("a") }, at(0));
  const here = upsertAccountWildcard(removeAccountWildcard(base, "a", at(5)), { id: "b", slug: "b", text: file("b") }, at(6));
  const there = upsertAccountWildcard(upsertAccountWildcard(base, { id: "a", slug: "a", text: file("a-edited") }, at(3)), { id: "c", slug: "c", text: file("c") }, at(7));
  const merged = mergeAccountWildcards(here, there);
  assert.deepEqual(merged.entries.map((entry) => entry.id), ["a", "b", "c"]);
  assert.equal(merged.entries[0].deletedAt, at(5).toISOString(), "the later deletion wins over the earlier edit");
  assert.deepEqual(liveAccountWildcards(merged).map((entry) => entry.id), ["b", "c"]);
  const tie = { id: "a", slug: "a", text: file("a"), updatedAt: at(9).toISOString() };
  assert.equal(newerWildcardEntry(tie, { ...tie, text: "", deletedAt: at(9).toISOString() }).deletedAt, at(9).toISOString());
  assert.equal(mergeAccountWildcards(undefined), undefined);
});

test("tombstones are dropped after a while, and only tombstones", () => {
  const now = at(0);
  const old = new Date(now.getTime() - (WILDCARD_TOMBSTONE_DAYS + 1) * 86_400_000).toISOString();
  const entries = [{ id: "gone", slug: "gone", text: "", updatedAt: old, deletedAt: old }, { id: "kept", slug: "kept", text: file("kept"), updatedAt: old }];
  assert.deepEqual(pruneAccountWildcardTombstones(entries, now).map((entry) => entry.id), ["kept"]);
});

test("the wildcards speak both languages, with the same texts and placeholders, and travel with their page, not with the app entry", () => {
  const english = new Map(leaves(wildcardsEn));
  const italian = new Map(leaves(wildcardsIt));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
  const same = new Set(["wildcards.presets.pre-mortem", "wildcards.toggle"]);
  assert.deepEqual(leaves(wildcardsEn).filter(([key, value]) => !same.has(key) && italian.get(key) === value).map(([key]) => key), [], "the Italian is written in Italian");
  assert.equal("wildcards" in en, false, "the always-loaded catalogue has none of them");
  assert.equal(en.nav.wildcards, "Wildcards", "only the name of the page in the book's menu");
  assert.match(read("../src/pages/WildcardsPage.tsx"), /^import "@\/i18n\/wildcards";$/m);
  assert.match(read("../src/router.tsx"), /path: "books\/:bookId\/wildcards", lazy: appPage\("WildcardsPage"\)/);
});
