import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { NarrariumServerClient, pairWithServer } from "narrarium-engine";
import { adminLogin, until, withServer } from "./helpers.mjs";

/** A request with a Host header of our choice (fetch cannot set it). */
function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

/** Open a live stream and resolve `connected` on its first message. */
function openStream(client) {
  let connected;
  const ready = new Promise((resolve) => {
    connected = resolve;
  });
  const ended = client.stream(() => connected(), AbortSignal.timeout(15_000)).then(() => "ended", (error) => error?.name ?? "error");
  return { ready, ended };
}

test("the admin panel needs the admin code, its own origin and a CSRF token", async () => {
  await withServer(async (server) => {
    const page = await fetch(`${server.adminUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await page.text(), /<script src="\/admin\.js" defer><\/script>/);
    assert.equal((await fetch(`${server.adminUrl}/admin.js`)).status, 200);

    const origin = server.adminUrl;
    const wrong = await fetch(`${origin}/admin/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: "x".repeat(43) }) });
    assert.equal(wrong.status, 401);
    const noOrigin = await fetch(`${origin}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noOrigin.status, 403);
    const foreign = await fetch(`${origin}/admin/api/status`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    assert.equal((await rawRequest(`${origin}/`, { headers: { host: "evil.example" } })).status, 403, "a foreign Host never reaches the panel");
    assert.equal((await fetch(`${origin}/admin/api/status`)).status, 401, "no session cookie");

    const admin = await adminLogin(server);
    const login = await fetch(`${origin}/admin/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: admin.code }) });
    assert.match(login.headers.get("set-cookie"), new RegExp(`^nrs_admin_${server.adminPort}=[\\w-]+; HttpOnly; SameSite=Strict; Path=/admin/; Max-Age=1800$`), "one cookie name per admin port: two servers on one host keep separate sessions");
    const status = await admin.call("GET", "/admin/api/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.serverId, server.data.config.serverId);
    assert.equal(status.body.fingerprint, server.data.fingerprint);
    assert.equal(status.body.apiPort, server.port);
    assert.equal(status.body.clients.length, 1);
    assert.equal(status.body.clients[0].hash, undefined, "token hashes never leave the server");

    const withoutCsrf = await fetch(`${origin}/admin/api/token`, { method: "POST", headers: { origin, cookie: admin.cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "x", scopes: ["read"] }) });
    assert.equal(withoutCsrf.status, 403);
    assert.equal((await admin.call("POST", "/admin/api/logout", {})).status, 200);
    assert.equal((await admin.call("GET", "/admin/api/status")).status, 401);
  });
});

