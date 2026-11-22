import test from "node:test";
import assert from "node:assert/strict";
import { NarrariumServerClient, ServerRequestError, serverSupportsMcp, serverSupportsMcpOAuth } from "narrarium-engine";
import { withServer } from "./helpers.mjs";
import { TITLE, issueToken, mcpBook } from "./mcp-helpers.mjs";
import { connectApp, setPublic } from "./oauth-helpers.mjs";

// The contract between the engine's typed client (`NarrariumServerClient`, which the web app uses) and the MCP routes of the real server: what the README of the engine
// says each call answers is what this server answers. The client itself is tested against a fake fetch in the engine; here it meets the real thing.

const refusal = (status, code) => (error) => error instanceof ServerRequestError && error.status === status && error.code === code && typeof error.message === "string" && error.message.length > 0;

test("S8: the engine's client reads the MCP features of the real server and the status of a book, before and after the owner gives the server a public address", async () => {
  await withServer(async (server, client) => {
    const info = await client.info();
    assert.deepEqual([serverSupportsMcp(info), serverSupportsMcpOAuth(info)], [true, true]);
    await mcpBook(client, "glass", TITLE);

    const first = await client.mcpStatus("glass");
    const { updatedAt, message, ...rest } = first;
    assert.deepEqual(rest, {
      bookId: "glass",
      enabled: false,
      slug: "the-glass-harbor",
      path: "/mcp/the-glass-harbor",
      url: `${server.url}/mcp/the-glass-harbor`,
      public: false,
      protocolVersions: ["2025-06-18", "2025-03-26"],
      connections: 0,
      oauth: {
        issuer: server.url,
        metadataUrl: `${server.url}/.well-known/oauth-authorization-server`,
        resourceMetadataUrl: `${server.url}/.well-known/oauth-protected-resource/mcp/the-glass-harbor`,
        scopes: ["mcp:read", "mcp:write", "mcp:run"],
      },
    });
    assert.ok(!Number.isNaN(Date.parse(updatedAt)));
    assert.match(message, /public address/, "it says why the address works from this computer only");

    await setPublic(server);
    const published = await client.mcpStatus("glass");
    assert.deepEqual([published.public, published.url, published.oauth.issuer, "message" in published], [true, "https://api.example.test/mcp/the-glass-harbor", "https://api.example.test", false]);
  });
});

test("S8: the engine's client switches a book on and off and changes its slug, and the apps connected through OAuth are listed and revoked with the ids the server gives", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "glass", TITLE);
    const on = await client.updateMcp("glass", { enabled: true });
    assert.deepEqual([on.enabled, on.slug, on.connections], [true, "the-glass-harbor", 0]);
    assert.deepEqual(await client.listMcpClients("glass"), [], "nothing connected: an empty list");

    const renamed = await client.updateMcp("glass", { slug: "glass" });
    assert.deepEqual([renamed.enabled, renamed.slug, renamed.url], [true, "glass", `${server.url}/mcp/glass`], "a slug alone leaves the switch where it was");

    const claude = await connectApp(server, { slug: "glass", name: "Claude", scopes: ["read", "write"] });
    await connectApp(server, { slug: "glass", name: "ChatGPT", scopes: ["read"] });
    const listed = await client.listMcpClients("glass");
    assert.deepEqual(listed.map((entry) => [entry.name, entry.scopes, entry.redirectHost, entry.clientId]).sort(), [["ChatGPT", ["read"], "127.0.0.1:8765", listed.find((entry) => entry.name === "ChatGPT").clientId], ["Claude", ["read", "write"], "127.0.0.1:8765", claude.app.client_id]].sort());
    for (const entry of listed) {
      assert.deepEqual(Object.keys(entry).sort(), ["clientId", "createdAt", "id", "lastUsedAt", "name", "redirectHost", "scopes"]);
      assert.ok(!Number.isNaN(Date.parse(entry.createdAt)) && !Number.isNaN(Date.parse(entry.lastUsedAt)));
    }
    assert.equal(JSON.stringify(listed).includes("nra_"), false, "never a token");
    assert.equal((await client.mcpStatus("glass")).connections, 2);

    const mine = listed.find((entry) => entry.name === "Claude");
    assert.deepEqual(await client.revokeMcpClient("glass", mine.id), { revoked: true });
    assert.deepEqual((await client.listMcpClients("glass")).map((entry) => entry.name), ["ChatGPT"], "only that one");
    await assert.rejects(() => client.revokeMcpClient("glass", mine.id), refusal(404, "client_missing"));

    const off = await client.updateMcp("glass", { enabled: false });
    assert.deepEqual([off.enabled, off.connections], [false, 0], "switching off disconnects the rest");
    assert.deepEqual(await client.listMcpClients("glass"), []);
  });
});

test("S8: what the real server refuses reaches the host as a ServerRequestError with the status and the code the engine's README lists", async () => {
  await withServer(async (server, client) => {
    await mcpBook(client, "glass", TITLE);
    await mcpBook(client, "moon", "Moon Book");
    await client.updateMcp("moon", { slug: "moon" });
    await client.updateMcp("glass", { enabled: true });

    await assert.rejects(() => client.updateMcp("glass", { slug: "Not A Slug" }), refusal(400, "invalid_slug"));
    await assert.rejects(() => client.updateMcp("glass", { slug: "moon" }), refusal(409, "slug_taken"));
    await assert.rejects(() => client.updateMcp("glass", {}), refusal(400, "invalid_request"));
    await assert.rejects(() => client.mcpStatus("nope"), refusal(404, "book_not_found"));
    await assert.rejects(() => client.updateMcp("nope", { enabled: true }), refusal(404, "book_not_found"));
    await assert.rejects(() => client.listMcpClients("nope"), refusal(404, "book_not_found"));
    await assert.rejects(() => client.revokeMcpClient("nope", "x"), refusal(404, "book_not_found"));
    await assert.rejects(() => client.revokeMcpClient("glass", "x"), refusal(404, "client_missing"));
    assert.equal((await client.mcpStatus("glass")).slug, "the-glass-harbor", "a refused change changed nothing");

    const reader = new NarrariumServerClient({ baseUrl: server.url, token: await issueToken(server, "reader", ["read"]) });
    assert.equal((await reader.mcpStatus("glass")).enabled, true, "the status needs read");
    await assert.rejects(() => reader.updateMcp("glass", { enabled: false }), refusal(403, "scope"));
    await assert.rejects(() => reader.listMcpClients("glass"), refusal(403, "scope"));
    await assert.rejects(() => reader.revokeMcpClient("glass", "x"), refusal(403, "scope"));

    const stranger = new NarrariumServerClient({ baseUrl: server.url, token: "nrs_not-a-token" });
    await assert.rejects(() => stranger.mcpStatus("glass"), refusal(401, "unauthorized"));
  });
});
