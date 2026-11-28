import assert from "node:assert/strict";
import test from "node:test";
import { GITHUB_CONNECTION_PROBLEM_CODES } from "narrarium-engine";
import en from "../src/i18n/locales/serverGitHub.en.ts";
import it from "../src/i18n/locales/serverGitHub.it.ts";
import eagerEn from "../src/i18n/locales/en.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) => (value && typeof value === "object" ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
}
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w]+)/g)].map((match) => match[1]).sort();

test("the server's GitHub connection speaks both languages, with the same keys and the same placeholders", () => {
  const english = new Map(leaves(en));
  const italian = new Map(leaves(it));
  assert.deepEqual([...italian.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of english) {
    assert.equal(typeof value, "string", key);
    assert.ok(value.trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(italian.get(key)), placeholders(value), `${key}: placeholders`);
  }
});

test("the Italian is written in Italian: no sentence is the English one", () => {
  const italian = new Map(leaves(it));
  const same = leaves(en).filter(([key, value]) => italian.get(key) === value).map(([key]) => key).sort();
  assert.deepEqual(same, []);
});

test("every count has both plural forms in both languages", () => {
  for (const [name, locale] of Object.entries({ en, it })) {
    const keys = leaves(locale).map(([key]) => key);
    for (const key of keys.filter((entry) => entry.endsWith("_one"))) assert.ok(keys.includes(key.replace(/_one$/, "_other")), `${name}: ${key}`);
    for (const key of keys.filter((entry) => entry.endsWith("_other"))) assert.ok(keys.includes(key.replace(/_other$/, "_one")), `${name}: ${key}`);
  }
});

test("every problem code the server can say has its own sentence in both languages, so that nobody reads the server's English", () => {
  const codes = /** @type {readonly string[]} */ (GITHUB_CONNECTION_PROBLEM_CODES);
  for (const [name, locale] of Object.entries({ en, it })) {
    /** @type {Record<string, unknown>} */
    const problems = locale.serverGitHub.problems;
    for (const code of codes) assert.equal(typeof problems[code], "string", `${name}: ${code}`);
    assert.equal(typeof problems["renewal-failed-lost"], "string", `${name}: the lost connection has its own words`);
    assert.deepEqual(Object.keys(problems).filter((key) => !codes.includes(key) && key !== "renewal-failed-lost"), [], `${name}: nothing for a code the server does not say`);
  }
});

test("the two things the owner must switch on in the GitHub App are named as GitHub names them, in both languages", () => {
  for (const locale of [en, it]) {
    assert.match(locale.serverGitHub.problems["device-flow-disabled"], /Enable Device Flow/);
    assert.match(locale.serverGitHub.problems["expiring-tokens-off"], /Expire user authorization tokens/);
  }
});

test("these texts never redefine a key of the always-loaded texts or of the autopilot ones", () => {
  const mine = leaves(en).map(([key]) => key);
  for (const other of [eagerEn, autopilotEn]) {
    const keys = new Set(leaves(other).map(([key]) => key));
    assert.deepEqual(mine.filter((key) => keys.has(key)), []);
  }
});

test("the words the author reads when the server's connection is not there for a book are in both languages of the autopilot", () => {
  assert.equal(typeof autopilotEn.autopilot.errors.noGithubSite, "string");
  assert.equal(typeof autopilotIt.autopilot.errors.noGithubSite, "string");
});
