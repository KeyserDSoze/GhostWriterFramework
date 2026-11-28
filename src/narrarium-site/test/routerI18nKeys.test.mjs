import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import aiRouterEn from "../src/i18n/locales/aiRouter.en.ts";
import aiRouterIt from "../src/i18n/locales/aiRouter.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

const SITE = new URL("../", import.meta.url);

/** What i18next holds once the settings page has loaded: the texts of the tables added to those of the entry, never over them. */
function withLazy(entry, lazy) {
  const merged = { ...entry };
  for (const [key, value] of Object.entries(lazy)) {
    if (value && typeof value === "object" && entry[key] && typeof entry[key] === "object") merged[key] = withLazy(entry[key], value);
    else if (!(key in entry)) merged[key] = value;
  }
  return merged;
}

const en = withLazy(entryEn, aiRouterEn);
const it = withLazy(entryIt, aiRouterIt);

function lookup(tree, path) {
  return path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
}

/** A key exists when it is a text, or when it has the plural forms i18next picks from. */
function exists(tree, key) {
  return typeof lookup(tree, key) === "string" || (typeof lookup(tree, `${key}_one`) === "string" && typeof lookup(tree, `${key}_other`) === "string");
}

async function sources() {
  const found = [];
  for (const folder of ["src/router", "src/components/settings/router"]) {
    let entries = [];
    try {
      entries = await readdir(new URL(`${folder}/`, SITE));
    } catch {
      continue;
    }
    for (const entry of entries) if (/\.(ts|tsx)$/.test(entry)) found.push({ file: `${folder}/${entry}`, text: await readFile(new URL(`${folder}/${entry}`, SITE), "utf8") });
  }
  return found;
}

const CHAT = ["default", "editor-actions", "copilot", "brainstorming", "simple-tasks", "review", "wildcards", "chat-resume", "reader-evaluation", "reader-evaluation-summary", "rewrite-from-reader-feedback", "deep-research", "create-from-research", "audit", "autopilot", "director"];

test("the router sources exist, so that this check cannot pass by looking at nothing", async () => {
  const files = await sources();
  assert.ok(files.some((entry) => entry.file === "src/router/routerTableModel.ts"), "src/router/routerTableModel.ts");
  assert.ok(files.some((entry) => entry.file.startsWith("src/components/settings/router/")), "components of the router tables");
});

test("every routing text the new router sources ask for exists in English and in Italian", async () => {
  const missing = [];
  let asked = 0;
  for (const { file, text } of await sources()) {
    for (const match of text.matchAll(/["'`](routing\.[A-Za-z0-9_.${}-]+)["'`]/g)) {
      const key = match[1];
      asked += 1;
      const expanded = key.includes("${") ? expandTemplate(key) : [key];
      for (const concrete of expanded) {
        for (const [name, tree] of [["en", en], ["it", it]]) if (!exists(tree, concrete)) missing.push(`${file}: ${concrete} (${name})`);
      }
    }
  }
  assert.ok(asked > 40, `the scan should see the keys of the router tables (saw ${asked})`);
  assert.deepEqual(missing, []);
});

/** `routing.taskHelp.${task}` and the like: every value the sources can put there. */
function expandTemplate(key) {
  if (key.startsWith("routing.taskHelp.") || key.startsWith("routing.task.")) return [...CHAT, "tts", "stt", "image"].map((task) => key.replace(/\$\{[^}]+\}/, task));
  if (key.startsWith("routing.thinking.hint.")) return ["inherit", "automatic", "low", "medium", "high", "xhigh"].map((level) => key.replace(/\$\{[^}]+\}/, level));
  if (key.startsWith("routing.thinking.")) return ["inherit", "automatic", "low", "medium", "high", "xhigh"].map((level) => key.replace(/\$\{[^}]+\}/, level));
  if (key.startsWith("routing.groups.")) return ["all", "autopilot", "copilot", "review", "research"].map((group) => key.replace(/\$\{[^}]+\}/, group));
  if (key.startsWith("routing.result.reason.")) return ["noTarget", "noPrimary", "gap", "noModel", "invalidModel", "limit"].map((reason) => key.replace(/\$\{[^}]+\}/, reason));
  if (key.startsWith("routing.sections.")) return ["text", "tts", "stt", "image"].map((id) => key.replace(/\$\{[^}]+\}/, id));
  throw new Error(`no expansion known for ${key}: add the values it can take`);
}

test("every task and every level has its own text in both languages, and the Italian is not the English", () => {
  for (const task of [...CHAT, "tts", "stt", "image"]) {
    for (const [name, tree] of [["en", en], ["it", it]]) assert.ok(typeof lookup(tree, `routing.taskHelp.${task}`) === "string", `routing.taskHelp.${task} (${name})`);
  }
  for (const level of ["inherit", "automatic", "low", "medium", "high", "xhigh"]) {
    for (const group of ["thinking", "thinking.hint"]) {
      const key = `routing.${group}.${level}`;
      assert.ok(typeof lookup(en, key) === "string" && typeof lookup(it, key) === "string", key);
    }
  }
  for (const key of ["routing.options.title", "routing.groups.copilot", "routing.groups.review", "routing.groups.research", "routing.filters.onlyCustom", "routing.badge.custom", "routing.tabs.delete", "routing.undo", "routing.warn.noToolCalls", "routing.warn.structuredSteps", "routing.thinking.automatic", "routing.cell.noFallback"]) {
    assert.notEqual(lookup(it, key), lookup(en, key), `${key} is translated`);
  }
});

test("the Italian and the English texts of the router have the same keys", () => {
  const keys = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? keys(child, `${prefix}${key}.`) : [`${prefix}${key}`]));
  assert.deepEqual(keys(it.routing).sort(), keys(en.routing).sort());
});

test("the texts of the tables are not in the app entry: they are bundled with the settings page", () => {
  const groups = Object.keys(aiRouterEn.routing);
  assert.ok(groups.length >= 10, `the lazy catalogue holds the groups of the tables (saw ${groups.length})`);
  assert.deepEqual(Object.keys(aiRouterIt.routing).sort(), groups.slice().sort(), "both languages bundle the same groups");
  const entries = Object.entries({ en: entryEn, it: entryIt });
  for (const group of groups) {
    for (const [name, tree] of entries) assert.equal(tree.routing[group], undefined, `routing.${group} (${name}) must stay out of the entry catalogue`);
  }
  for (const [name, tree] of entries) assert.equal(typeof tree.routing.task.default, "string", `routing.task (${name}) stays in the entry: the custom actions page uses it`);
});

test("only the views of the settings page import the lazy catalogue (the router tables, the request fields of the integration card, the thinking parameter, the API version, the API protocol and address, and the thinking with tools of a model and the lazy dialog that reads the models of an endpoint, which shows the same suggestion), so the app entry cannot pull it in", async () => {
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    const text = await readFile(new URL(`src/${entry}`, SITE), "utf8");
    if (/["']@\/i18n\/aiRouter["']|locales\/aiRouter\./.test(text)) importers.push(`src/${entry}`);
  }
  assert.deepEqual(importers.sort(), [
    "src/components/settings/IntegrationRequestFields.tsx",
    "src/components/settings/ModelApiVersionField.tsx",
    "src/components/settings/ModelRequestFields.tsx",
    "src/components/settings/NoThinkingWithToolsField.tsx",
    "src/components/settings/PromptCachingField.tsx",
    "src/components/settings/ReasoningParameterField.tsx",
    "src/components/settings/endpoint/ModelCatalogDialog.tsx",
    "src/components/settings/router/RouterSections.tsx",
    "src/i18n/aiRouter.ts",
  ]);
});
