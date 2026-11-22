import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import catalogEn from "../src/i18n/locales/catalog.en.ts";
import catalogIt from "../src/i18n/locales/catalog.it.ts";
import endpointEn from "../src/i18n/locales/endpoint.en.ts";
import endpointIt from "../src/i18n/locales/endpoint.it.ts";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";

const SITE = new URL("../", import.meta.url);

/** @typedef {Record<string, any>} Tree */

/** @param {Tree} tree @param {string} path @returns {any} */
const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

/** The texts every key of a catalogue holds, by their path. @param {Tree} tree @param {string} [prefix] @returns {string[]} */
const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]));

/** A key exists when it is a text, or when it has the plural forms i18next picks from. @param {Tree} tree @param {string} key */
const exists = (tree, key) => typeof lookup(tree, key) === "string" || (typeof lookup(tree, `${key}_one`) === "string" && typeof lookup(tree, `${key}_other`) === "string");

/** @param {string} text */
const placeholders = (text) => Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

/** @typedef {{ name: string, endpoint: Tree, catalog: Tree, both: Tree, entry: Tree }} Language */
/** @type {Language[]} */
const LANGUAGES = [
  { name: "en", endpoint: endpointEn.endpoint, catalog: catalogEn.catalog, both: { endpoint: endpointEn.endpoint, catalog: catalogEn.catalog }, entry: entryEn },
  { name: "it", endpoint: endpointIt.endpoint, catalog: catalogIt.catalog, both: { endpoint: endpointIt.endpoint, catalog: catalogIt.catalog }, entry: entryIt },
];
const [EN, IT] = LANGUAGES;

const KINDS = ["text", "image", "speech", "transcription", "embedding", "other"];
const MEDIA = ["image", "speech", "transcription"];
const FIELDS = ["maxInputTokens", "maxOutputTokens", "supportsToolCalls", "supportsStreaming", "supportsReasoning", "supportsVision"];
const REASONS = ["unreachable", "timeout", "unauthorized", "not-found", "rate-limited", "server-error", "http-error", "invalid", "empty", "too-large", "unsupported", "unknown"];
const REMEDIES = ["key", "forbidden", "address", "wait", "busy", "other"];

test("both catalogues exist in both languages, each under its own name", () => {
  assert.deepEqual(Object.keys(endpointEn), ["endpoint"]);
  assert.deepEqual(Object.keys(endpointIt), ["endpoint"]);
  assert.deepEqual(Object.keys(catalogEn), ["catalog"]);
  assert.deepEqual(Object.keys(catalogIt), ["catalog"]);
});

test("the English and the Italian texts have the same keys and the same placeholders", () => {
  for (const group of ["endpoint", "catalog"]) {
    assert.deepEqual(leaves(IT[group]).sort(), leaves(EN[group]).sort(), `${group}: same keys`);
    for (const key of leaves(EN[group])) {
      assert.equal(typeof lookup(EN[group], key), "string", `${group}.${key} is a text`);
      assert.deepEqual(placeholders(lookup(IT[group], key)), placeholders(lookup(EN[group], key)), `${group}.${key}: same placeholders`);
      assert.ok(lookup(EN[group], key).trim().length > 0 && lookup(IT[group], key).trim().length > 0, `${group}.${key} is not empty`);
    }
  }
});

test("the Italian is not the English, except for the words that are the same in both", () => {
  const SAME = new Set(["catalog.group.embedding", "catalog.capability.streaming", "catalog.field.supportsStreaming"]);
  for (const group of ["endpoint", "catalog"]) {
    for (const key of leaves(EN[group])) {
      if (SAME.has(`${group}.${key}`)) continue;
      assert.notEqual(lookup(IT[group], key), lookup(EN[group], key), `${group}.${key} is translated`);
    }
  }
});

test("the buttons say what the design says, in both languages, and their names begin with the words on them and name the integration", () => {
  assert.equal(EN.endpoint.check, "Check the connection");
  assert.equal(IT.endpoint.check, "Verifica la connessione");
  assert.equal(EN.endpoint.read, "Read the models from the endpoint");
  assert.equal(IT.endpoint.read, "Leggi i modelli dall'endpoint");
  for (const { name, endpoint } of LANGUAGES) {
    for (const [visible, named] of [["check", "checkNamed"], ["read", "readNamed"]]) {
      assert.ok(endpoint[named].startsWith(endpoint[visible]), `${named} begins with the words of ${visible} (${name})`);
      assert.ok(endpoint[named].includes("{{name}}"), `${named} says which integration (${name})`);
    }
  }
});