test("a client pairs with a code and the owner's approval, optionally with the update permission", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const { body: pairing } = await admin.call("POST", "/admin/api/pairing", {});
    assert.match(pairing.code, /^\d{9}$/);
    assert.ok(pairing.expiresAt > Date.now());

    let waiting = false;
    const paired = pairWithServer({ baseUrl: server.url, code: pairing.code.replace(/(\d{3})(?=\d)/g, "$1 "), label: "Laptop", pollMs: 20, onWaitingApproval: () => {
      waiting = true;
    } });
    const pending = await until(async () => {
      const status = await admin.call("GET", "/admin/api/status");
      return status.body.pairing?.requested ? status.body.pairing : undefined;
    });
    assert.equal(waiting, true);
    assert.equal(pending.label, "Laptop");
    const reused = await fetch(`${server.url}/api/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, nonce: "a".repeat(64), label: "Intruder" }) });
    assert.equal(reused.status, 401, "a code is used by one client only");

    assert.equal((await admin.call("POST", "/admin/api/pairing/approve", { id: pending.id, allowUpdate: true })).status, 200);
    const token = await paired;
    assert.match(token, /^nrs_[\w-]{43}$/);
    const laptop = new NarrariumServerClient({ baseUrl: server.url, token });
    const session = await laptop.session();
    assert.equal(session.clientLabel, "Laptop");
    assert.deepEqual(session.scopes, ["read", "write", "run", "update"]);
    assert.equal((await admin.call("GET", "/admin/api/status")).body.pairing, null, "the token is delivered once");

    const second = await admin.call("POST", "/admin/api/pairing", {});
    const phone = pairWithServer({ baseUrl: server.url, code: second.body.code, label: "Phone", pollMs: 20 });
    const request = await until(async () => {
      const status = await admin.call("GET", "/admin/api/status");
      return status.body.pairing?.requested ? status.body.pairing : undefined;
    });
    await admin.call("POST", "/admin/api/pairing/approve", { id: request.id });
    const phoneSession = await new NarrariumServerClient({ baseUrl: server.url, token: await phone }).session();
    assert.deepEqual(phoneSession.scopes, ["read", "write", "run"], "without the checkbox a paired client cannot update the server");
  });
});

test("wrong pairing codes are refused and a code stops working after five wrong attempts", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const { body: pairing } = await admin.call("POST", "/admin/api/pairing", {});
    const wrongCode = pairing.code === "123456789" ? "987654321" : "123456789";
    await assert.rejects(() => pairWithServer({ baseUrl: server.url, code: wrongCode, label: "Guess", pollMs: 20 }), (error) => error.status === 401 && error.code === "pairing_invalid");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() => pairWithServer({ baseUrl: server.url, code: wrongCode, label: "Guess", pollMs: 20 }));
    }
    await assert.rejects(() => pairWithServer({ baseUrl: server.url, code: pairing.code, label: "Late", pollMs: 20 }), (error) => error.status === 401, "the code is burnt after five wrong attempts");
    const badShape = await fetch(`${server.url}/api/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "12", nonce: "x", label: "" }) });
    assert.equal(badShape.status, 400);
    await admin.call("POST", "/admin/api/pairing/cancel", {});
    assert.equal((await admin.call("GET", "/admin/api/status")).body.pairing, null);
  });
});

test("issuing, rotating and revoking client tokens; revoked or replaced tokens lose their live stream", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const issued = await admin.call("POST", "/admin/api/token", { label: "Tablet", scopes: ["read"] });
    assert.equal(issued.status, 200);
    const tablet = new NarrariumServerClient({ baseUrl: server.url, token: issued.body.token });
    assert.deepEqual((await tablet.session()).scopes, ["read"]);
    assert.equal((await admin.call("POST", "/admin/api/token", { label: "Bad", scopes: ["read", "admin"] })).status, 422);
    assert.equal((await admin.call("POST", "/admin/api/token", { label: "", scopes: ["read"] })).status, 422);

    const first = openStream(tablet);
    await first.ready;
    const rotated = await admin.call("POST", "/admin/api/token", { label: "Tablet", scopes: ["read", "write"], replaceId: issued.body.clientId });
    assert.equal(rotated.body.clientId, issued.body.clientId, "rotation keeps the client id");
    assert.equal(await first.ended, "ended", "the old token's stream is closed at once");
    await assert.rejects(() => tablet.session(), (error) => error.status === 401);
    const renewed = new NarrariumServerClient({ baseUrl: server.url, token: rotated.body.token });
    assert.deepEqual((await renewed.session()).scopes, ["read", "write"]);

    const second = openStream(renewed);
    await second.ready;
    assert.deepEqual((await admin.call("POST", "/admin/api/revoke", { id: issued.body.clientId })).body, { revoked: true });
    assert.equal(await second.ended, "ended");
    await assert.rejects(() => renewed.session(), (error) => error.status === 401);
    const listed = (await admin.call("GET", "/admin/api/status")).body.clients.find((client) => client.id === issued.body.clientId);
    assert.equal(listed.revoked, true);

    const phone = await admin.call("POST", "/admin/api/token", { label: "Phone", scopes: ["run"] });
    const leaving = new NarrariumServerClient({ baseUrl: server.url, token: phone.body.token });
    assert.deepEqual(await leaving.forgetSession(), { revoked: true }, "a device disconnecting revokes its own token, whatever its permissions");
    await assert.rejects(() => leaving.session(), (error) => error.status === 401);
    assert.equal((await admin.call("GET", "/admin/api/status")).body.clients.find((client) => client.id === phone.body.clientId).revoked, true);
  });
});

