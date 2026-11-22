import test from "node:test";
import assert from "node:assert/strict";
import { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { withServer } from "./helpers.mjs";
import { issueToken, mcpFixture, mcpRoute } from "./mcp-helpers.mjs";
import { PUBLIC_HOST, PUBLIC_URL, challengeParams, connectApp, setPublic, web } from "./oauth-helpers.mjs";

// Discovery (S7, phase B, R1): what an MCP client that was refused finds out by itself: where the resource says its authorization server is (RFC 9728), what that server
// offers (RFC 8414), and that the same server answers under the address it was reached on (the owner's public host, or this computer's own).

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const SCOPES = ["mcp:read", "mcp:write", "mcp:run"];

test("S7B: a call to a book's address without a token is a 401 that says where the resource metadata is, on this computer's address and on the public one", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);

    const local = await fetch(`${server.url}/mcp/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(PING) });
    assert.equal(local.status, 401);
    const header = local.headers.get("www-authenticate");
    assert.match(header, /^Bearer /);
    const params = challengeParams(header);
    assert.equal(params.resource_metadata, `${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`);
    assert.equal("error" in params, false, "no token at all is not an invalid token (RFC 6750)");
    assert.equal("scope" in params, false, "no scope: a client asks for everything the server offers and the owner chooses");

    const wrong = await fetch(`${server.url}/mcp/${slug}`, { method: "POST", headers: { authorization: "Bearer nrs_wrong", "content-type": "application/json" }, body: JSON.stringify(PING) });
    assert.equal(wrong.status, 401);
    assert.deepEqual(
      [challengeParams(wrong.headers.get("www-authenticate")).error, challengeParams(wrong.headers.get("www-authenticate")).resource_metadata],
      ["invalid_token", `${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`],
    );

    const publicWeb = web(server, { host: PUBLIC_HOST });
    const outside = await publicWeb.post(`/mcp/${slug}`, { json: PING, origin: false });
    assert.equal(outside.status, 401);
    assert.equal(challengeParams(outside.headers["www-authenticate"]).resource_metadata, `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/${slug}`, "reached through the public host, the address is the public one");
  });
});

test("S7B: the protected resource metadata (RFC 9728) names the book's exact MCP address and the server as its authorization server", async () => {
  await withServer(async (server, client) => {
    const { slug, status } = await mcpFixture(server, client);
    const local = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`);
    assert.equal(local.status, 200);
    assert.match(local.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await local.json(), { resource: `${server.url}/mcp/${slug}`, authorization_servers: [server.url], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });

    await setPublic(server);
    const publicWeb = web(server, { host: PUBLIC_HOST });
    const published = await publicWeb.get(`/.well-known/oauth-protected-resource/mcp/${slug}`);
    assert.equal(published.status, 200);
    assert.deepEqual(published.json, { resource: `${PUBLIC_URL}/mcp/${slug}`, authorization_servers: [PUBLIC_URL], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
    assert.equal(published.json.resource, (await (await mcpRoute(server)).get()).json.url, "the resource is the very address the status of the book gives");
    assert.doesNotThrow(() => OAuthProtectedResourceMetadataSchema.parse(published.json), "and it is what the official client's schema reads");
    assert.equal(status.enabled, true);
  });
});

test("S7B: the metadata of the resource is the same for every well-formed address, so nobody learns which books exist or what they are called", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    await setPublic(server);
    const publicWeb = web(server, { host: PUBLIC_HOST });
    const known = (await publicWeb.get(`/.well-known/oauth-protected-resource/mcp/${slug}`)).json;
    const unknown = await publicWeb.get("/.well-known/oauth-protected-resource/mcp/no-such-book");
    assert.equal(unknown.status, 200);
    assert.deepEqual({ ...unknown.json, resource: known.resource }, known, "an address that no book has is answered like one that a book has: only the resource differs");
    assert.equal(unknown.json.resource, `${PUBLIC_URL}/mcp/no-such-book`);
    await (await mcpRoute(server)).put({ enabled: false });
    assert.deepEqual((await publicWeb.get(`/.well-known/oauth-protected-resource/mcp/${slug}`)).json, known, "and a book that is switched off too");
    assert.equal(JSON.stringify(known).includes("Glass"), false, "the title of the book is never in it");

    for (const bad of ["/mcp/", "/mcp/Not_A_Slug", "/mcp/a/b", "/mcp/-x", "/mcp/x--y", `/mcp/${"a".repeat(81)}`, "/", "/other", "/mcp/%2e%2e"]) {
      const answer = await publicWeb.get(`/.well-known/oauth-protected-resource${bad}`);
      assert.equal(answer.status, 404, bad);
    }
  });
});

