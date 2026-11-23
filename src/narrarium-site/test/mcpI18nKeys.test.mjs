import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";
import mcpEn from "../src/i18n/locales/mcp.en.ts";
import mcpIt from "../src/i18n/locales/mcp.it.ts";

const SITE = new URL("../", import.meta.url);
const SECTION = "src/components/book/McpServerSection.tsx";

/** @typedef {Record<string, any>} Tree */

/** @param {Tree} tree @param {string} path @returns {any} */
const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

/** The texts every key of a catalogue holds, by their path. @param {Tree} tree @param {string} [prefix] @returns {string[]} */
const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]));

/** A key exists when it is a text, or when it has the plural forms i18next picks from. @param {Tree} tree @param {string} key */
const exists = (tree, key) => typeof lookup(tree, key) === "string" || (typeof lookup(tree, `${key}_one`) === "string" && typeof lookup(tree, `${key}_other`) === "string");

/** @param {string} text */
const placeholders = (text) => Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

const LANGUAGES = [
  { name: "en", mcp: mcpEn.mcp, both: { mcp: mcpEn.mcp }, entry: /** @type {Tree} */ (entryEn) },
  { name: "it", mcp: mcpIt.mcp, both: { mcp: mcpIt.mcp }, entry: /** @type {Tree} */ (entryIt) },
];
const [EN, IT] = LANGUAGES;
/** What an app may do, as the server says it (`ServerMcpClientScope`). */
const SCOPES = ["read", "write", "run"];

test("the catalogue exists in both languages, under its own name", () => {
  assert.deepEqual(Object.keys(mcpEn), ["mcp"]);
  assert.deepEqual(Object.keys(mcpIt), ["mcp"]);
});

test("the English and the Italian texts have the same keys and the same placeholders, and none is empty", () => {
  assert.deepEqual(leaves(IT.mcp).sort(), leaves(EN.mcp).sort());
  for (const key of leaves(EN.mcp)) {
    assert.equal(typeof lookup(EN.mcp, key), "string", `mcp.${key} is a text`);
    assert.deepEqual(placeholders(lookup(IT.mcp, key)), placeholders(lookup(EN.mcp, key)), `mcp.${key}: same placeholders`);
    assert.ok(lookup(EN.mcp, key).trim() && lookup(IT.mcp, key).trim(), `mcp.${key} is not empty`);
  }
});

test("the Italian is not the English", () => {
  for (const key of leaves(EN.mcp)) assert.notEqual(lookup(IT.mcp, key), lookup(EN.mcp, key), `mcp.${key} is translated`);
});

test("the section says what it must, in both languages", () => {
  assert.equal(EN.mcp.title, "MCP server");
  assert.equal(IT.mcp.title, "Server MCP");
  // Switching off and changing the address disconnect every app: the questions say so before anything changes.
  assert.match(EN.mcp.confirm.off, /disconnected/);
  assert.match(EN.mcp.confirm.slug, /disconnected/);
  assert.match(IT.mcp.confirm.off, /scollegat/);
  assert.match(IT.mcp.confirm.slug, /scollegat/);
  // One plain sentence on prompt injection: what reads the book can be talked into using the tools; write only to apps you trust; a commit can be undone.
  for (const { name, mcp } of LANGUAGES) {
    assert.equal(mcp.warning.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `the warning is one sentence (${name})`);
    assert.match(mcp.warning, /commit/, `the warning says that every change is a commit (${name})`);
  }
  assert.match(EN.mcp.warning, /talked into using the tools/);
  assert.match(EN.mcp.warning, /trust/);
  assert.match(EN.mcp.warning, /undo/);
  assert.match(IT.mcp.warning, /convinto a usare gli strumenti/);
  assert.match(IT.mcp.warning, /fidi/);
  assert.match(IT.mcp.warning, /annullare/);
  // Passkeys and the log of the calls live in the admin panel of the server.
  assert.match(EN.mcp.admin, /passkeys/);
  assert.match(EN.mcp.admin, /admin panel/);
  assert.match(IT.mcp.admin, /passkey/);
  assert.match(IT.mcp.admin, /pannello di amministrazione/);
  for (const { name, mcp } of LANGUAGES) {
    for (const scope of SCOPES) assert.equal(typeof mcp.apps.scope[scope], "string", `what ${scope} allows, in words (${name})`);
    assert.ok(mcp.connect.token.body.includes("{{placeholder}}"), `the instructions name the placeholder of the token, not a token (${name})`);
  }
});

test("the texts that say a number have both plural forms", () => {
  for (const { name, mcp } of LANGUAGES) {
    assert.ok(mcp.confirm.connected_one && mcp.confirm.connected_other, `confirm.connected (${name})`);
    assert.ok(mcp.confirm.connected_one.includes("{{count}}") && mcp.confirm.connected_other.includes("{{count}}"), `the number is a placeholder (${name})`);
  }
});

test("every text the section asks for exists in English and in Italian", async () => {
  const text = await readFile(new URL(SECTION, SITE), "utf8");
  /** @param {string} key @returns {string[]} */
  const expand = (key) => {
    if (!key.includes("${")) return [key];
    if (key.startsWith("mcp.apps.scope.")) return SCOPES.map((scope) => key.replace(/\$\{[^}]+\}/, scope));
    throw new Error(`no expansion known for ${key}: add the values it can take`);
  };
  /** @type {string[]} */
  const missing = [];
  let asked = 0;
  for (const match of text.matchAll(/["'`](mcp\.[A-Za-z0-9_.${}-]+)["'`]/g)) {
    asked += 1;
    for (const concrete of expand(match[1])) {
      for (const { name, both } of LANGUAGES) if (!exists(both, concrete)) missing.push(`${concrete} (${name})`);
    }
  }
  assert.ok(asked > 30, `the scan should see the keys of the section (saw ${asked})`);
  assert.deepEqual(missing, []);
});

test("none of the texts is in the catalogue of the app entry: they travel with the settings page of the book", () => {
  for (const { name, entry } of LANGUAGES) assert.equal(entry.mcp, undefined, `mcp.* must stay out of the entry catalogue (${name})`);
});

/** Every file of `src/` whose text matches, by path. @param {RegExp} pattern @returns {Promise<string[]>} */
async function importersOf(pattern) {
  /** @type {string[]} */
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    if (!/\.(ts|tsx)$/.test(entry) || entry.startsWith("lib/generated-docs")) continue;
    if (pattern.test(await readFile(new URL(`src/${entry}`, SITE), "utf8"))) importers.push(`src/${entry.split("\\").join("/")}`);
  }
  return importers.sort();
}

test("only the section imports its texts, and only the settings page of the book, a lazy route, imports the section", async () => {
  assert.deepEqual(await importersOf(/["']@\/i18n\/mcp["']|locales\/mcp\./), [SECTION, "src/i18n/mcp.ts"]);
  assert.deepEqual(await importersOf(/["']@\/components\/book\/McpServerSection["']/), ["src/pages/BookSettingsPage.tsx"]);
  const router = await readFile(new URL("src/router.tsx", SITE), "utf8");
  // Changed on purpose (the pages of the app moved out of the entry): the route names its page, which is loaded through its own module.
  assert.match(router, /path: "books\/:bookId\/settings", lazy: appPage\("BookSettingsPage"\)/);
  const appPages = await readFile(new URL("src/routes/appPages.ts", SITE), "utf8");
  assert.match(appPages, /BookSettingsPage: \(\) => import\("@\/pages\/BookSettingsPage"\)/);
});