test("the results say what the design says, in both languages", () => {
  assert.equal(EN.endpoint.result.ok_other, "Responds in {{ms}} ms · {{count}} models");
  assert.equal(EN.endpoint.result.ok_one, "Responds in {{ms}} ms · {{count}} model");
  assert.equal(IT.endpoint.result.ok_other, "Risponde in {{ms}} ms · {{count}} modelli");
  assert.equal(IT.endpoint.result.ok_one, "Risponde in {{ms}} ms · {{count}} modello");
  assert.equal(EN.endpoint.result.error, "Responds with error {{status}}: {{remedy}}");
  assert.equal(IT.endpoint.result.error, "Risponde con errore {{status}}: {{remedy}}");
  assert.equal(EN.endpoint.remedy.key, "check the key");
  assert.equal(IT.endpoint.remedy.key, "controlla la chiave");
  assert.match(EN.endpoint.result.unreachable, /^Not reachable: /);
  assert.match(IT.endpoint.result.unreachable, /^Non raggiungibile: /);
});

test("the browser cannot tell the server that is off from CORS, and the texts say so in both languages", () => {
  for (const { name, endpoint } of LANGUAGES) assert.match(endpoint.why, /CORS/, `why names CORS (${name})`);
  assert.match(EN.endpoint.why, /cannot tell/);
  assert.match(IT.endpoint.why, /non sa distinguer/);
  assert.match(EN.catalog.error.unreachable, /browser could not reach the endpoint/);
  assert.match(IT.catalog.error.unreachable, /browser non ha potuto raggiungere l'endpoint/);
});

test("the dialog says what the design says, in both languages", () => {
  assert.equal(EN.catalog.apply_other, "Add/update {{count}} models");
  assert.equal(EN.catalog.apply_one, "Add/update {{count}} model");
  assert.equal(IT.catalog.apply_other, "Aggiungi/aggiorna {{count}} modelli");
  assert.equal(IT.catalog.apply_one, "Aggiungi/aggiorna {{count}} modello");
  assert.equal(EN.catalog.source.only, "Only /models: limits and capabilities are not declared.");
  assert.equal(IT.catalog.source.only, "Solo /models: limiti e capacità non dichiarati.");
  assert.deepEqual(KINDS.map((kind) => EN.catalog.group[kind]), ["Text", "Images", "Text-to-speech", "Transcription", "Embedding", "Other"]);
  assert.deepEqual(KINDS.map((kind) => IT.catalog.group[kind]), ["Testo", "Immagini", "Sintesi vocale", "Trascrizione", "Embedding", "Altro"]);
  for (const { name, catalog } of LANGUAGES) {
    for (const kind of MEDIA) assert.equal(typeof catalog.media[kind], "string", `a text to offer each kind of model: ${kind} (${name})`);
    for (const field of FIELDS) assert.equal(typeof catalog.field[field], "string", `a name for each field that can be filled: ${field} (${name})`);
  }
});

test("every reason the engine gives for a catalog that cannot be read has its own text, and so has a failure that is none of them", () => {
  for (const { name, endpoint, catalog } of LANGUAGES) {
    for (const reason of REASONS) assert.equal(typeof catalog.error[reason], "string", `catalog.error.${reason} (${name})`);
    for (const remedy of REMEDIES) assert.equal(typeof endpoint.remedy[remedy], "string", `endpoint.remedy.${remedy} (${name})`);
  }
});

test("the texts that say a number have the two plural forms, and the figures are placeholders", () => {
  for (const { name, endpoint, catalog } of LANGUAGES) {
    assert.ok(endpoint.result.ok_one && endpoint.result.ok_other, `ok has both forms (${name})`);
    assert.ok(catalog.apply_one && catalog.apply_other, `apply has both forms (${name})`);
    for (const key of ["added", "updated", "media"]) assert.ok(catalog.done[`${key}_one`] && catalog.done[`${key}_other`], `done.${key} has both forms (${name})`);
    assert.ok(catalog.limits.window.includes("{{value}}") && catalog.limits.output.includes("{{value}}"), `the limits are placeholders (${name})`);
  }
});

test("every text the sources ask for exists in English and in Italian", async () => {
  /** @type {Array<{ file: string, text: string }>} */
  const found = [];
  for (const folder of ["src/components/settings/endpoint", "src/components/autopilot"]) {
    /** @type {string[]} */
    let entries = [];
    try {
      entries = await readdir(new URL(`${folder}/`, SITE));
    } catch {
      continue;
    }
    for (const entry of entries) if (/\.(ts|tsx)$/.test(entry)) found.push({ file: `${folder}/${entry}`, text: await readFile(new URL(`${folder}/${entry}`, SITE), "utf8") });
  }
  assert.ok(found.some((entry) => entry.file === "src/components/settings/endpoint/ModelCatalogDialog.tsx"), "the dialog is among the sources, so this check cannot pass by looking at nothing");
  assert.ok(found.some((entry) => entry.file === "src/components/settings/endpoint/EndpointTools.tsx"), "the tools of the card are too");

  /** @param {string} key @returns {string[]} */
  const expand = (key) => {
    if (!key.includes("${")) return [key];
    /** @param {string[]} values */
    const swap = (values) => values.map((value) => key.replace(/\$\{[^}]+\}/, value));
    if (key.startsWith("catalog.group.")) return swap(KINDS);
    if (key.startsWith("catalog.capability.")) return swap(["tools", "streaming", "reasoning", "vision"]);
    if (key.startsWith("catalog.field.")) return swap(FIELDS);
    if (key.startsWith("catalog.media.")) return swap(MEDIA);
    if (key.startsWith("catalog.error.")) return swap(REASONS);
    if (key.startsWith("endpoint.remedy.")) return swap(REMEDIES);
    throw new Error(`no expansion known for ${key}: add the values it can take`);
  };

  /** @type {string[]} */
  const missing = [];
  let asked = 0;
  for (const { file, text } of found) {
    for (const match of text.matchAll(/["'`]((?:endpoint|catalog)\.[A-Za-z0-9_.${}-]+)["'`]/g)) {
      asked += 1;
      for (const concrete of expand(match[1])) {
        for (const { name, both } of LANGUAGES) if (!exists(both, concrete)) missing.push(`${file}: ${concrete} (${name})`);
      }
    }
  }
  assert.ok(asked > 40, `the scan should see the keys of the tools and of the dialog (saw ${asked})`);
  assert.deepEqual(missing, []);
});

test("none of the texts is in the catalogue of the app entry: they travel with the chunks that show them", () => {
  for (const { name, entry } of LANGUAGES) {
    assert.equal(entry.endpoint, undefined, `endpoint.* must stay out of the entry catalogue (${name})`);
    assert.equal(entry.catalog, undefined, `catalog.* must stay out of the entry catalogue (${name})`);
  }
});

/** Every file of `src/` that matches, by path. @param {RegExp} pattern @returns {Promise<string[]>} */
async function importersOf(pattern) {
  /** @type {string[]} */
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry) || entry.startsWith("lib/generated-docs")) continue;
    const text = await readFile(new URL(`src/${entry}`, SITE), "utf8");
    if (pattern.test(text)) importers.push(`src/${entry}`);
  }
  return importers.sort();
}

