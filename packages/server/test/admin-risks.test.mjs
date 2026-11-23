import test from "node:test";
import assert from "node:assert/strict";
import * as testing from "../dist/testing.mjs";
import { adminLogin, withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { SoftwarePasskey } from "./passkey-helpers.mjs";
import { PUBLIC_HOST, PUBLIC_URL, connectApp, registerPasskey, setPublic, web } from "./oauth-helpers.mjs";
import { rawApi } from "./api-helpers.mjs";

// The risk banner (P12): what the owner should know, and what to do about it, built only from facts of this server: remote administration that is on and at which address, clients that may
// update or run, apps connected through OAuth that can write, no passkey while the MCP is on, AI endpoints that are not on this computer, spending with no limit. No false alarm: each one
// is there while its fact is true and goes when it is not. `buildRisks` is the pure part; the rest goes through the real server.

const { buildRisks, RISK_LEVELS } = testing;

const facts = (extra = {}) => ({
  remoteAdmin: { on: false },
  clients: [],
  apps: [],
  mcp: { booksOn: 0, passkeys: 0, canAddPasskey: false },
  aiBases: [],
  spend: { unlimited: true, paused: false },
  aiConfigured: false,
  ...extra,
});
const idsOf = (report) => report.risks.map((risk) => risk.id);
const riskOf = (report, id) => report.risks.find((risk) => risk.id === id);
const client = (label, ...scopes) => ({ label, scopes });

test("P12 risks: a server with nothing to say has no risk, and the levels are the three a person is told", () => {
  assert.deepEqual(buildRisks(facts()), { risks: [], counts: { high: 0, medium: 0, note: 0 } });
  assert.deepEqual([...RISK_LEVELS], ["high", "medium", "note"]);
});

test("P12 risks: remote administration is a risk when it is on and has an address, and says which", () => {
  assert.deepEqual(riskOf(buildRisks(facts({ remoteAdmin: { on: true, address: "https://admin.example.com" } })), "remote-admin"), { id: "remote-admin", level: "high", facts: { address: "https://admin.example.com" } });
  assert.deepEqual(idsOf(buildRisks(facts({ remoteAdmin: { on: true } }))), [], "on, but with nowhere to be reached: nothing is exposed");
  assert.deepEqual(idsOf(buildRisks(facts({ remoteAdmin: { on: false, address: "https://admin.example.com" } }))), [], "an address that is not served");
});

test("P12 risks: a client that may update the server is a risk, with the names of those that may", () => {
  const report = buildRisks(facts({ clients: [client("Narrarium", "read", "write", "run"), client("Phone", "read", "update"), client("Laptop", "read", "run", "update"), client("Terminal", "read")] }));
  assert.deepEqual(riskOf(report, "client-update"), { id: "client-update", level: "medium", facts: { count: 2, labels: ["Phone", "Laptop"] } });
  assert.deepEqual(riskOf(report, "client-run"), { id: "client-run", level: "note", facts: { count: 2, labels: ["Narrarium", "Laptop"] } }, "and the ones that may start runs, which spend the owner's AI credits");
  assert.deepEqual(idsOf(buildRisks(facts({ clients: [client("Reader", "read"), client("Writer", "read", "write")] }))), []);
});

test("P12 risks: the names are the first five, and the count is of all; a name is cut", () => {
  const many = Array.from({ length: 8 }, (_, index) => client(`Client ${index + 1}`, "read", "update"));
  const report = buildRisks(facts({ clients: [...many, client("L".repeat(200), "read", "update")] }));
  const found = riskOf(report, "client-update");
  assert.equal(found.facts.count, 9);
  assert.deepEqual(found.facts.labels, ["Client 1", "Client 2", "Client 3", "Client 4", "Client 5"]);
  assert.ok(buildRisks(facts({ clients: [client("L".repeat(200), "update")] })).risks[0].facts.labels[0].length <= 80);
  const apps = Array.from({ length: 7 }, (_, index) => ({ name: `App ${index + 1}`, bookId: "glass", scopes: ["read", "write"] }));
  const written = riskOf(buildRisks(facts({ apps })), "oauth-write");
  assert.equal(written.facts.count, 7);
  assert.deepEqual(written.facts.apps.map((app) => app.name), ["App 1", "App 2", "App 3", "App 4", "App 5"]);
});

test("P12 risks: an app connected through OAuth that can change a book or run the autopilot is a risk; one that can only read is not", () => {
  const report = buildRisks(facts({ apps: [
    { name: "Claude", bookId: "glass", scopes: ["read", "write"] },
    { name: "ChatGPT", bookId: "moon", scopes: ["read"] },
    { name: "Gemini", bookId: "glass", scopes: ["read", "write", "run"] },
  ] }));
  assert.deepEqual(riskOf(report, "oauth-write"), { id: "oauth-write", level: "medium", facts: { count: 2, apps: [{ name: "Claude", bookId: "glass", scopes: ["read", "write"] }, { name: "Gemini", bookId: "glass", scopes: ["read", "write", "run"] }] } });
  assert.deepEqual(idsOf(buildRisks(facts({ apps: [{ name: "ChatGPT", bookId: "moon", scopes: ["read"] }] }))), []);
});

test("P12 risks: no passkey while an MCP is on and the server is on the internet is a risk, and it asks for what is needed to do something about it", () => {
  const mcp = (extra) => buildRisks(facts({ mcp: { booksOn: 2, passkeys: 0, publicUrl: "https://api.example.com", canAddPasskey: true, ...extra } }));
  assert.deepEqual(riskOf(mcp({}), "no-passkey"), { id: "no-passkey", level: "medium", facts: { books: 2, publicUrl: "https://api.example.com", canAddPasskey: true } });
  assert.equal(riskOf(mcp({ canAddPasskey: false, publicUrl: "http://203.0.113.7:24242" }), "no-passkey").facts.canAddPasskey, false, "an address that cannot hold a passkey: the risk is there, and says so");
  assert.deepEqual(idsOf(mcp({ passkeys: 1 })), [], "one is enough");
  assert.deepEqual(idsOf(mcp({ booksOn: 0 })), [], "no MCP is on");
  assert.deepEqual(idsOf(mcp({ publicUrl: undefined, canAddPasskey: false })), [], "the consent page is on this computer only: nobody can type the admin code from the internet");
});

test("P12 risks: AI endpoints that are not on this computer are a note, with the hosts; this computer's own are not", () => {
  const bases = (...list) => riskOf(buildRisks(facts({ aiBases: list })), "ai-remote");
  assert.deepEqual(bases("https://api.openai.com/v1", "https://my-resource.openai.azure.com/openai/v1", "https://api.openai.com"), { id: "ai-remote", level: "note", facts: { count: 3, hosts: ["api.openai.com", "my-resource.openai.azure.com"] } }, "each host once");
  assert.equal(bases("http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1", "http://127.1.2.3/v1"), undefined, "a model on this computer sends nothing away");
  assert.deepEqual(bases("http://127.0.0.1:11434/v1", "https://api.openai.com/v1").facts, { count: 1, hosts: ["api.openai.com"] });
  assert.equal(bases("not an address", "ftp://x.example"), undefined, "what is not an address is not a place");
  assert.equal(bases(), undefined);
});

test("P12 risks: spending with no limit is a risk only when somebody can spend: an AI that is set up, a client or an app that can run, and no switch off or limit", () => {
  const spend = (extra) => buildRisks(facts({ aiConfigured: true, spend: { unlimited: true, paused: false }, clients: [client("Narrarium", "read", "write", "run")], ...extra }));
  assert.deepEqual(riskOf(spend({}), "spend-unlimited"), { id: "spend-unlimited", level: "medium", facts: { clients: 1, apps: 0 } });
  assert.deepEqual(riskOf(spend({ clients: [], apps: [{ name: "Claude", bookId: "glass", scopes: ["read", "run"] }] }), "spend-unlimited").facts, { clients: 0, apps: 1 });
  assert.equal(riskOf(spend({ spend: { unlimited: false, paused: false } }), "spend-unlimited"), undefined, "a limit is set");
  assert.equal(riskOf(spend({ spend: { unlimited: true, paused: true } }), "spend-unlimited"), undefined, "the owner's switch is off");
  assert.equal(riskOf(spend({ aiConfigured: false }), "spend-unlimited"), undefined, "no AI to spend");
  assert.equal(riskOf(spend({ clients: [client("Reader", "read", "write")] }), "spend-unlimited"), undefined, "nobody can start a run");
});

test("P12 risks: the list is ordered by how much it matters, and counted", () => {
  const report = buildRisks(facts({
    remoteAdmin: { on: true, address: "https://admin.example.com" },
    clients: [client("Phone", "read", "run", "update")],
    apps: [{ name: "Claude", bookId: "glass", scopes: ["read", "write"] }],
    mcp: { booksOn: 1, passkeys: 0, publicUrl: "https://api.example.com", canAddPasskey: true },
    aiBases: ["https://api.openai.com/v1"],
    aiConfigured: true,
  }));
  assert.deepEqual(idsOf(report), ["remote-admin", "client-update", "oauth-write", "spend-unlimited", "no-passkey", "client-run", "ai-remote"]);
  assert.deepEqual(report.risks.map((risk) => risk.level), ["high", "medium", "medium", "medium", "medium", "note", "note"]);
  assert.deepEqual(report.counts, { high: 1, medium: 4, note: 2 });
});

test("P12 risks: facts that are missing, odd or hostile never break the list", () => {
  assert.doesNotThrow(() => buildRisks({}));
  assert.doesNotThrow(() => buildRisks(facts({ clients: [null, {}, { label: 5, scopes: "update" }, { label: "x", scopes: [1, 2] }], apps: [undefined, { name: null }], aiBases: [5, null, {}] })));
  assert.deepEqual(idsOf(buildRisks(facts({ clients: [{ label: "x", scopes: "update" }] }))), []);
});

// ---------------------------------------------------------------------------------------------
// Through the server
// ---------------------------------------------------------------------------------------------

const risks = async (owner) => {
  const answer = await owner.call("GET", "/admin/api/risks");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const form = (extra) => ({ allowedAiBases: [], origins: [], publicUrl: "", adminPublicUrl: "", allowRemoteAdmin: false, ...extra });

test("P12 risks: a server in its usual state says what is true of it: a client that can run, and spending with no limit", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const report = await risks(owner);
    assert.deepEqual(idsOf(report), ["spend-unlimited", "client-run"]);
    assert.deepEqual(riskOf(report, "client-run").facts, { count: 1, labels: ["test client"] });
    assert.deepEqual(riskOf(report, "spend-unlimited").facts, { clients: 1, apps: 0 });
    assert.deepEqual(report.counts, { high: 0, medium: 1, note: 1 });
    // The list is the same however often it is asked, and nothing was written by asking.
    assert.deepEqual(await risks(owner), report);
  });
});

