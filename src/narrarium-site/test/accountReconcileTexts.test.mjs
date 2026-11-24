import assert from "node:assert/strict";
import test from "node:test";
import en from "../src/i18n/locales/accountReconcile.en.ts";
import it from "../src/i18n/locales/accountReconcile.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import githubEn from "../src/i18n/locales/githubApp.en.ts";
import githubIt from "../src/i18n/locales/githubApp.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();

test("the dialog of different account copies speaks both languages, with the same keys and placeholders", () => {
  const italian = new Map(leaves(it));
  assert.deepEqual([...italian.keys()].sort(), leaves(en).map(([key]) => key).sort());
  for (const [key, value] of leaves(en)) {
    assert.ok(value.trim(), key);
    assert.notEqual(italian.get(key), value, `${key} is translated`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the primary action and the promise of no overwrite are in the words the owner asked for", () => {
  assert.equal(en.accountSync.reconcile.useNewest, "Use the newest copy");
  assert.equal(it.accountSync.reconcile.useNewest, "Usa la copia più recente");
  assert.match(en.accountSync.reconcile.intro, /No copy will be overwritten until you choose/);
  assert.match(it.accountSync.reconcile.intro, /Nessuna copia verrà sovrascritta finché non scegli/);
});

test("these texts never redefine a key of the always-loaded texts", () => {
  const other = new Set(leaves(eagerEn).map(([key]) => key));
  assert.deepEqual(leaves(en).map(([key]) => key).filter((key) => other.has(key)), []);
});

test("the GitHub card explains the narrarium.settings failure in both languages, with the same keys", () => {
  for (const key of ["automatic", "unreachableTitle", "unreachable", "unreachableFix", "retry", "retrying"]) {
    assert.ok(githubEn.accountSync.github.settings[key]?.trim(), `en ${key}`);
    assert.ok(githubIt.accountSync.github.settings[key]?.trim(), `it ${key}`);
    assert.notEqual(githubIt.accountSync.github.settings[key], githubEn.accountSync.github.settings[key], key);
  }
  assert.match(githubEn.accountSync.github.settings.unreachableFix, /narrarium\.settings/);
  assert.match(githubEn.accountSync.github.settings.unreachableFix, /personal access token/);
  assert.match(githubIt.accountSync.github.settings.unreachableFix, /token di accesso personale/);
});
