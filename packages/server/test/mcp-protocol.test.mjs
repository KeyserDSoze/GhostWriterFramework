import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as testing from "../dist/testing.mjs";
import { declareLarge } from "./api-helpers.mjs";
import { until, withServer } from "./helpers.mjs";
import { READ_TOOLS, RUN_TOOLS, TITLE, WRITE_TOOLS, issueToken, mcpClient, mcpFixture } from "./mcp-helpers.mjs";

// The protocol of the per-book MCP endpoint (S7, phase A): JSON-RPC 2.0 over Streamable HTTP, answered as JSON, with no session. The tools themselves
// are in mcp-tools.test.mjs.

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const initialize = (protocolVersion, id = 7) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "protocol-test", version: "1.0.0" } } });

test("S7: initialize answers the highest protocol version both sides know, with the tools capability, the server's name and version, and short instructions for this client", async () => {
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    const rpc = mcpClient(server, slug, token, { version: null });
    for (const [asked, answered] of [["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2025-11-25", "2025-06-18"], ["2099-01-01", "2025-06-18"], ["2024-11-05", "2025-06-18"]]) {
      const reply = await rpc.post(initialize(asked));
      assert.equal(reply.status, 200, asked);
      assert.deepEqual([reply.json.jsonrpc, reply.json.id, reply.json.result.protocolVersion], ["2.0", 7, answered], asked);
    }
    const reply = await rpc.post(initialize("2025-06-18", "text-id"));
    const { result } = reply.json;
    assert.equal(reply.json.id, "text-id");
    assert.match(reply.headers.get("content-type"), /^application\/json/);
    assert.equal(reply.headers.get("mcp-session-id"), null, "no session: every request stands alone");
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual([result.serverInfo.name, result.serverInfo.version], ["narrarium-server", testing.SERVER_VERSION]);
    assert.ok(result.serverInfo.title.includes(TITLE));
    assert.ok(result.instructions.length > 150 && result.instructions.length < 1600, `short instructions: ${result.instructions.length} characters`);
    for (const word of [TITLE, "expectedHash", "autopilot_status", "read_outline", "edit_outline"]) assert.ok(result.instructions.includes(word), `the instructions of a client that may do everything say ${word}`);
    assert.match(result.instructions, /outline[^]*never[^]*write_file/i, "and that the outline is changed with edit_outline, not with write_file");
    assert.match(result.instructions, /not instructions|never instructions/i, "and that what the book says is data");

    const reader = mcpClient(server, slug, await issueToken(server, "reader", ["read"]), { version: null });
    const readerInstructions = (await reader.post(initialize("2025-06-18"))).json.result.instructions;
    assert.ok(readerInstructions.includes(TITLE));
    assert.ok(readerInstructions.includes("read_outline"), "it is told how to read the outline");
    for (const word of ["create_chapter", "expectedHash", "autopilot_pause", "edit_outline", "write_file"]) assert.equal(readerInstructions.includes(word), false, `a client that may only read is not told about ${word}`);

    for (const params of [{}, { protocolVersion: 5 }, { protocolVersion: "2025-06-18", capabilities: "x" }, { protocolVersion: "2025-06-18", clientInfo: 5 }]) {
      const invalid = await rpc.post({ jsonrpc: "2.0", id: 3, method: "initialize", params });
      assert.equal(invalid.json.error.code, -32602, JSON.stringify(params));
    }
    const lenient = await rpc.post({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(lenient.json.result.protocolVersion, "2025-06-18", "a client that says no more than the version it speaks is served");
  });
});

test("S7: ping answers an empty result, a notification is accepted with 202 and no body, and a method the server does not have is -32601", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    assert.deepEqual((await rpc.request("ping")).json, { jsonrpc: "2.0", id: 1, result: {} });
    for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/something-new"]) {
      const accepted = await rpc.post({ jsonrpc: "2.0", method, params: {} });
      assert.deepEqual([accepted.status, accepted.text], [202, ""], method);
    }
    const response = await rpc.post({ jsonrpc: "2.0", id: 5, result: {} });
    assert.deepEqual([response.status, response.text], [202, ""], "the answer of a client to a request: there is nothing to do");
    for (const method of ["resources/list", "prompts/list", "completion/complete", "logging/setLevel", "nothing/here"]) {
      const missing = await rpc.request(method, {});
      assert.equal(missing.status, 200, method);
      assert.equal(missing.json.error.code, -32601, method);
      assert.match(missing.json.error.message, /not found/i);
      assert.equal(missing.json.result, undefined);
    }
  });
});

