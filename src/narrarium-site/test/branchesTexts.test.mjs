import assert from "node:assert/strict";
import test from "node:test";
import shellEn from "../src/i18n/locales/branchesShell.en.ts";
import shellIt from "../src/i18n/locales/branchesShell.it.ts";
import branchesEn from "../src/i18n/locales/branches.en.ts";
import branchesIt from "../src/i18n/locales/branches.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import localFirstEn from "../src/i18n/locales/localFirst.en.ts";

const leaves = (tree, prefix = "") => Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1]).sort();

const bundles = [["branchesShell", shellEn, shellIt], ["branches", branchesEn, branchesIt]];

for (const [name, en, it] of bundles) {
  test(`the texts of the branches (${name}) have the same keys and placeholders in English and Italian, none empty, the Italian in Italian`, () => {
    const italian = new Map(leaves(it));
    assert.deepEqual([...italian.keys()].sort(), leaves(en).map(([key]) => key).sort());
    for (const [key, value] of leaves(en)) {
      assert.ok(value.trim(), key);
      assert.ok(italian.get(key).trim(), `${key} (it)`);
      assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
      assert.notEqual(italian.get(key), value, `${key}: not translated`);
    }
  });

  test(`the texts of the branches (${name}) never redefine a key of the always-loaded texts or of the shell`, () => {
    for (const locale of [eagerEn, localFirstEn, ...bundles.filter(([other]) => other !== name).map(([, other]) => other)]) {
      const other = new Set(leaves(locale).map(([key]) => key));
      assert.deepEqual(leaves(en).map(([key]) => key).filter((key) => other.has(key)), []);
    }
  });
}