test("the admin code can be rotated or replaced; sessions end, client tokens keep working", async () => {
  await withServer(async (server, client) => {
    const admin = await adminLogin(server);
    const rotated = await admin.call("POST", "/admin/api/admin-code/rotate", {});
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.code.length, 43);
    assert.notEqual(rotated.body.code, admin.code);
    assert.equal((await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim(), rotated.body.code);
    assert.equal((await admin.call("GET", "/admin/api/status")).status, 401, "every admin session ended");
    assert.equal((await client.session()).clientLabel, "test client", "client tokens are not affected");

    const again = await adminLogin(server);
    assert.equal(again.code, rotated.body.code);
    assert.equal((await again.call("POST", "/admin/api/admin-code/set", { code: "too short" })).status, 422);
    const chosen = "my own very long admin code, typed twice";
    assert.equal((await again.call("POST", "/admin/api/admin-code/set", { code: chosen })).status, 200);
    assert.equal((await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim(), chosen);
    assert.equal((await adminLogin(server)).code, chosen);
  });
});

test("the admin panel and the API can be reached through one public address (Cloudflare)", async () => {
  await withServer(async (server, client) => {
    const admin = await adminLogin(server);
    assert.equal((await admin.call("POST", "/admin/api/network", { publicUrl: "http://books.example.com" })).status, 422, "public addresses must be https");
    const saved = await admin.call("POST", "/admin/api/network", {
      allowedAiBases: ["https://api.openai.com/v1"],
      origins: ["https://my-reader.example.org/"],
      publicUrl: "https://books.example.com",
      adminPublicUrl: "https://admin.example.com",
      allowRemoteAdmin: true,
    });
    assert.equal(saved.status, 200);
    const status = (await admin.call("GET", "/admin/api/status")).body;
    assert.deepEqual(status.allowedAiBases, ["https://api.openai.com/v1"], "an approval keeps its path: it covers that base, not the whole origin");
    assert.deepEqual(status.origins, ["https://my-reader.example.org"]);
    assert.equal(status.publicUrl, "https://books.example.com");

    const direct = await rawRequest(`${server.url}/api/v1/info`, { headers: { host: "books.example.com" } });
    assert.equal(direct.status, 200, "the API accepts its public hostname");
    const panel = await rawRequest(`${server.adminUrl}/`, { headers: { host: "admin.example.com" } });
    assert.equal(panel.status, 200, "the panel is served on its public hostname");
    const gateway = await rawRequest(`${server.adminUrl}/api/v1/info`, { headers: { host: "admin.example.com", origin: "https://my-reader.example.org" } });
    assert.equal(gateway.status, 200, "/api/v1 is bridged to the API");
    assert.equal(JSON.parse(gateway.text).serverId, server.data.config.serverId);
    assert.equal(gateway.headers["access-control-allow-origin"], "https://my-reader.example.org");
    const unauthenticated = await rawRequest(`${server.adminUrl}/api/v1/books`, { headers: { host: "admin.example.com" } });
    assert.equal(unauthenticated.status, 401, "the gateway does not bypass client tokens");
    const remoteLogin = await rawRequest(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { host: "admin.example.com", origin: "https://admin.example.com", "content-type": "application/json" }, body: JSON.stringify({ code: admin.code }) });
    assert.equal(remoteLogin.status, 200);
    assert.match(remoteLogin.headers["set-cookie"][0], /; Secure$/, "the remote admin cookie is HTTPS-only");
    assert.equal((await rawRequest(`${server.adminUrl}/`, { headers: { host: "books.example.com" } })).status, 403, "the API hostname does not open the panel");

    await admin.call("POST", "/admin/api/network", { publicUrl: "https://books.example.com", adminPublicUrl: "https://admin.example.com", allowRemoteAdmin: false });
    assert.equal((await rawRequest(`${server.adminUrl}/`, { headers: { host: "admin.example.com" } })).status, 403, "remote admin can be switched off");
    assert.ok((await client.session()).clientId);
  });
});