test("S7: tools/list shows each client the tools its permissions allow, and every tool is written for a model: a snake_case name, a real description, a complete object schema and the four annotations", async () => {
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    const listFor = async (scopes) => mcpClient(server, slug, await issueToken(server, scopes.join("+"), scopes)).list();
    assert.deepEqual(await listFor(["read"]), READ_TOOLS);
    assert.deepEqual(await listFor(["read", "write"]), [...READ_TOOLS, ...WRITE_TOOLS]);
    assert.deepEqual(await listFor(["read", "run"]), [...READ_TOOLS, ...RUN_TOOLS]);
    assert.deepEqual(await listFor(["read", "write", "run"]), [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS]);

    const listed = (await mcpClient(server, slug, token).request("tools/list", {})).json.result;
    assert.equal(listed.nextCursor, undefined, "the whole list fits in a page");
    const seen = new Set();
    for (const tool of listed.tools) {
      assert.match(tool.name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, tool.name);
      assert.equal(seen.has(tool.name), false, `${tool.name} once`);
      seen.add(tool.name);
      assert.equal(typeof tool.title, "string", tool.name);
      assert.ok(tool.description.length >= 60, `${tool.name} has a description that a model can use`);
      const schema = tool.inputSchema;
      assert.equal(schema.type, "object", tool.name);
      assert.equal(schema.additionalProperties, false, `${tool.name} takes nothing it does not name`);
      assert.equal(typeof schema.properties, "object", tool.name);
      for (const required of schema.required ?? []) assert.ok(required in schema.properties, `${tool.name}: ${required} is one of its properties`);
      for (const [key, property] of Object.entries(schema.properties)) {
        assert.ok(property.type || property.enum, `${tool.name}.${key} has a type`);
        assert.ok(property.description?.length > 10, `${tool.name}.${key} is described`);
      }
      assert.equal("rootPath" in schema.properties || "bookId" in schema.properties, false, `${tool.name} does not take the book: it is the address`);
      const { annotations } = tool;
      const readOnly = READ_TOOLS.includes(tool.name);
      assert.equal(annotations.openWorldHint, false, tool.name);
      assert.equal(annotations.readOnlyHint, readOnly, tool.name);
      assert.equal(typeof annotations.idempotentHint, "boolean", tool.name);
      assert.equal(typeof annotations.destructiveHint, "boolean", tool.name);
      if (readOnly) assert.deepEqual([annotations.destructiveHint, annotations.idempotentHint], [false, true], tool.name);
      if (/^create_/.test(tool.name)) assert.equal(annotations.destructiveHint, false, `${tool.name} only adds`);
      if (/^update_/.test(tool.name) || tool.name === "write_file" || tool.name === "edit_outline") assert.equal(annotations.destructiveHint, true, `${tool.name} replaces what is there`);
      // What a list holds is described as well as the tool's own properties: a model reads the whole schema.
      const described = (property, where) => {
        assert.ok(property.type || property.enum, `${where} has a type`);
        assert.ok(property.description?.length > 10, `${where} is described`);
        for (const [key, inner] of Object.entries(property.items?.properties ?? property.properties ?? {})) described(inner, `${where}.${key}`);
      };
      for (const [key, property] of Object.entries(schema.properties)) described(property, `${tool.name}.${key}`);
    }
    assert.equal(seen.size, READ_TOOLS.length + WRITE_TOOLS.length + RUN_TOOLS.length);
  });
});

test("S7: tools/list is paginated with an opaque cursor when the list is long, and a cursor that is not one is -32602", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const names = [];
    let cursor;
    let pages = 0;
    do {
      const page = (await rpc.request("tools/list", cursor === undefined ? undefined : { cursor })).json.result;
      assert.ok(page.tools.length > 0 && page.tools.length <= 6, `a page of ${page.tools.length}`);
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(cursor === undefined || (typeof cursor === "string" && cursor.length > 0));
    } while (cursor);
    assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS]);
    assert.equal(pages, Math.ceil(names.length / 6));
    for (const bad of ["garbage", "AAAA", "", 5, {}]) {
      const refused = await rpc.request("tools/list", { cursor: bad });
      assert.equal(refused.json.error.code, -32602, JSON.stringify(bad));
    }
  }, { limits: { mcpToolsPerPage: 6 } });
});

