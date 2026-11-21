import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Auth, Vault } from "../dist/testing.mjs";
import { adminLogin, until, withServer } from "./helpers.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const OWNER = "198.51.100.4";
const STRANGER = "203.0.113.9";

/** One request with full control of the headers (fetch refuses some of them). */
function send(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: { ...headers, ...(payload ? { "content-length": payload.length } : {}) }, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/** The server as it is reached through its tunnel: the address Cloudflare reports is believed. */
async function behindTunnel(server) {
  await server.data.updateConfig((config) => {
    config.publicUrl = "https://books.example.com";
  });
}

const statusOf = async (admin) => (await admin.call("GET", "/admin/api/status")).body;

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/session: a device disconnects itself, nobody else
// ---------------------------------------------------------------------------------------------

const SCOPE_SETS = [["read"], ["write"], ["run"], ["update"], ["read", "write"], ["read", "write", "run", "update"]];

test("D1: DELETE /session with a token of any scope revokes that client's token and no other client", async () => {
  for (const scopes of SCOPE_SETS) {
    await withServer(async (server) => {
      const caller = await server.auth.issue("caller", scopes);
      const bystanders = [];
      for (const other of SCOPE_SETS) bystanders.push({ ...(await server.auth.issue(`bystander ${other.join("+")}`, other)), scopes: other });
      const answer = await send(`${server.url}/api/v1/session`, { method: "DELETE", headers: bearer(caller.token) });
      assert.equal(answer.status, 200, `${scopes}: ${answer.text}`);
      assert.deepEqual(answer.json, { revoked: true });
      const revoked = server.auth.list().clients.filter((client) => client.revoked).map((client) => client.id);
      assert.deepEqual(revoked, [caller.clientId], `${scopes}: only the caller is revoked`);
      assert.throws(() => server.auth.authenticate(caller.token), (error) => error.status === 401);
      for (const bystander of bystanders) assert.doesNotThrow(() => server.auth.authenticate(bystander.token), `bystander ${bystander.scopes}`);
      const again = await send(`${server.url}/api/v1/session`, { method: "DELETE", headers: bearer(caller.token) });
      assert.equal(again.status, 401, "a token that is already revoked is just invalid");
    });
  }
});

test("D1: DELETE /session ignores every identifier the caller supplies: the query, the body and the path", async () => {
  await withServer(async (server) => {
    const victim = await server.auth.issue("victim", ["read", "write", "run", "update"]);
    const freshCaller = () => server.auth.issue("caller", ["read"]);
    for (const [route, body] of [
      [`/api/v1/session?id=${victim.clientId}&clientId=${victim.clientId}`, undefined],
      ["/api/v1/session", { id: victim.clientId, clientId: victim.clientId, revoke: victim.clientId }],
    ]) {
      const caller = await freshCaller();
      const answer = await send(`${server.url}${route}`, { method: "DELETE", headers: { ...bearer(caller.token), ...JSON_HEADERS }, body });
      assert.equal(answer.status, 200, answer.text);
      assert.throws(() => server.auth.authenticate(caller.token), (error) => error.status === 401, "the caller is disconnected");
      assert.doesNotThrow(() => server.auth.authenticate(victim.token), "the named client is not touched");
    }
    const caller = await freshCaller();
    const named = await send(`${server.url}/api/v1/session/${victim.clientId}`, { method: "DELETE", headers: bearer(caller.token) });
    assert.equal(named.status, 404, "there is no route to revoke somebody else by id");
    assert.doesNotThrow(() => server.auth.authenticate(caller.token), "and a refused request revokes nothing");
    assert.equal(server.auth.list().clients.find((client) => client.id === victim.clientId).revoked, false);
  });
});

test("D1: a client that disconnects ends its own live streams and nobody else's", async () => {
  await withServer(async (server) => {
    const leaving = await server.auth.issue("leaving", ["read"]);
    const staying = await server.auth.issue("staying", ["read"]);
    const open = (token) => new Promise((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: server.port, path: "/api/v1/events", agent: false, headers: { ...bearer(token), accept: "text/event-stream" } }, (response) => {
        const state = { request, closed: false };
        response.on("close", () => {
          state.closed = true;
        });
        response.once("data", () => resolve(state));
      });
      request.on("error", () => undefined);
      request.end();
    });
    const [mine, theirs] = await Promise.all([open(leaving.token), open(staying.token)]);
    assert.equal((await send(`${server.url}/api/v1/session`, { method: "DELETE", headers: bearer(leaving.token) })).status, 200);
    await until(() => mine.closed, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(theirs.closed, false, "the other client's stream is still open");
    mine.request.destroy();
    theirs.request.destroy();
  });
});