test("P12 risks: remote administration is a risk while it is on at an address, with that address, and goes when it is turned off or has no address", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal(riskOf(await risks(owner), "remote-admin"), undefined);
    await owner.call("POST", "/admin/api/network", form({ allowRemoteAdmin: true, adminPublicUrl: "https://admin.example.test" }));
    assert.deepEqual(riskOf(await risks(owner), "remote-admin"), { id: "remote-admin", level: "high", facts: { address: "https://admin.example.test" } });
    await owner.call("POST", "/admin/api/network", form({ allowRemoteAdmin: true, publicUrl: "https://api.example.test" }));
    assert.equal(riskOf(await risks(owner), "remote-admin").facts.address, "https://api.example.test", "without an address of its own the panel is on the public one");
    await owner.call("POST", "/admin/api/network", form({ allowRemoteAdmin: true }));
    assert.equal(riskOf(await risks(owner), "remote-admin"), undefined, "on, with nowhere to be reached");
    await owner.call("POST", "/admin/api/network", form({ allowRemoteAdmin: false, adminPublicUrl: "https://admin.example.test" }));
    assert.equal(riskOf(await risks(owner), "remote-admin"), undefined, "turned off");
  });
});

test("P12 risks: a client that may update is a risk while its token works, and goes when the owner revokes it", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    const issued = await owner.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read", "update"] });
    const found = riskOf(await risks(owner), "client-update");
    assert.deepEqual(found, { id: "client-update", level: "medium", facts: { count: 1, labels: ["Phone"] } });
    const text = JSON.stringify(await risks(owner));
    assert.equal(text.includes(issued.body.token), false, "a name, never a token");
    assert.equal((await owner.call("POST", "/admin/api/revoke", { id: issued.body.clientId })).status, 200);
    assert.equal(riskOf(await risks(owner), "client-update"), undefined);
    const again = await owner.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read", "update"] });
    assert.ok(riskOf(await risks(owner), "client-update"));
    await owner.call("POST", "/admin/api/token", { label: "Phone", scopes: ["read", "write", "run"], replaceId: again.body.clientId });
    assert.equal(riskOf(await risks(owner), "client-update"), undefined, "a token that is renewed without the permission");
  });
});

