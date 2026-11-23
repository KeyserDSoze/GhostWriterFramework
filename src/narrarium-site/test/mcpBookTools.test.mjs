import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mcpBookTools } from "../src/lib/generated-mcp-book-tools.ts";

const SITE = new URL("../", import.meta.url);
const SERVER_LIST = new URL("../../../packages/server/mcp-tools.json", import.meta.url);

/** The list the server writes (`npm run docs:tools -w narrarium-server`) from the tools its endpoint really lists. */
const serverList = async () => JSON.parse(await readFile(SERVER_LIST, "utf8"));

test("the tools of a book's MCP in the generated module are the server's list, tool by tool and in its order", async () => {
  const { tools } = await serverList();
  assert.ok(tools.length >= 25, `the server lists its tools (saw ${tools.length})`);
  assert.deepEqual(mcpBookTools, tools, "the module is what the generator makes of packages/server/mcp-tools.json: run node scripts/generate-docs.mjs");
  for (const permission of ["read", "write", "run"]) assert.ok(mcpBookTools.some((tool) => tool.permission === permission), `a tool needs ${permission}`);
});

test("every tool keeps what the page and its tests need: the permission, the title and the description as the model reads them, the annotations and the parameters", () => {
  const names = new Set();
  for (const tool of mcpBookTools) {
    assert.equal(names.has(tool.name), false, `${tool.name} once`);
    names.add(tool.name);
    assert.deepEqual(Object.keys(tool), ["name", "permission", "title", "description", "annotations", "parameters"], tool.name);
    assert.deepEqual(Object.keys(tool.annotations), ["readOnlyHint", "destructiveHint", "idempotentHint"], tool.name);
    for (const parameter of tool.parameters) assert.deepEqual(Object.keys(parameter), ["name", "required"], tool.name);
  }
});

test("the list is not in the index of the documents, which stays light: the page for a book's MCP loads it", async () => {
  const index = await readFile(new URL("src/lib/generated-docs.ts", SITE), "utf8");
  for (const tool of mcpBookTools.filter((entry) => entry.description.length > 200)) {
    assert.ok(!index.includes(JSON.stringify(tool.description).slice(1, -1)), `${tool.name}: its description is not in the index of the documents`);
  }
  assert.doesNotMatch(index, /idempotentHint|BookToolEntry/, "no type or field of the list leaks into the index");
});