test("D1: a token that was replaced while its request was in flight cannot revoke its replacement", async () => {
  await withServer(async (server) => {
    const phone = await server.auth.issue("Phone", ["read", "write"]);
    const bystander = await server.auth.issue("Tablet", ["read"]);
    let replacement;
    // The request authenticates with the old token; the owner's rotation is already queued when its revocation gets its turn.
    const authenticate = server.auth.authenticate.bind(server.auth);
    server.auth.authenticate = (token, scope) => {
      const client = authenticate(token, scope);
      if (token === phone.token && !replacement) replacement = server.auth.issue("Phone", ["read", "write"], client.id);
      return client;
    };
    const answer = await send(`${server.url}/api/v1/session`, { method: "DELETE", headers: bearer(phone.token) });
    server.auth.authenticate = authenticate;
    assert.equal(answer.status, 200, answer.text);
    const renewed = await replacement;
    assert.equal(renewed.clientId, phone.clientId, "rotation keeps the client id");
    assert.doesNotThrow(() => server.auth.authenticate(renewed.token), "the new token of the rotated client is not revoked by the old token's request");
    assert.equal(server.auth.list().clients.find((client) => client.id === phone.clientId).revoked, false);
    assert.doesNotThrow(() => server.auth.authenticate(bystander.token));
    assert.throws(() => server.auth.authenticate(phone.token), (error) => error.status === 401, "the old token is dead because it was replaced");
  });
});

// ---------------------------------------------------------------------------------------------
// Pairing: who is asking, from where, and a code both sides can compare
// ---------------------------------------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(text).digest();
/** The four digits shown on both sides: a documented function of the SHA-256 (hex) of a secret. */
const fourDigits = (domain, hashHex) => String(sha256(`narrarium-pairing-verification\n${domain}\n${hashHex}`).readUInt32BE(0) % 10_000).padStart(4, "0");
const tokenHash = (token) => sha256(token).toString("hex");

async function pair(server, admin, { ip, userAgent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", label = "Laptop", approve = true, allowUpdate = false } = {}) {
  const { body: pairing } = await admin.call("POST", "/admin/api/pairing", {});
  const nonce = "a1".repeat(32);
  const headers = { ...JSON_HEADERS, "user-agent": userAgent, ...(ip ? { "cf-connecting-ip": ip } : {}) };
  const requested = await send(`${server.url}/api/v1/pairings`, { method: "POST", headers, body: { code: pairing.code, nonce, label } });
  assert.equal(requested.status, 200, requested.text);
  const pending = (await statusOf(admin)).pairing;
  if (approve) assert.equal((await admin.call("POST", "/admin/api/pairing/approve", { id: pending.id, allowUpdate })).status, 200);
  const result = approve ? await send(`${server.url}/api/v1/pairings/${requested.json.id}/result`, { method: "POST", headers: { ...JSON_HEADERS, ...(ip ? { "cf-connecting-ip": ip } : {}) }, body: { nonce } }) : undefined;
  return { requested: requested.json, pending, result: result?.json, nonce, id: requested.json.id };
}

test("P1: the panel lists where every client came from: source, user agent and time", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const admin = await adminLogin(server);
    const before = Date.now();
    const paired = await pair(server, admin, { ip: STRANGER, userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1.15", label: "Alessandro's MacBook" });
    const clients = (await statusOf(admin)).clients;
    const client = clients.find((entry) => entry.label === "Alessandro's MacBook");
    assert.equal(client.source, STRANGER, "the source is the one the rate limits use (the address Cloudflare reports)");
    assert.equal(client.userAgent, "Mozilla/5.0 (Macintosh) Safari/605.1.15");
    assert.ok(Date.parse(client.createdAt) >= before - 1000 && Date.parse(client.createdAt) <= Date.now() + 1000, `created ${client.createdAt}`);
    assert.equal(client.hash, undefined, "hashes still never leave the server");
    assert.equal(client.verification, paired.result.verification);

    const issued = await admin.call("POST", "/admin/api/token", { label: "From the panel", scopes: ["read"] }, { "user-agent": "Panel browser/1.0" });
    assert.equal(issued.status, 200);
    const fromPanel = (await statusOf(admin)).clients.find((entry) => entry.id === issued.body.clientId);
    assert.equal(fromPanel.source, "local", "a token made in the panel from this computer says so");
    assert.equal(fromPanel.userAgent, "Panel browser/1.0");
    assert.equal(fromPanel.verification, fourDigits("client", tokenHash(issued.body.token)));
  });
});

