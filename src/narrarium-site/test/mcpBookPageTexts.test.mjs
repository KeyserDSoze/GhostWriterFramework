import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";
import pageEn from "../src/i18n/locales/mcpBookPage.en.ts";
import pageIt from "../src/i18n/locales/mcpBookPage.it.ts";

const SITE = new URL("../", import.meta.url);
/** The files that show the page for a book's MCP and ask for its texts. */
const VIEWS = ["src/pages/public/McpPage.tsx", "src/components/public/BookMcpSection.tsx"];

/** @typedef {Record<string, any>} Tree */

/** @param {Tree} tree @param {string} path @returns {any} */
const lookup = (tree, path) => path.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);

/** The texts every key of a catalogue holds, by their path. @param {Tree} tree @param {string} [prefix] @returns {string[]} */
const leaves = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([key, child]) => (child && typeof child === "object" ? leaves(child, `${prefix}${key}.`) : [`${prefix}${key}`]));

/** @param {string} text */
const placeholders = (text) => Array.from(text.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (match) => match[1]).sort();

const EN = pageEn.mcpBookPage;
const IT = pageIt.mcpBookPage;
const LANGUAGES = [{ name: "en", page: EN }, { name: "it", page: IT }];
const PERMISSIONS = ["read", "write", "run"];
const NOTES = ["readOnly", "destructive", "additive"];

test("the texts of the page are in a catalogue of their own, in both languages", () => {
  assert.deepEqual(Object.keys(pageEn), ["mcpBookPage"]);
  assert.deepEqual(Object.keys(pageIt), ["mcpBookPage"]);
});

test("the English and the Italian texts have the same keys and the same placeholders, none is empty, and the Italian is not the English", () => {
  assert.deepEqual(leaves(IT).sort(), leaves(EN).sort());
  assert.ok(leaves(EN).length >= 25, `the page has its texts (saw ${leaves(EN).length})`);
  for (const key of leaves(EN)) {
    assert.equal(typeof lookup(EN, key), "string", `${key} is a text`);
    assert.ok(lookup(EN, key).trim() && lookup(IT, key).trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(lookup(IT, key)), placeholders(lookup(EN, key)), `${key}: same placeholders`);
    assert.notEqual(lookup(IT, key), lookup(EN, key), `${key} is translated`);
  }
});

test("the texts are not in the catalogues of the app entry: they travel with the page", () => {
  for (const entry of [/** @type {Tree} */ (entryEn), /** @type {Tree} */ (entryIt)]) assert.equal(entry.mcpBookPage, undefined);
});

/** @param {string} key @returns {string[]} */
function expand(key) {
  if (!key.includes("${")) return [key];
  if (/^mcpBookPage\.(?:permissions|tables)\./.test(key)) return PERMISSIONS.map((permission) => key.replace(/\$\{[^}]+\}/, permission));
  if (key.startsWith("mcpBookPage.notes.")) return NOTES.map((note) => key.replace(/\$\{[^}]+\}/, note));
  throw new Error(`no expansion known for ${key}: add the values it can take`);
}

test("every text the page asks for exists in both languages, and no text is left without a use", async () => {
  const asked = new Set();
  for (const view of VIEWS) {
    const text = await readFile(new URL(view, SITE), "utf8");
    for (const match of text.matchAll(/["'`](mcpBookPage\.[A-Za-z0-9_.${}-]+)["'`]/g)) for (const key of expand(match[1])) asked.add(key);
  }
  assert.ok(asked.size >= 25, `the scan sees the keys of the page (saw ${asked.size})`);
  const missing = [];
  for (const key of asked) for (const { name, page } of LANGUAGES) if (typeof lookup(page, key.replace(/^mcpBookPage\./, "")) !== "string") missing.push(`${key} (${name})`);
  assert.deepEqual(missing, []);
  assert.deepEqual(leaves(EN).filter((key) => !asked.has(`mcpBookPage.${key}`)), [], "texts that the page never asks for");
});

test("only the registration of the page imports the catalogue, and only the page imports that registration", async () => {
  const importers = async (pattern) => {
    const found = [];
    for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
      const relative = `src/${entry.split("\\").join("/")}`;
      if (!/\.(ts|tsx)$/.test(relative)) continue;
      if (pattern.test(await readFile(new URL(relative, SITE), "utf8"))) found.push(relative);
    }
    return found.sort();
  };
  assert.deepEqual(await importers(/locales\/mcpBookPage\./), ["src/i18n/mcpBookPage.ts"]);
  assert.deepEqual(await importers(/["']@\/i18n\/mcpBookPage["']/), ["src/pages/public/McpPage.tsx"]);
});

test("the page says what it must, in both languages, and only what the README of the server says", () => {
  for (const { name, page } of LANGUAGES) {
    // One plain sentence on prompt injection: what reads the book can be talked into using the tools; write access only to apps you trust; a commit can be undone.
    assert.equal(page.risk.text.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `the risk is one sentence (${name})`);
    assert.match(page.risk.text, /commit/, name);
    // The assistants the page names, and the passkey and the admin code that prove the owner.
    for (const assistant of ["ChatGPT", "Claude.ai", "Claude Code", "Cursor", "VS Code"]) assert.ok(page.use.body.includes(assistant), `${assistant} (${name})`);
    assert.ok(page.start.body.includes("npx narrarium-server"), `the personal server starts with npx narrarium-server (${name})`);
    assert.match(page.start.body, /https/, `ChatGPT and Claude.ai need a public https address (${name})`);
    assert.match(page.access.oauth, /OAuth/, name);
    assert.match(page.access.oauth, /passkey/, name);
    assert.match(page.access.oauth, /admin/, name);
    assert.match(page.permissions.write.text, /commit/, `every change is a commit (${name})`);
  }
  assert.match(EN.risk.text, /talked into using the tools/);
  assert.match(EN.risk.text, /trust/);
  assert.match(EN.risk.text, /undo/);
  assert.match(IT.risk.text, /convinto a usare gli strumenti/);
  assert.match(IT.risk.text, /fidi/);
  assert.match(IT.risk.text, /annullare/);
  assert.match(EN.access.readOnly, /Read only is the default/);
  assert.match(IT.access.readOnly, /sola lettura/i);
  assert.match(EN.access.revoke, /revoke/);
  assert.match(IT.access.revoke, /revocar/);
  assert.match(EN.permissions.read.text, /cannot change anything/);
  assert.match(IT.permissions.read.text, /Non può cambiare nulla/);
  assert.match(EN.permissions.write.text, /revert/);
  assert.match(IT.permissions.write.text, /annullare/);
  assert.match(EN.tools.intro, /generated/);
  assert.match(IT.tools.intro, /generati/);
});

test("the permissions are named as the consent page of the server names them, so the owner finds the same words", () => {
  assert.deepEqual([EN.permissions.read.name, EN.permissions.write.name, EN.permissions.run.name], ["Read the book", "Change the book", "Control the autopilot"]);
  assert.deepEqual([IT.permissions.read.name, IT.permissions.write.name, IT.permissions.run.name], ["Leggere il libro", "Modificare il libro", "Controllare l'autopilot"]);
});
