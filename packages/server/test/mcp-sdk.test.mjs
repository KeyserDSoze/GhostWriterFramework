import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { READ_TOOLS, RUN_TOOLS, TITLE, WRITE_TOOLS, issueToken, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";

// Interoperability (S7): the official MCP client (`@modelcontextprotocol/sdk`, a dependency of narrarium-mcp-server, used here by the tests only) connects to a
// book's endpoint the way a real MCP client does, lists the tools and calls them. The server itself does not use the SDK.

const connect = async (server, slug, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${slug}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const official = new Client({ name: "official-client", version: "1.0.0" });
  await official.connect(transport);
  return official;
};

test("S7: the official MCP client connects to a book with a client token, lists its tools, calls them and gets the book's own answers", async () => {
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    const official = await connect(server, slug, token);
    try {
      assert.deepEqual([official.getServerVersion().name, official.getServerVersion().version], ["narrarium-server", testing.SERVER_VERSION]);
      assert.deepEqual(official.getServerCapabilities(), { tools: { listChanged: false } });
      assert.ok(official.getInstructions().includes(TITLE));

      const listed = await official.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS]);
      assert.equal(listed.tools.find((tool) => tool.name === "read_file").annotations.readOnlyHint, true);

      const info = await official.callTool({ name: "book_info", arguments: {} });
      assert.equal(info.isError ?? false, false);
      assert.equal(JSON.parse(info.content[0].text).title, TITLE);

      const scene = await official.callTool({ name: "read_paragraph", arguments: { chapter: "001-arrival", paragraph: "001-the-quay" } });
      assert.match(scene.content[1].text, /^Mira stepped onto the quay/);

      const created = await official.callTool({ name: "create_chapter", arguments: { title: "The Tide", summary: "The water goes out." } });
      assert.equal(created.isError ?? false, false, created.content[0].text);
      assert.equal(JSON.parse(created.content[0].text).path, "chapters/003-the-tide/chapter.md");
      const chapters = JSON.parse((await official.callTool({ name: "list_chapters", arguments: {} })).content[0].text);
      assert.deepEqual(chapters.chapters.map((chapter) => chapter.slug), ["001-arrival", "002-the-storm", "003-the-tide"]);

      const missing = await official.callTool({ name: "read_paragraph", arguments: { chapter: "001-arrival", paragraph: "009-x" } });
      assert.equal(missing.isError, true, "a tool that fails is a result with isError, which a model can read");
      assert.match(missing.content[0].text, /^\[not_found\]/);
      await assert.rejects(official.callTool({ name: "no_such_tool", arguments: {} }), (error) => error.code === -32602, "an unknown tool is a protocol error");
      await assert.rejects(official.callTool({ name: "list_chapters", arguments: { limit: 0 } }), (error) => error.code === -32602 && /limit/.test(error.message));
    } finally {
      await official.close();
    }
  });
});

test("S7: the official client sees only what its token allows, and is refused with a 401 when the token is wrong, a 404 when the book's MCP is off", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const reader = await connect(server, slug, await issueToken(server, "reader", ["read"]));
    try {
      assert.deepEqual((await reader.listTools()).tools.map((tool) => tool.name), READ_TOOLS);
      const refused = await reader.callTool({ name: "create_chapter", arguments: { title: "No" } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /^\[scope\]/);
    } finally {
      await reader.close();
    }
    await assert.rejects(connect(server, slug, "nrs_not-a-token"), (error) => error.code === 401);
    assert.equal((await (await mcpRoute(server)).put({ enabled: false })).status, 200);
    await assert.rejects(connect(server, slug, await issueToken(server)), (error) => error.code === 404);
  });
});