test("P1: without a public address the source is the socket's, whatever header a caller invents", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    await pair(server, admin, { ip: STRANGER, label: "Spoofer" });
    assert.equal((await statusOf(admin)).clients.find((entry) => entry.label === "Spoofer").source, "local", "the Cloudflare header proves nothing here");
  });
});

test("P1: a pairing request waiting for approval shows its source, user agent, time and a code to compare", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const admin = await adminLogin(server);
    const paired = await pair(server, admin, { ip: STRANGER, userAgent: "curl/8.5.0", label: "Alessandro's MacBook Pro", approve: false });
    const pending = paired.pending;
    assert.equal(pending.requested, true);
    assert.equal(pending.label, "Alessandro's MacBook Pro");
    assert.equal(pending.source, STRANGER);
    assert.equal(pending.userAgent, "curl/8.5.0");
    assert.ok(Math.abs(Date.parse(pending.requestedAt) - Date.now()) < 5_000);
    assert.match(pending.verification, /^\d{4}$/);
    assert.equal(paired.requested.verification, pending.verification, "the device is told the same four digits");
    assert.equal(pending.verification, fourDigits("request", tokenHash(paired.nonce)), "derived from the client's own nonce, so it can compute them too");
    assert.deepEqual(Object.keys(paired.requested).sort(), ["id", "verification"], "the existing field stays, one optional field is added");
  });
});

test("P1: the pairing result keeps its token and carries the verification of that token, also shown next to the client", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const paired = await pair(server, admin, { label: "Phone" });
    assert.match(paired.result.token, /^nrs_[\w-]{43}$/);
    assert.match(paired.result.verification, /^\d{4}$/);
    assert.equal(paired.result.verification, fourDigits("client", tokenHash(paired.result.token)), "the formula is public: a device can compute it from its token");
    const client = (await statusOf(admin)).clients.find((entry) => entry.label === "Phone");
    assert.equal(client.verification, paired.result.verification, "the panel shows what the device shows");
    // A poll that is not ready yet is still just { pending: true }.
    const { body: next } = await admin.call("POST", "/admin/api/pairing", {});
    const request = await send(`${server.url}/api/v1/pairings`, { method: "POST", headers: JSON_HEADERS, body: { code: next.code, nonce: "b2".repeat(32), label: "Slow" } });
    const waiting = await send(`${server.url}/api/v1/pairings/${request.json.id}/result`, { method: "POST", headers: JSON_HEADERS, body: { nonce: "b2".repeat(32) } });
    assert.deepEqual(waiting.json, { pending: true });
  });
});

test("P1: the user agent is bounded and cleaned before it is kept or shown", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const dirty = `Mozilla/5.0\t(X11)\u0085\u009b[31mred\u00a0\u00a0spaces${" long".repeat(400)}`;
    await pair(server, admin, { userAgent: dirty, label: "Dirty" });
    const kept = (await statusOf(admin)).clients.find((entry) => entry.label === "Dirty").userAgent;
    assert.ok(kept.length > 0 && kept.length <= 200, `length ${kept.length}`);
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(kept), false, "no control character");
    assert.ok(kept.startsWith("Mozilla/5.0 (X11)"), kept);
    assert.equal(/\s{2,}/.test(kept), false, "runs of spaces are one space");
    const stored = JSON.parse(await readFile(path.join(server.data.root, "private", "authorization.json"), "utf8")).clients.find((entry) => entry.label === "Dirty");
    assert.equal(stored.userAgent, kept, "what is stored is what is shown");
    await pair(server, admin, { userAgent: "", label: "No agent" });
    assert.equal((await statusOf(admin)).clients.find((entry) => entry.label === "No agent").userAgent, undefined, "an absent user agent is simply not there");
  });
});

