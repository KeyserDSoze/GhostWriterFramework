import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import conflictsEn from "../src/i18n/locales/repositoryConflicts.en.ts";
import conflictsIt from "../src/i18n/locales/repositoryConflicts.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import eagerIt from "../src/i18n/locales/it.ts";

const leaves = (tree, prefix = "") => Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((match) => match[1]).sort();
const source = (path) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");

/** The texts that are the same in both languages: made of placeholders and signs only. */
const SAME_IN_BOTH = new Set(["repositoryConflicts.side.sized", "repositoryConflicts.progress.announce"]);

test("the texts of the resolver of the conflicts have the same keys and placeholders in English and Italian, none empty, the Italian in Italian", () => {
  const italian = new Map(leaves(conflictsIt));
  assert.deepEqual([...italian.keys()].sort(), leaves(conflictsEn).map(([key]) => key).sort());
  for (const [key, value] of leaves(conflictsEn)) {
    assert.ok(value.trim(), key);
    assert.ok(italian.get(key).trim(), `${key} (it)`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
    if (!SAME_IN_BOTH.has(key)) assert.notEqual(italian.get(key), value, `${key}: not translated`);
  }
});

test("the resolver's texts travel with its window: the shell neither carries them nor loads the window before a sync finds conflicts", () => {
  const eager = new Set(leaves(eagerEn).map(([key]) => key));
  assert.deepEqual(leaves(conflictsEn).map(([key]) => key).filter((key) => eager.has(key)), []);
  for (const moved of ["conflictsTitle", "conflictsDescription", "keepLocal", "keepRemote", "applyConflictChoices", "diffDirection", "fileDeletedLocally", "fileDeletedRemotely", "binaryConflict", "conflictChoicesStale"]) {
    assert.equal(moved in eagerEn.repoStatus, false, `repoStatus.${moved} (en)`);
    assert.equal(moved in eagerIt.repoStatus, false, `repoStatus.${moved} (it)`);
  }
  const topbar = source("src/components/layout/Topbar.tsx");
  assert.doesNotMatch(topbar, /import \{ RepositorySyncConflictDialog \}/, "the shell does not carry the resolver");
  assert.match(topbar, /lazy\(\(\) => import\("@\/components\/repository\/RepositorySyncConflictDialog"\)/);
  assert.match(source("src/components/repository/RepositorySyncConflictDialog.tsx"), /^import "@\/i18n\/repositoryConflicts";/);
});

test("every text the resolver asks for exists, also the ones it composes from a step or a notice", () => {
  const english = new Set(leaves(conflictsEn).map(([key]) => key));
  const has = (key) => english.has(key) || english.has(`${key}_one`);
  const dialog = source("src/components/repository/RepositorySyncConflictDialog.tsx");
  for (const match of dialog.matchAll(/"(repositoryConflicts\.[A-Za-z.]+)"/g)) assert.ok(has(match[1]), match[1]);
  for (const step of ["waiting", "checking", "downloading", "merging", "committing", "publishing"]) assert.ok(english.has(`repositoryConflicts.progress.step.${step}`), step);
  for (const notice of ["stopped", "stale", "changed", "nothing"]) assert.ok(english.has(`repositoryConflicts.notice.${notice}`), notice);
});

test("the pill and the sync say what is true in both languages: checking, no copy, why it does not sync, and what is still only here", () => {
  for (const [language, tree] of Object.entries({ en: eagerEn, it: eagerIt })) {
    for (const key of ["checkingLocal", "notCloned", "githubNotConnected", "githubSignInAgain", "syncDone", "syncUnpublished_one", "syncUnpublished_other"]) assert.ok(tree.repoStatus[key]?.trim(), `${language}: repoStatus.${key}`);
    assert.deepEqual(placeholders(tree.repoStatus.syncDone), ["kept", "pulled", "pushed"], `${language}: syncDone`);
    assert.deepEqual(placeholders(tree.repoStatus.githubSignInAgain), ["status"]);
    assert.doesNotMatch(tree.repoStatus.notCloned, /not ready|non pronto/i, `${language}: a missing copy is said as missing`);
  }
});