test("only the card of the integration, the check button and its result line, the dialog and the panel of the autopilot's error import the texts of the check, so the app entry cannot pull them in", async () => {
  const importers = await importersOf(/["']@\/i18n\/endpoint["']|locales\/endpoint\./);
  assert.deepEqual(importers, [
    "src/components/autopilot/ConnectionCheck.tsx",
    "src/components/settings/endpoint/EndpointCheckButton.tsx",
    "src/components/settings/endpoint/EndpointCheckResult.tsx",
    "src/components/settings/endpoint/EndpointTools.tsx",
    "src/components/settings/endpoint/ModelCatalogDialog.tsx",
    "src/i18n/endpoint.ts",
  ]);
});

test("only the dialog imports the texts of the dialog, and it is the only one that imports the reading of the catalog and its plan, which it needs and the card does not", async () => {
  assert.deepEqual(await importersOf(/["']@\/i18n\/catalog["']|locales\/catalog\./), ["src/components/settings/endpoint/ModelCatalogDialog.tsx", "src/i18n/catalog.ts"]);
  assert.deepEqual(await importersOf(/from ["']@\/ai\/catalogPlan["']/), ["src/components/settings/endpoint/ModelCatalogDialog.tsx"]);
  assert.deepEqual(await importersOf(/from ["']@\/ai\/endpointTools["']/), ["src/components/settings/endpoint/ModelCatalogDialog.tsx"]);
});

test("the dialog is loaded when it is opened and not with the page, and the check is loaded when it is pressed: nothing of the engine's catalog is in the way to the settings page", async () => {
  const tools = await readFile(new URL("src/components/settings/endpoint/EndpointTools.tsx", SITE), "utf8");
  assert.match(tools, /lazy\(\(\) => import\(["']\.\/ModelCatalogDialog["']\)\)/, "the dialog is a lazy component");
  assert.doesNotMatch(tools, /^import .*ModelCatalogDialog/m, "and has no static import");
  const hook = await readFile(new URL("src/components/settings/endpoint/useEndpointCheck.ts", SITE), "utf8");
  assert.match(hook, /import\(["']@\/ai\/endpointTools["']\)/, "the check is loaded on demand");
  assert.doesNotMatch(hook, /^import .*@\/ai\/endpointTools/m, "and has no static import");
  for (const file of [
    "src/components/settings/endpoint/EndpointTools.tsx",
    "src/components/settings/endpoint/useEndpointCheck.ts",
    "src/components/settings/endpoint/EndpointCheckButton.tsx",
    "src/components/settings/endpoint/EndpointCheckResult.tsx",
    "src/components/autopilot/ConnectionCheck.tsx",
    "src/autopilot/errorModel.ts",
  ]) {
    const text = await readFile(new URL(file, SITE), "utf8");
    assert.doesNotMatch(text, /fetchModelCatalog|probeEndpoint|modelFieldsFromCatalogEntry/, `${file} does not call the catalog of the engine`);
  }
});
