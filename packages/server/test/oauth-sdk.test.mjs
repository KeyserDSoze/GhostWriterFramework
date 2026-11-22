import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { rawApi } from "./api-helpers.mjs";
import { withServer } from "./helpers.mjs";
import { READ_TOOLS, TITLE, WRITE_TOOLS, mcpFixture } from "./mcp-helpers.mjs";
import { LOCAL_REDIRECT, MINUTE, adminCode, approveWithCode, codeOf, makeClock, pageState, web } from "./oauth-helpers.mjs";

// Interoperability (S7, phase B, R7): the official MCP client (`@modelcontextprotocol/sdk`, a dependency of narrarium-mcp-server, used here by the tests only) does by itself everything that
// ChatGPT and Claude do: it is refused, finds the resource metadata and the authorization server, registers, sends the owner to the consent page, trades the code, calls the tools, refreshes
// when the access token ends, and starts again when the owner revokes it. Only the owner's part (the browser) is played by the test.

/** What an application that uses the SDK keeps: its registration, its tokens, the code verifier, and the addresses it was told to open in a browser. */
class MemoryProvider {
  constructor() {
    this.redirects = [];
    this.stored = {};
  }

  get redirectUrl() {
    return LOCAL_REDIRECT;
  }

  get clientMetadata() {
    return { client_name: "Official SDK app", redirect_uris: [LOCAL_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  state() {
    return "sdk-state-1";
  }

  clientInformation() {
    return this.stored.client;
  }

  saveClientInformation(information) {
    this.stored.client = information;
  }

  tokens() {
    return this.stored.tokens;
  }

  saveTokens(tokens) {
    this.stored.tokens = tokens;
  }

  redirectToAuthorization(url) {
    this.redirects.push(url);
  }

  saveCodeVerifier(verifier) {
    this.stored.verifier = verifier;
  }

  codeVerifier() {
    return this.stored.verifier;
  }

  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") this.stored.tokens = undefined;
    if (scope === "all") this.stored.client = undefined;
  }
}

const newClient = () => new Client({ name: "official-client", version: "1.0.0" });

test("S7B SDK: the official client is sent to the consent page by a 401, finishes with the code, calls tools, refreshes by itself, and is sent to the owner again when the owner revokes it", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const mcpUrl = new URL(`${server.url}/mcp/${slug}`);
    const provider = new MemoryProvider();

    const first = newClient();
    const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await assert.rejects(first.connect(transport), UnauthorizedError, "no token: the client is sent to authorize");
    assert.equal(provider.redirects.length, 1);

    const registered = provider.clientInformation();
    assert.equal(registered.client_name, "Official SDK app");
    assert.match(registered.client_id, /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(registered.token_endpoint_auth_method, "none");

    const authorization = provider.redirects[0];
    const params = authorization.searchParams;
    assert.equal(`${authorization.origin}${authorization.pathname}`, `${server.url}/oauth/authorize`, "the endpoint that the server's metadata names");
    assert.deepEqual(
      [params.get("response_type"), params.get("client_id"), params.get("code_challenge_method"), params.get("redirect_uri"), params.get("resource"), params.get("state")],
      ["code", registered.client_id, "S256", LOCAL_REDIRECT, `${server.url}/mcp/${slug}`, "sdk-state-1"],
    );
    assert.deepEqual(params.get("scope").split(" ").sort(), ["mcp:read", "mcp:run", "mcp:write"], "with no scope in the challenge it asks for all that the server offers");

    // The owner, in a browser: reads the page, chooses to let it change the book, proves it is him with the admin code.
    const w = web(server);
    const opened = await w.get(`${authorization.pathname}${authorization.search}`);
    assert.equal(opened.status, 200, opened.text.slice(0, 300));
    const page = pageState(opened.text);
    assert.equal(page.client.name, "Official SDK app");
    assert.deepEqual(page.scopes.map((entry) => [entry.scope, entry.checked]), [["read", true], ["write", false], ["run", false]]);
    const approved = await approveWithCode(w, page, { code: await adminCode(server), scopes: ["read", "write"] });
    assert.equal(approved.status, 200, approved.text);
    const back = new URL(approved.json.redirect);
    assert.equal(back.searchParams.get("state"), "sdk-state-1");
    assert.equal(`${back.origin}${back.pathname}`, LOCAL_REDIRECT);

    // The app is back with the code.
    await transport.finishAuth(codeOf(approved.json.redirect));
    const tokens = provider.tokens();
    assert.deepEqual([tokens.token_type, tokens.expires_in, tokens.scope], ["Bearer", 3600, "mcp:read mcp:write"]);

    const second = newClient();
    const authorized = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await second.connect(authorized);
    assert.equal(second.getServerVersion().name, "narrarium-server");
    assert.deepEqual((await second.listTools()).tools.map((tool) => tool.name), [...READ_TOOLS, ...WRITE_TOOLS]);
    assert.equal(JSON.parse((await second.callTool({ name: "book_info", arguments: {} })).content[0].text).title, TITLE);
    assert.equal(provider.redirects.length, 1, "and the owner was not asked again");

    // The access token ends after an hour: the client asks for a new one by itself, and the old refresh token is spent.
    const before = provider.tokens();
    clock.advance(61 * MINUTE);
    const afterAnHour = await second.callTool({ name: "list_chapters", arguments: {} });
    assert.equal(afterAnHour.isError ?? false, false);
    const after = provider.tokens();
    assert.notEqual(after.access_token, before.access_token);
    assert.notEqual(after.refresh_token, before.refresh_token, "rotated");
    assert.equal(provider.redirects.length, 1, "no owner needed");

    // The owner revokes it (here through the route of the web app): the client cannot refresh and is sent to the owner again.
    const api = await rawApi(server, ["read", "write"]);
    const grant = (await api("GET", "/api/v1/books/glass/mcp/clients")).json.clients[0];
    assert.equal(grant.name, "Official SDK app");
    assert.equal((await api("DELETE", `/api/v1/books/glass/mcp/clients/${grant.id}`)).status, 200);
    await assert.rejects(second.callTool({ name: "book_info", arguments: {} }), UnauthorizedError);
    assert.equal(provider.redirects.length, 2, "it starts again from the consent page");
    assert.equal(provider.tokens(), undefined, "and drops what it had");
    await second.close();
  }, { now: clock.now });
});