test("S7B: the authorization server metadata (RFC 8414) lists what the server does and refuses everything it does not: S256 only, public clients only, no implicit flow", async () => {
  await withServer(async (server) => {
    const local = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
    const expectFor = (issuer) => ({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
    assert.deepEqual(local, expectFor(server.url));

    await setPublic(server);
    const publicWeb = web(server, { host: PUBLIC_HOST });
    const published = await publicWeb.get("/.well-known/oauth-authorization-server");
    assert.equal(published.status, 200);
    assert.deepEqual(published.json, expectFor(PUBLIC_URL), "the issuer is the server's public address");
    assert.doesNotThrow(() => OAuthMetadataSchema.parse(published.json), "and the official client's schema reads it");

    const openid = await publicWeb.get("/.well-known/openid-configuration");
    assert.equal(openid.status, 200);
    assert.deepEqual(openid.json, published.json, "a client that asks the OpenID way gets the same OAuth fields");
  });
});

test("S7B: the well-known addresses answer GET only, an unknown one is a 404, and the Host rule of the API still holds", async () => {
  await withServer(async (server) => {
    await setPublic(server);
    const publicWeb = web(server, { host: PUBLIC_HOST });
    for (const route of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource/mcp/x"]) {
      const post = await publicWeb.post(route, { json: {}, origin: false });
      assert.equal(post.status, 405, route);
      assert.match(post.headers.allow, /GET/);
    }
    for (const route of ["/.well-known/nothing", "/.well-known/oauth-authorization-server/extra", "/.well-known/oauth-protected-resource"]) {
      assert.equal((await publicWeb.get(route)).status, 404, route);
    }
    const stranger = web(server, { host: "evil.example" });
    for (const route of ["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/authorize"]) {
      assert.equal((await stranger.get(route)).status, 421, `${route}: a Host that is neither this computer nor the public address`);
    }
  });
});

test("S7B: a refusal for a missing permission says which permission is needed and where the resource metadata is", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const connected = await connectApp(server, { slug, scopes: ["read"] });
    const readOnly = await fetch(`${server.url}/mcp/${slug}`, { method: "POST", headers: { authorization: `Bearer ${connected.tokens.access_token}`, "content-type": "application/json" }, body: JSON.stringify(PING) });
    assert.equal(readOnly.status, 200, "the token of the app reaches the endpoint of its book");

    // A grant of OAuth always has read, so the 403 is the one of a client token that has no read.
    const noRead = await issueToken(server, "only runs", ["run"]);
    const forbidden = await fetch(`${server.url}/mcp/${slug}`, { method: "POST", headers: { authorization: `Bearer ${noRead}`, "content-type": "application/json" }, body: JSON.stringify(PING) });
    assert.equal(forbidden.status, 403);
    const params = challengeParams(forbidden.headers.get("www-authenticate"));
    assert.deepEqual([params.error, params.scope, params.resource_metadata], ["insufficient_scope", "mcp:read", `${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`]);
  });
});

test("S7B: the server announces `mcp-oauth`, and the status of a book's MCP says where its OAuth server is and how many apps are connected", async () => {
  await withServer(async (server, client) => {
    const info = await (await fetch(`${server.url}/api/v1/info`)).json();
    assert.ok(info.features.includes("mcp-oauth"), JSON.stringify(info.features));
    assert.ok(info.features.includes("mcp"), "next to the one it already announced");
    assert.equal(new Set(info.features).size, info.features.length);

    const { slug } = await mcpFixture(server, client);
    const route = await mcpRoute(server);
    const before = (await route.get()).json;
    assert.equal(before.connections, 0);
    assert.deepEqual(before.oauth, {
      issuer: server.url,
      metadataUrl: `${server.url}/.well-known/oauth-authorization-server`,
      resourceMetadataUrl: `${server.url}/.well-known/oauth-protected-resource/mcp/${slug}`,
      scopes: SCOPES,
    });
    assert.equal(before.url, `${server.url}/mcp/${slug}`, "what phase A said is still said");

    await connectApp(server, { slug });
    assert.equal((await route.get()).json.connections, 1);

    await setPublic(server);
    const published = (await route.get()).json;
    assert.equal(published.oauth.issuer, PUBLIC_URL, "with a public address the issuer is the public one");
    assert.equal(published.oauth.resourceMetadataUrl, `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/${slug}`);
    assert.equal((await route.put({ enabled: false })).json.connections, 0, "switching the book off takes the connections with it");
  });
});
