import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import en from "../src/i18n/locales/en.ts";
import it from "../src/i18n/locales/it.ts";
import localFirstEn from "../src/i18n/locales/localFirst.en.ts";
import localFirstIt from "../src/i18n/locales/localFirst.it.ts";
import localFirstStatusEn from "../src/i18n/locales/localFirstStatus.en.ts";
import localFirstStatusIt from "../src/i18n/locales/localFirstStatus.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}

const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();
const SITE = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, SITE), "utf8");
// The texts of the shell and those of the repository status dialog, under the same `localFirst` keys.
const english = new Map([...leaves(localFirstEn), ...leaves(localFirstStatusEn)]);
const italian = new Map([...leaves(localFirstIt), ...leaves(localFirstStatusIt)]);

test("what a book kept on this device, without a credential, or offline, says speaks both languages, with the same texts and the same placeholders", () => {
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
  const shell = new Set(leaves(localFirstEn).map(([key]) => key));
  assert.deepEqual(leaves(localFirstStatusEn).map(([key]) => key).filter((key) => shell.has(key)), [], "a text lives in one bundle");
});

test("the Italian of those texts is written in Italian, not copied from English", () => {
  assert.deepEqual([...english].filter(([key, value]) => italian.get(key) === value).map(([key]) => key), []);
});

test("the texts travel with the shell of the app, those of the repository status with its dialog, which loads when it is opened", () => {
  for (const tree of [en, it]) assert.equal("localFirst" in tree, false);
  for (const file of ["src/components/layout/Topbar.tsx", "src/components/layout/FloatingActions.tsx", "src/components/repository/RepositoryStatusDialog.tsx", "src/components/book/BookStructureErrorAlert.tsx"]) {
    assert.match(source(file), /import "@\/i18n\/localFirst";/, file);
  }
  assert.match(source("src/components/repository/RepositoryStatusDialog.tsx"), /import "@\/i18n\/localFirstStatus";/);
  const topbar = source("src/components/layout/Topbar.tsx");
  assert.doesNotMatch(topbar, /import \{ RepositoryStatusDialog \}/, "the shell does not carry the dialog");
  assert.match(topbar, /lazy\(\(\) => import\("@\/components\/repository\/RepositoryStatusDialog"\)/);
});

test("every localFirst key the app uses exists", () => {
  const files = ["src/components/layout/Topbar.tsx", "src/components/layout/FloatingActions.tsx", "src/components/repository/RepositoryStatusDialog.tsx", "src/components/book/BookStructureErrorAlert.tsx", "src/pages/BookSettingsPage.tsx", "src/pages/BookDashboardPage.tsx", "src/hooks/useBookStructure.ts", "src/components/assistant/AssistantPanel.tsx"];
  for (const file of files) {
    for (const match of source(file).matchAll(/"(localFirst\.[A-Za-z.]+)"/g)) assert.ok(english.has(match[1]), `${file}: ${match[1]}`);
  }
  // The book that cannot be brought here says why with keys composed from the reason.
  for (const reason of ["Offline", "NoCredential"]) {
    for (const key of [`localFirst.notDownloaded${reason}`, `localFirst.branchNotDownloaded${reason}`, `localFirst.incomplete${reason}`]) assert.ok(english.has(key), key);
  }
});

test("without a credential the texts offer to connect GitHub, and never say that a token is required", () => {
  for (const [key, value] of english) {
    if (/NoCredential$/.test(key)) {
      assert.match(value, /connect GitHub/i, `${key} (en)`);
      assert.match(italian.get(key), /collega GitHub/i, `${key} (it)`);
    }
    assert.doesNotMatch(value, /token is required|add a GitHub credential/i, `${key} (en)`);
  }
  assert.equal(english.get("localFirst.connectGitHub"), "Connect GitHub");
  assert.equal(italian.get("localFirst.connectGitHub"), "Collega GitHub");
  assert.match(en.repositoryErrors["no-credential"], /connect GitHub/);
  assert.match(it.repositoryErrors["no-credential"], /collega GitHub/);
  // The local features no longer have a message about a missing token: what is gone stays gone.
  for (const tree of [en, it]) {
    assert.equal("noTokenConfigured" in tree.bookPage, false);
    assert.equal("toastNoBookToken" in tree.assistant, false);
  }
});

test("the stale warning about a missing token no longer says the book will not load: it loads from this device", () => {
  assert.doesNotMatch(en.bookSettings.noTokenWarning, /will not load/);
  assert.doesNotMatch(it.bookSettings.noTokenWarning, /non verrà caricato/);
});