test("S7B SDK: the client's own discovery reads the metadata of the resource and of the server, and the server is the one that the resource names", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const resource = await discoverOAuthProtectedResourceMetadata(new URL(`${server.url}/mcp/${slug}`), { resourceMetadataUrl: new URL(`${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`) });
    assert.equal(resource.resource, `${server.url}/mcp/${slug}`);
    assert.deepEqual(resource.authorization_servers, [server.url]);
    const metadata = await discoverAuthorizationServerMetadata(new URL(resource.authorization_servers[0]));
    assert.deepEqual([metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, metadata.revocation_endpoint], [server.url, `${server.url}/oauth/authorize`, `${server.url}/oauth/token`, `${server.url}/oauth/register`, `${server.url}/oauth/revoke`]);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  });
});

test("S7B SDK: an owner who allows reading only gives the client a read-only connection, and a tool that needs more is an error it can read, not a crash", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const mcpUrl = new URL(`${server.url}/mcp/${slug}`);
    const provider = new MemoryProvider();
    const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await assert.rejects(newClient().connect(transport), UnauthorizedError);
    const authorization = provider.redirects[0];
    const w = web(server);
    const page = pageState((await w.get(`${authorization.pathname}${authorization.search}`)).text);
    const approved = await approveWithCode(w, page, { code: await adminCode(server), scopes: ["read"] });
    await transport.finishAuth(codeOf(approved.json.redirect));
    assert.equal(provider.tokens().scope, "mcp:read");

    const reading = newClient();
    await reading.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    assert.deepEqual((await reading.listTools()).tools.map((tool) => tool.name), READ_TOOLS);
    const refused = await reading.callTool({ name: "create_chapter", arguments: { title: "No" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /^\[scope\]/);
    await reading.close();
  });
});