test("P12 risks: an app that can write is a risk while it is connected, and goes when the owner revokes it or switches the book's MCP off", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const owner = await adminLogin(server);
    await connectApp(server, { slug, name: "Reader app", scopes: ["read"] });
    assert.equal(riskOf(await risks(owner), "oauth-write"), undefined, "an app that can only read");
    await connectApp(server, { slug, name: "Claude", scopes: ["read", "write"] });
    assert.deepEqual(riskOf(await risks(owner), "oauth-write"), { id: "oauth-write", level: "medium", facts: { count: 1, apps: [{ name: "Claude", bookId: "glass", scopes: ["read", "write"] }] } });
    const apps = (await owner.call("GET", "/admin/api/mcp")).body.books[0].apps;
    await owner.call("POST", "/admin/api/mcp/revoke", { id: apps.find((app) => app.name === "Claude").id });
    assert.equal(riskOf(await risks(owner), "oauth-write"), undefined);
    await connectApp(server, { slug, name: "Gemini", scopes: ["read", "run"] });
    assert.ok(riskOf(await risks(owner), "oauth-write"), "an app that can run is one that can write the book's notes");
    await owner.call("POST", "/admin/api/mcp/book", { bookId: "glass", enabled: false });
    assert.equal(riskOf(await risks(owner), "oauth-write"), undefined, "its apps went with the switch");
  });
});