test("S7: a request that is broken gets the JSON-RPC error that names the break: parse error, invalid request, method not found, invalid params", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const parse = await rpc.post("{ not json");
    assert.equal(parse.status, 400);
    assert.deepEqual([parse.json.jsonrpc, parse.json.id, parse.json.error.code], ["2.0", null, -32700]);
    assert.match(parse.json.error.message, /JSON/);

    for (const body of [{}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }, { jsonrpc: "2.0", id: null, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "ping", params: 5 }, '"text"', "42", "[]", ""]) {
      const invalid = await rpc.post(body);
      assert.equal(invalid.status, 400, JSON.stringify(body));
      assert.deepEqual([invalid.json.jsonrpc, invalid.json.id, invalid.json.error.code], ["2.0", null, -32600], JSON.stringify(body));
    }

    for (const id of [1, 0, "abc-1", "7", 2 ** 40]) {
      const missing = await rpc.post({ jsonrpc: "2.0", id, method: "nope/nothing" });
      assert.equal(missing.status, 200);
      assert.deepEqual(missing.json, { jsonrpc: "2.0", id, error: { code: -32601, message: missing.json.error.message } }, "the id comes back as it was sent");
    }

    const invalidParams = [
      ["tools/call", {}, /name/],
      ["tools/call", { name: 5 }, /name/],
      ["tools/call", { name: "no_such_tool" }, /unknown tool/i],
      ["tools/call", [], /params/],
      ["tools/call", { name: "book_info", arguments: "x" }, /arguments/],
      ["tools/call", { name: "book_info", arguments: { extra: 1 } }, /extra/],
      ["tools/call", { name: "list_chapters", arguments: { limit: 0 } }, /limit/],
      ["tools/call", { name: "list_chapters", arguments: { limit: "5" } }, /limit/],
      ["tools/call", { name: "list_chapters", arguments: { offset: -1 } }, /offset/],
      ["tools/call", { name: "read_chapter", arguments: {} }, /chapter/],
      ["tools/call", { name: "search_book", arguments: { query: "x", where: "everywhere" } }, /where/],
      ["tools/call", { name: "write_file", arguments: { path: "notes.md", content: "x".repeat(400_001) } }, /content/],
      ["tools/list", { cursor: 5 }, /cursor/],
    ];
    for (const [method, params, pattern] of invalidParams) {
      const answer = await rpc.request(method, params);
      const label = `${method} ${JSON.stringify(params).slice(0, 60)}`;
      assert.equal(answer.status, 200, label);
      assert.equal(answer.json.error?.code, -32602, label);
      assert.match(answer.json.error.message, pattern, label);
    }
  });
});

test("S7: a batch is read by the 2025-03-26 protocol only, the MCP-Protocol-Version header is checked, and a request that has none is read as 2025-03-26", async () => {
  await withServer(async (server, client) => {
    const { slug, token } = await mcpFixture(server, client);
    const as = (version) => mcpClient(server, slug, token, { version });
    const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: "two", method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }];
    for (const version of ["2025-03-26", null]) {
      const answer = await as(version).post(batch);
      assert.equal(answer.status, 200, String(version));
      assert.deepEqual(answer.json.map((entry) => entry.id), [1, "two"], "an answer for every request, and none for the notification");
      assert.deepEqual(answer.json[0].result, {});
      assert.ok(answer.json[1].result.tools.length > 0);
    }
    const refused = await as("2025-06-18").post(batch);
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, -32600);
    assert.match(refused.json.error.message, /batch/i);

    const old = as("2025-03-26");
    assert.equal((await old.post([{ jsonrpc: "2.0", method: "notifications/initialized" }])).status, 202, "a batch of notifications");
    assert.equal((await old.post([])).json.error.code, -32600, "an empty batch");
    const mixed = await old.post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { nonsense: true }, { jsonrpc: "2.0", id: 2, method: "nope" }]);
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.json.map((entry) => entry.error?.code ?? "ok"), ["ok", -32600, -32601], "every element has its own answer");
    const tooMany = await old.post(Array.from({ length: 17 }, (_, index) => ({ jsonrpc: "2.0", id: index + 1, method: "ping" })));
    assert.deepEqual([tooMany.status, tooMany.json.error.code], [400, -32600]);
    assert.equal((await old.post([initialize("2025-03-26", 3)])).json[0].error.code, -32600, "initialize is never part of a batch");

    for (const version of ["2099-01-01", "2024-11-05", "latest", "2025-06-18, 2025-03-26"]) {
      const unsupported = await as(version).request("ping");
      assert.equal(unsupported.status, 400, version);
      assert.equal(unsupported.json.code, "unsupported_protocol_version", version);
      assert.match(unsupported.json.message, /2025-06-18/);
    }
    assert.equal((await as("2099-01-01").post(initialize("2025-06-18"))).status, 200, "the header belongs to the requests that follow initialize");
    for (const version of ["2025-06-18", "2025-03-26"]) assert.equal((await as(version).request("ping")).status, 200, version);
  });
});

