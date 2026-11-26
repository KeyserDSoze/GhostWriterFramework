import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import costsEn from "../src/i18n/locales/costs.en.ts";
import costsIt from "../src/i18n/locales/costs.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";
import autopilotEn from "../src/i18n/locales/autopilot.en.ts";
import autopilotIt from "../src/i18n/locales/autopilot.it.ts";
import routingEn from "../src/i18n/locales/aiRouter.en.ts";
import routingIt from "../src/i18n/locales/aiRouter.it.ts";

/** @typedef {Record<string, any>} Tree */

/** The texts every key of a catalogue holds, by their path. @param {Tree} tree @param {string} [prefix] @returns {Map<string, string>} */
function leaves(tree, prefix = "", into = new Map()) {
  for (const [key, child] of Object.entries(tree ?? {})) {
    if (child && typeof child === "object") leaves(child, `${prefix}${key}.`, into);
    else into.set(`${prefix}${key}`, String(child));
  }
  return into;
}

/** @param {string} text */
const placeholders = (text) => Array.from(text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g), (match) => match[1]).sort();

const en = leaves(costsEn);
const it = leaves(costsIt);

test("the texts of the costs say the same things in English and in Italian: the same keys, the same placeholders", () => {
  assert.deepEqual([...en.keys()].sort(), [...it.keys()].sort(), "a key is in one language and not in the other");
  for (const [key, text] of en) {
    assert.ok(text.trim(), `${key} is empty in English`);
    assert.ok((it.get(key) ?? "").trim(), `${key} is empty in Italian`);
    assert.deepEqual(placeholders(it.get(key) ?? ""), placeholders(text), `${key} names other values in Italian than in English`);
  }
});

test("a text that is told in the plural has both forms, in both languages", () => {
  for (const catalogue of [en, it]) {
    for (const key of catalogue.keys()) {
      if (key.endsWith("_one")) assert.ok(catalogue.has(`${key.slice(0, -4)}_other`), `${key} has no _other`);
      if (key.endsWith("_other")) assert.ok(catalogue.has(`${key.slice(0, -6)}_one`), `${key} has no _one`);
    }
  }
});

test("every text the costs components and the dashboard ask for exists in both languages", async () => {
  const roots = ["src/components/costs", "src/components/autopilot/costs", "src/components/settings", "src/pages/CostsPage.tsx", "src/costs"];
  const files = [];
  const walk = async (path) => {
    const url = new URL(`../${path}`, import.meta.url);
    const entries = await readdir(url, { withFileTypes: true }).catch(() => null);
    if (!entries) { if (/\.(tsx?|ts)$/.test(path)) files.push(path); return; }
    for (const entry of entries) await walk(`${path}/${entry.name}`);
  };
  for (const root of roots) await walk(root);
  const entry = new Map([...leaves(entryEn), ...leaves(autopilotEn), ...leaves(routingEn)]);
  const entryItalian = new Map([...leaves(entryIt), ...leaves(autopilotIt), ...leaves(routingIt)]);
  const exists = (tree, key) => tree.has(key) || (tree.has(`${key}_one`) && tree.has(`${key}_other`));
  const missing = [];
  for (const path of files) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"((?:costs|settings\.cost\w*|routing\.task)[\w.]*)"/g)) {
      const key = match[1];
      if (!(exists(en, key) || exists(entry, key))) missing.push(`${path}: ${key} (English)`);
      if (!(exists(it, key) || exists(entryItalian, key))) missing.push(`${path}: ${key} (Italian)`);
    }
    for (const match of source.matchAll(/`((?:costs\.dashboard\.(?:filters\.periods|settings\.status|settings\.publish|table\.sorts|groupBy))\.)\$\{/g)) {
      assert.ok(match[1], path);
    }
  }
  assert.deepEqual(missing, []);
});

test("the periods, the states and the sorts the dashboard builds a key from all have a text", () => {
  for (const [group, values] of [
    ["costs.dashboard.filters.periods", ["month", "30d", "all", "custom"]],
    ["costs.dashboard.settings.status", ["idle", "running", "paused", "waiting-author", "error", "completed", "never"]],
    ["costs.dashboard.settings.publish", ["off", "chapter", "step"]],
    ["costs.dashboard.table.sorts", ["name", "spend", "tasks", "calls", "tokens"]],
    ["costs.dashboard.groupBy", ["books", "months", "sources"]],
    ["costs.dashboard.table.name", ["books", "months", "sources"]],
  ]) {
    for (const value of values) {
      assert.ok(en.has(`${group}.${value}`), `${group}.${value} (English)`);
      assert.ok(it.has(`${group}.${value}`), `${group}.${value} (Italian)`);
    }
  }
});