test("P12 risks: no passkey while an MCP is on is a risk once the server is on the internet, and goes when a passkey is added, the MCP is switched off or the address is taken away", async () => {
  await withServer(async (server, client) => {
    await mcpFixture(server, client);
    const owner = await adminLogin(server);
    assert.equal(riskOf(await risks(owner), "no-passkey"), undefined, "the consent page is on this computer only");
    await setPublic(server);
    assert.deepEqual(riskOf(await risks(owner), "no-passkey"), { id: "no-passkey", level: "medium", facts: { books: 1, publicUrl: PUBLIC_URL, canAddPasskey: true } });

    const w = web(server, { host: PUBLIC_HOST });
    const ticket = new URL((await owner.call("POST", "/admin/api/passkeys/link", {})).body.url).hash.slice(1);
    const phone = new SoftwarePasskey();
    assert.equal((await registerPasskey(w, ticket, phone, { label: "Phone" })).status, 200);
    assert.equal(riskOf(await risks(owner), "no-passkey"), undefined, "a passkey is registered");
    assert.equal((await owner.call("POST", "/admin/api/passkeys/remove", { id: phone.id, confirmLast: true })).status, 200);
    assert.ok(riskOf(await risks(owner), "no-passkey"), "and removed again");
    await owner.call("POST", "/admin/api/mcp/book", { bookId: "glass", enabled: false });
    assert.equal(riskOf(await risks(owner), "no-passkey"), undefined, "no MCP is on");
    await owner.call("POST", "/admin/api/mcp/book", { bookId: "glass", enabled: true });
    assert.ok(riskOf(await risks(owner), "no-passkey"));
    await server.data.updateConfig((config) => {
      delete config.publicUrl;
    });
    assert.equal(riskOf(await risks(owner), "no-passkey"), undefined, "the address is gone");
    await server.data.updateConfig((config) => {
      config.publicUrl = "http://203.0.113.7:24242";
    });
    assert.equal(riskOf(await risks(owner), "no-passkey").facts.canAddPasskey, false, "an address with no name cannot hold a passkey");
  });
});