test("S7: the endpoint offers no event stream and no session to end (GET, DELETE and the rest are 405 and name POST), a body that is not JSON is 415, one that is too big is 413", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc, token } = await mcpFixture(server, client);
    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const answer = await rpc.method(method, method === "GET" ? { accept: "text/event-stream" } : {});
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.get("allow"), "POST", method);
    }
    assert.equal((await mcpClient(server, slug).method("GET")).status, 401, "who asks is checked before anything else is said");
    assert.equal((await rpc.post("ping", { "content-type": "text/plain" })).status, 415);
    // Refused by its declared length, before a byte of it is read. A megabyte really sent would race the answer: the connection closes after an
    // error, and on macOS the upload still going is reset before the client reads the 413 (C11 covers a body that is too big as it arrives).
    const big = await declareLarge(server, "POST", `/mcp/${slug}`, token, 2 * 1024 * 1024);
    assert.deepEqual([big.status, big.json?.code], [413, "payload_too_large"]);
    const withSession = await rpc.post(PING, { "mcp-session-id": "left-over-from-another-server" });
    assert.equal(withSession.status, 200, "a session id that came from somewhere else is ignored");
    assert.equal(withSession.headers.get("mcp-session-id"), null);
  });
});

test("S7: calls of tools are limited per client per minute with a 429 that says when to come back, and the calls that change the book have a lower limit of their own", async () => {
  await withServer(async (server, client) => {
    const { slug, rpc } = await mcpFixture(server, client);
    for (let index = 0; index < 4; index += 1) assert.equal((await rpc.call("book_info")).status, 200);
    const refused = await rpc.call("book_info");
    assert.equal(refused.status, 429);
    assert.equal(refused.json.code, "rate_limit");
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal((await rpc.request("ping")).status, 200, "what is no call of a tool is not counted");
    assert.equal((await rpc.request("tools/list", {})).status, 200);
    const other = mcpClient(server, slug, await issueToken(server, "someone else"));
    assert.equal((await other.call("book_info")).status, 200, "every client has its own budget");
  }, { limits: { mcpCallsPerMinute: 4, mcpWritesPerMinute: 100 } });

  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const write = (name) => rpc.call("write_file", { path: `drafts/${name}.md`, content: "# Draft\n" });
    assert.equal((await write("a")).isError, false);
    assert.equal((await write("b")).isError, false);
    const refused = await write("c");
    assert.deepEqual([refused.status, refused.json.code], [429, "rate_limit"]);
    const files = await rpc.call("list_files", { directory: "drafts" });
    assert.equal(files.status, 200, "reading goes on");
    assert.deepEqual(files.data.files.map((file) => file.path), ["drafts/a.md", "drafts/b.md"], "and the write that was refused was not done");
  }, { limits: { mcpCallsPerMinute: 100, mcpWritesPerMinute: 2 } });
});

test("S7: a call that takes too long ends with an error that says the change may still happen, and the work it was doing is not left halfway", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const hash = (await rpc.call("read_file", { path: "notes.md" })).data.hash;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const holding = server.books.get("glass").store.exclusive(() => gate);
    try {
      const slow = await rpc.call("write_file", { path: "notes.md", content: "# Late\n", expectedHash: hash });
      assert.equal(slow.status, 200);
      assert.equal(slow.isError, true);
      assert.match(slow.text, /^\[timeout\]/);
      assert.match(slow.text, /may still/i);
    } finally {
      release();
      await holding;
    }
    const file = path.join(server.data.bookDirectory("glass"), "notes.md");
    await until(async () => (await readFile(file, "utf8")) === "# Late\n", 10_000);
  }, { limits: { mcpCallMs: 300 } });
});

test("S7: an answer of a tool that is too large is not sent: the call says to ask for less", async () => {
  await withServer(async (server, client) => {
    const { rpc } = await mcpFixture(server, client);
    const small = await rpc.call("read_file", { path: "notes.md" });
    assert.equal(small.isError, false, "an answer that fits is sent");
    const large = await rpc.call("read_chapter", { chapter: "001-arrival", includeText: true });
    assert.equal(large.status, 200);
    assert.equal(large.isError, true);
    assert.match(large.text, /^\[too_large\]/);
    assert.match(large.text, /ask for less/);
    assert.ok(large.text.length < 400, "and what is said is short");
  }, { limits: { mcpResultBytes: 600 } });
});