test("P1: a pairing code is used once, and it expires: after five minutes the code and its approval are refused", async () => {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await withServer(async (server) => {
      const admin = await adminLogin(server);
      const first = await admin.call("POST", "/admin/api/pairing", {});
      const request = (code, nonce) => send(`${server.url}/api/v1/pairings`, { method: "POST", headers: JSON_HEADERS, body: { code, nonce, label: "Device" } });
      assert.equal((await request(first.body.code, "c3".repeat(32))).status, 200);
      assert.equal((await request(first.body.code, "d4".repeat(32))).status, 401, "a second client with the same code is refused");

      const second = await admin.call("POST", "/admin/api/pairing", {});
      offset += 5 * 60_000 + 1_000;
      assert.equal((await request(second.body.code, "e5".repeat(32))).status, 401, "an expired code is refused");

      const third = await admin.call("POST", "/admin/api/pairing", {});
      const requested = await request(third.body.code, "f6".repeat(32));
      assert.equal(requested.status, 200);
      const before = (await statusOf(admin)).pairing;
      assert.equal(before.id, requested.json.id, "the request waits for approval");
      offset += 5 * 60_000 + 1_000;
      assert.equal((await statusOf(admin)).pairing, null, "an expired pairing is not offered for approval");
      const late = await admin.call("POST", "/admin/api/pairing/approve", { id: requested.json.id });
      assert.equal(late.status, 409, "and it cannot be approved late");
      const poll = await send(`${server.url}/api/v1/pairings/${requested.json.id}/result`, { method: "POST", headers: JSON_HEADERS, body: { nonce: "f6".repeat(32) } });
      assert.equal(poll.status, 401, "the device is told it expired");
    });
  } finally {
    Date.now = real;
  }
});

test("P1: authorization.json written before these fields existed is still read, and clients without them are listed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-legacy-auth-"));
  try {
    const vault = await Vault.open(root);
    const auth = await Auth.open(root, vault);
    const issued = await auth.issue("Old client", ["read"]);
    const file = path.join(root, "private", "authorization.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    for (const client of stored.clients) {
      delete client.source;
      delete client.userAgent;
    }
    await writeFile(file, JSON.stringify(stored, null, 2));
    const reopened = await Auth.open(root, vault);
    const [client] = reopened.list().clients;
    assert.equal(client.label, "Old client");
    assert.equal(client.source, undefined);
    assert.equal(client.userAgent, undefined);
    assert.equal(client.verification, fourDigits("client", tokenHash(issued.token)), "the verification needs nothing stored");
    assert.doesNotThrow(() => reopened.authenticate(issued.token));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("P1: the panel shows the new columns and revoking is one click (no confirmation dialog)", async () => {
  await withServer(async (server) => {
    const script = await (await fetch(`${server.adminUrl}/admin.js`)).text();
    for (const field of ["client.source", "client.userAgent", "client.verification", "p.source", "p.userAgent", "p.verification"]) assert.ok(script.includes(field), `the panel reads ${field}`);
    const revoke = script.slice(script.indexOf("var revoke = "), script.indexOf("actions.appendChild(regenerate)"));
    assert.ok(revoke.includes("/admin/api/revoke"), "the revoke button is there");
    assert.equal(revoke.includes("confirm("), false, "and it needs no second click");
    const page = await (await fetch(`${server.adminUrl}/`)).text();
    assert.ok(page.includes('data-i18n="source"') && page.includes('data-i18n="verification"'), "with its table headers");
  });
});

test("P1: the admin script is valid JavaScript (it is a string in the bundle, so nothing else would notice)", async () => {
  await withServer(async (server) => {
    const script = await (await fetch(`${server.adminUrl}/admin.js`)).text();
    assert.doesNotThrow(() => new vm.Script(script, { filename: "admin.js" }));
  });
});