test("P12 risks: AI endpoints that the owner approved and that are not on this computer are a note, and go with the approval", async () => {
  await withServer(async (server) => {
    const owner = await adminLogin(server);
    assert.equal(riskOf(await risks(owner), "ai-remote"), undefined);
    await owner.call("POST", "/admin/api/ai/approve", { bases: ["http://127.0.0.1:11434/v1"] });
    assert.equal(riskOf(await risks(owner), "ai-remote"), undefined, "a model on this computer");
    await owner.call("POST", "/admin/api/ai/approve", { bases: ["https://api.openai.com/v1", "https://my-resource.openai.azure.com/openai/v1"] });
    assert.deepEqual(riskOf(await risks(owner), "ai-remote"), { id: "ai-remote", level: "note", facts: { count: 2, hosts: ["api.openai.com", "my-resource.openai.azure.com"] } });
    await owner.call("POST", "/admin/api/network", form({ allowedAiBases: ["http://127.0.0.1:11434/v1"] }));
    assert.equal(riskOf(await risks(owner), "ai-remote"), undefined);
  });
});

test("P12 risks: spending with no limit is a risk while somebody can spend, and goes with a limit, the owner's switch, or when nobody can run", async () => {
  await withServer(async (server, client) => {
    const owner = await adminLogin(server);
    assert.equal(riskOf(await risks(owner), "spend-unlimited"), undefined, "no AI is set up: there is nothing to spend");
    await client.putAiConfig({ aiIntegrations: [{ id: "a", name: "Local", provider: "openai", endpoint: "http://127.0.0.1:11434/v1", apiKey: "sk-secret-value", chatModels: [{ id: "m", name: "m", capabilities: ["default"] }] }] });
    assert.deepEqual(riskOf(await risks(owner), "spend-unlimited").facts, { clients: 1, apps: 0 });
    await owner.call("POST", "/admin/api/spend", { maxCostPerRun: 5 });
    assert.equal(riskOf(await risks(owner), "spend-unlimited"), undefined, "a limit of the run");
    await owner.call("POST", "/admin/api/spend", { maxCostPerRun: 0 });
    assert.ok(riskOf(await risks(owner), "spend-unlimited"));
    await owner.call("POST", "/admin/api/spend", { paused: true });
    assert.equal(riskOf(await risks(owner), "spend-unlimited"), undefined, "switched off");
    await owner.call("POST", "/admin/api/spend", { paused: false });
    const apiOnly = (await owner.call("GET", "/admin/api/status")).body.clients.find((entry) => entry.label === "test client");
    await owner.call("POST", "/admin/api/revoke", { id: apiOnly.id });
    assert.equal(riskOf(await risks(owner), "spend-unlimited"), undefined, "nobody can start a run");
    assert.equal(JSON.stringify(await risks(owner)).includes("sk-secret-value"), false);
  }, { ai: undefined });
});

test("P12 risks: nothing in the list is a secret: no token, no code, no key, and no client id", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const owner = await adminLogin(server);
    const connected = await connectApp(server, { slug, name: "Claude", scopes: ["read", "write", "run"] });
    const writer = await rawApi(server, ["read", "write", "run", "update"]);
    await setPublic(server);
    await owner.call("POST", "/admin/api/network", form({ allowRemoteAdmin: true, adminPublicUrl: "https://admin.example.test", publicUrl: PUBLIC_URL, allowedAiBases: ["https://api.openai.com/v1"] }));
    const report = await risks(owner);
    assert.ok(report.risks.length >= 6, idsOf(report).join(","));
    const text = JSON.stringify(report);
    const clients = (await owner.call("GET", "/admin/api/status")).body.clients;
    for (const secret of [connected.tokens.access_token, connected.tokens.refresh_token, connected.verifier, connected.app.client_id, writer.token, owner.code, ...clients.map((entry) => entry.id)]) assert.equal(text.includes(secret), false, `not in the list: ${secret.slice(0, 10)}…`);
  });
});

test("P12 risks: the route needs the admin session, answers only to the panel's own origin, and the clients' API has no such route", async () => {
  await withServer(async (server) => {
    const origin = server.adminUrl;
    assert.equal((await fetch(`${origin}/admin/api/risks`, { headers: { origin } })).status, 401);
    assert.equal((await fetch(`${origin}/admin/api/risks`, { headers: { origin: "https://evil.example" } })).status, 403);
    const clientToken = (await server.auth.issue("c", ["read", "write", "run", "update"])).token;
    assert.equal((await fetch(`${origin}/admin/api/risks`, { headers: { origin, authorization: `Bearer ${clientToken}` } })).status, 401);
    assert.equal((await fetch(`${server.url}/api/v1/risks`, { headers: { authorization: `Bearer ${clientToken}` } })).status, 404);
  });
});
