import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import entryEn from "../src/i18n/locales/en.ts";
import entryIt from "../src/i18n/locales/it.ts";
import linesEn from "../src/i18n/locales/mcpBookTools.en.ts";
import linesIt from "../src/i18n/locales/mcpBookTools.it.ts";

const SITE = new URL("../", import.meta.url);
const SERVER_LIST = new URL("../../../packages/server/mcp-tools.json", import.meta.url);

/** The tools a book's MCP lists, as the server wrote them (`npm run docs:tools -w narrarium-server`). */
const serverTools = async () => (JSON.parse(await readFile(SERVER_LIST, "utf8"))).tools;

const REGENERATE = "a tool of the server needs its line here, in English and in Italian (packages/server/mcp-tools.json lists it)";

test("the lines of the tools are in a catalogue of their own, in both languages, keyed by the name of the tool", () => {
  assert.deepEqual(Object.keys(linesEn), ["mcpBookTools"]);
  assert.deepEqual(Object.keys(linesIt), ["mcpBookTools"]);
});

test("every tool of the server has a line in English and in Italian, and no line is left for a tool that is not there: adding a tool to the server forces its text", async () => {
  const names = (await serverTools()).map((tool) => tool.name).sort();
  assert.ok(names.length >= 25, `the server lists its tools (saw ${names.length})`);
  for (const [language, lines] of [["English", linesEn.mcpBookTools], ["Italian", linesIt.mcpBookTools]]) {
    const written = Object.keys(lines).sort();
    assert.deepEqual(names.filter((name) => !written.includes(name)), [], `${language}: ${REGENERATE}`);
    assert.deepEqual(written.filter((name) => !names.includes(name)), [], `${language}: a line for a tool that the server does not list`);
  }
});

test("each line is one short line for a person, not the long description that a model reads, and the Italian is a translation", async () => {
  for (const tool of await serverTools()) {
    const en = linesEn.mcpBookTools[tool.name];
    const it = linesIt.mcpBookTools[tool.name];
    for (const [language, line] of [["en", en], ["it", it]]) {
      assert.equal(typeof line, "string", `${tool.name} (${language})`);
      assert.equal(line, line.trim(), `${tool.name} (${language}) has no space around it`);
      assert.doesNotMatch(line, /[\r\n]|\s{2}/, `${tool.name} (${language}) is one line`);
      assert.ok(line.length >= 12 && line.length <= 125, `${tool.name} (${language}) is a short line (${line.length} characters)`);
      assert.doesNotMatch(line, /[`<>{}]|\*\*|\[[^\]]*\]\(/, `${tool.name} (${language}) is plain text`);
      assert.notEqual(line, tool.description, `${tool.name} (${language}) is not the description of the model`);
      assert.ok(!tool.description.startsWith(line.replace(/\.$/, "")), `${tool.name} (${language}) does not begin as the description of the model does`);
    }
    assert.notEqual(it, en, `${tool.name} is translated`);
  }
});

test("the lines are not in the catalogues of the app entry: they travel with the page for a book's MCP", () => {
  for (const entry of [/** @type {Record<string, unknown>} */ (entryEn), /** @type {Record<string, unknown>} */ (entryIt)]) assert.equal(entry.mcpBookTools, undefined);
});

test("only the registration of that page imports the lines", async () => {
  const importers = [];
  for (const entry of await readdir(new URL("src/", SITE), { recursive: true })) {
    const relative = `src/${entry.split("\\").join("/")}`;
    if (!/\.(ts|tsx)$/.test(relative)) continue;
    if (/locales\/mcpBookTools\./.test(await readFile(new URL(relative, SITE), "utf8"))) importers.push(relative);
  }
  assert.deepEqual(importers.sort(), ["src/i18n/mcpBookPage.ts"]);
});
