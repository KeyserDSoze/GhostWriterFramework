import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as testing from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";

// "Remember this device" (P13): a sign-in to the admin panel that asks for it gets a random device token, once. The server keeps only its SHA-256, a label made of the browser and the
// system, and two times; the page keeps the token. A silent sign-in with it goes through the same budget as the admin code, is refused in the same words, and the owner can revoke one
// device, all of them, or change the code and revoke them all. The admin code itself is never kept by the page.

const { Auth, Vault, deviceLabel } = testing;

const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const WRONG_TOKEN = `nrd_${"x".repeat(43)}`;

const devicesFile = (server) => path.join(server.data.root, "private", "admin-devices.json");
const exists = (file) => access(file).then(() => true, () => false);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const adminCode = async (server) => (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();

/** A sign-in as the panel's page makes it. */
async function login(server, body, headers = {}) {
  const response = await fetch(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  const json = text ? JSON.parse(text) : undefined;
  return { status: response.status, json, text, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";")[0], csrf: json?.csrf };
}

/** A call with a session that a sign-in made. */
async function call(server, session, method, route, body) {
  const response = await fetch(`${server.adminUrl}${route}`, {
    method,
    headers: { origin: server.adminUrl, cookie: session.cookie, "content-type": "application/json", ...(method === "POST" ? { "x-csrf-token": session.csrf } : {}) },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined, text, headers: response.headers };
}

/** The clock moves for everybody (the devices read `Date.now`); the original is always put back. */
async function withClock(run) {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    await run((milliseconds) => {
      offset += milliseconds;
    });
  } finally {
    Date.now = real;
  }
}

async function withAuth(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-devices-"));
  try {
    const vault = await Vault.open(root);
    await run({ root, vault, open: () => Auth.open(root, vault), codeFile: path.join(root, "private", "admin-code.txt") });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("P13 devices: a label is the browser and the system, in one short neutral line, and nothing else of the user agent", () => {
  assert.equal(deviceLabel(CHROME_WINDOWS), "Chrome · Windows");
  assert.equal(deviceLabel(FIREFOX_LINUX), "Firefox · Linux");
  assert.equal(deviceLabel(SAFARI_IPHONE), "Safari · iPhone", "an iPhone is not a Mac");
  assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"), "Safari · macOS");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"), "Chrome · Android", "Android is not Linux");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"), "Edge · Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1"), "Chrome · iPhone");
  assert.equal(deviceLabel("curl/8.5.0"), "Unknown browser");
  for (const odd of [undefined, null, 5, "", " ", "\u0000\u202e"]) assert.equal(deviceLabel(odd), "Unknown browser", String(odd));
  const hostile = deviceLabel(`${CHROME_WINDOWS} ${"A".repeat(5000)} <script>alert(1)</script>`);
  assert.equal(hostile, "Chrome · Windows", "what is in the agent beyond the two words is not kept");
  assert.ok(deviceLabel(`Firefox/1 ${"Windows ".repeat(500)}`).length <= 60);
});

test("P13 devices: a device is remembered only when the sign-in asks for it; otherwise nothing is made, answered or written", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const plain = await login(server, { code });
    assert.equal(plain.status, 200);
    assert.deepEqual(Object.keys(plain.json), ["csrf"], "nothing but the session's token");
    assert.equal(await exists(devicesFile(server)), false, "no file was made");
    for (const remember of [false, "true", 1, "yes", null]) {
      const answer = await login(server, { code, remember });
      assert.deepEqual(Object.keys(answer.json), ["csrf"], `remember: ${JSON.stringify(remember)} is not a yes`);
    }
    assert.equal(await exists(devicesFile(server)), false, "and still no file");
    assert.deepEqual((await call(server, plain, "GET", "/admin/api/devices")).json, { devices: [] });
  });
});

test("P13 devices: the token is made once, 256 random bits; the server keeps its SHA-256, a label and two times, in a private file, and never the token", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const remembered = await login(server, { code, remember: true }, { "user-agent": CHROME_WINDOWS });
    assert.equal(remembered.status, 200);
    const { device } = remembered.json;
    assert.deepEqual(Object.keys(device).sort(), ["createdAt", "id", "label", "token"]);
    assert.match(device.token, /^nrd_[A-Za-z0-9_-]{43}$/, "32 random bytes");
    assert.equal(device.label, "Chrome · Windows");
    assert.match(device.id, /^[0-9a-f-]{36}$/);
    assert.equal(new Date(device.createdAt).toISOString(), device.createdAt);

    const text = await readFile(devicesFile(server), "utf8");
    assert.equal(text.includes(device.token), false, "the token is not in the file");
    assert.equal(text.includes(code), false, "and the admin code is not either");
    const file = JSON.parse(text);
    assert.deepEqual(Object.keys(file), ["version", "devices"]);
    assert.equal(file.version, 1);
    assert.equal(file.devices.length, 1);
    assert.deepEqual(Object.keys(file.devices[0]).sort(), ["createdAt", "hash", "id", "label", "lastUsedAt"]);
    assert.equal(file.devices[0].hash, sha256(device.token));
    assert.deepEqual([file.devices[0].id, file.devices[0].label, file.devices[0].createdAt], [device.id, device.label, device.createdAt]);
    if (process.platform !== "win32") assert.equal((await stat(devicesFile(server))).mode & 0o777, 0o600, "private to the user that runs the server");

    const second = await login(server, { code, remember: true }, { "user-agent": FIREFOX_LINUX });
    assert.notEqual(second.json.device.token, device.token, "each device has its own");
    assert.equal(JSON.parse(await readFile(devicesFile(server), "utf8")).devices.length, 2);
    const list = (await call(server, second, "GET", "/admin/api/devices")).json;
    assert.deepEqual(list.devices.map((entry) => entry.label).sort(), ["Chrome · Windows", "Firefox · Linux"]);
    for (const entry of list.devices) assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "id", "label", "lastUsedAt"], "the list has no hash and no token");
    assert.equal(JSON.stringify(list).includes(device.token) || JSON.stringify(list).includes(sha256(device.token)), false);
  });
});

test("P13 devices: a silent sign-in with the token opens a session, is not told the token again, and moves the time it was last used", async () => {
  await withClock(async (advance) => {
    await withServer(async (server) => {
      const code = await adminCode(server);
      const { json: { device } } = await login(server, { code, remember: true }, { "user-agent": FIREFOX_LINUX });
      advance(3 * 60 * 60_000);
      const silent = await login(server, { deviceToken: device.token });
      assert.equal(silent.status, 200);
      assert.deepEqual(Object.keys(silent.json), ["csrf"], "the session's token, and not the device token");
      assert.ok(silent.cookie?.startsWith("nrs_admin_"));
      assert.match(silent.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/admin\/; Max-Age=1800/);
      assert.equal((await call(server, silent, "GET", "/admin/api/status")).status, 200, "it is a session like any other");
      assert.equal((await call(server, silent, "POST", "/admin/api/pairing", {})).status, 200, "with its token for changes");
      const [listed] = (await call(server, silent, "GET", "/admin/api/devices")).json.devices;
      assert.equal(Date.parse(listed.lastUsedAt) - Date.parse(listed.createdAt) >= 3 * 60 * 60_000 - 1000, true, `last used ${listed.lastUsedAt}, made ${listed.createdAt}`);
      const stored = JSON.parse(await readFile(devicesFile(server), "utf8")).devices[0];
      assert.equal(stored.lastUsedAt, listed.lastUsedAt, "it is on disk too");
    });
  });
});

test("P13 devices: a wrong token is refused in the very words of a wrong code, and sets nothing", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    const wrongCode = await login(server, { code: "x".repeat(40) });
    assert.deepEqual([wrongCode.status, wrongCode.json], [401, { code: "admin_login", message: "Wrong admin code." }]);
    const wrongTokens = [WRONG_TOKEN, "", "nrd_", `${device.token}x`, device.token.slice(0, -1), device.token.toUpperCase(), "a".repeat(200), " ", "../../etc/passwd"];
    for (const wrong of wrongTokens) {
      const answer = await login(server, { deviceToken: wrong });
      assert.equal(answer.status, wrongCode.status, JSON.stringify(wrong));
      assert.equal(answer.text, wrongCode.text, `the same body for ${JSON.stringify(wrong).slice(0, 30)}`);
      assert.equal(answer.headers.get("set-cookie"), null, "no session");
      assert.deepEqual([...answer.headers.keys()].filter((name) => !["date", "connection", "keep-alive"].includes(name)).sort(), [...wrongCode.headers.keys()].filter((name) => !["date", "connection", "keep-alive"].includes(name)).sort(), "and the same headers");
    }
  });
  // The budget of ten is spent above: what is not a token at all is tried on a server of its own.
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    const wrongCode = await login(server, { code: "x".repeat(40) });
    for (const odd of [5, null, true, {}, [device.token]]) {
      const answer = await login(server, { deviceToken: odd });
      assert.equal(answer.text, wrongCode.text, `a token that is ${JSON.stringify(odd)} is a wrong one`);
    }
    assert.equal((await login(server, { code: undefined })).text, wrongCode.text, "and nothing at all");
  });
});

test("P13 devices: a wrong token spends the same budget as a wrong code, from the same source: the tenth is the last, and a right one clears the count", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await login(server, { deviceToken: WRONG_TOKEN })).status, 401, `wrong token ${attempt + 1}`);
    const locked = await login(server, { deviceToken: device.token });
    assert.deepEqual([locked.status, locked.json.code], [429, "too_many_attempts"], "even the right token waits: the budget cannot be used to guess");
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    const lockedCode = await login(server, { code });
    assert.deepEqual([lockedCode.status, lockedCode.json.code], [429, "too_many_attempts"], "and the right code too: one budget for both");
  });
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login(server, { code: "y".repeat(40) })).status, 401);
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login(server, { deviceToken: WRONG_TOKEN })).status, 401);
    assert.equal((await login(server, { deviceToken: device.token })).status, 429, "five wrong codes and five wrong tokens are ten");
  });
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    for (let round = 0; round < 3; round += 1) {
      for (let attempt = 0; attempt < 9; attempt += 1) assert.equal((await login(server, { deviceToken: WRONG_TOKEN })).status, 401);
      assert.equal((await login(server, { deviceToken: device.token })).status, 200, `round ${round}: nine wrong, then the right one`);
    }
    assert.equal((await login(server, { code })).status, 200, "a right token cleared the count for the code too");
  });
});

test("P13 devices: both a code and a token in one request is a code sign-in, and asking to remember with a token makes nothing new", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    const both = await login(server, { code: "z".repeat(40), deviceToken: device.token });
    assert.equal(both.status, 401, "the code is what is checked when there is one: a token does not rescue a wrong code");
    const again = await login(server, { deviceToken: device.token, remember: true });
    assert.equal(again.status, 200);
    assert.deepEqual(Object.keys(again.json), ["csrf"], "no second device from a device");
    assert.equal(JSON.parse(await readFile(devicesFile(server), "utf8")).devices.length, 1);
  });
});

test("P13 devices: revoking one device ends its token and the sessions that it opened, and no other; revoking all ends every one", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const first = await login(server, { code, remember: true }, { "user-agent": CHROME_WINDOWS });
    const second = await login(server, { code, remember: true }, { "user-agent": FIREFOX_LINUX });
    const third = await login(server, { code, remember: true }, { "user-agent": SAFARI_IPHONE });
    const owner = await login(server, { code });
    const opened = await login(server, { deviceToken: first.json.device.token });
    assert.equal((await call(server, opened, "GET", "/admin/api/status")).status, 200);

    assert.deepEqual((await call(server, owner, "POST", "/admin/api/devices/revoke", { id: first.json.device.id })).json, { revoked: true });
    assert.equal((await login(server, { deviceToken: first.json.device.token })).status, 401, "its token is dead");
    assert.equal((await call(server, opened, "GET", "/admin/api/status")).status, 401, "the session that it opened with the token is closed");
    assert.equal((await call(server, first, "GET", "/admin/api/status")).status, 401, "and the one that made it");
    assert.equal((await login(server, { deviceToken: second.json.device.token })).status, 200, "another device is untouched");
    assert.equal((await call(server, owner, "GET", "/admin/api/status")).status, 200, "and so is a session that no device opened");
    assert.deepEqual((await call(server, owner, "POST", "/admin/api/devices/revoke", { id: first.json.device.id })).json, { revoked: false }, "twice is not an error");
    assert.deepEqual((await call(server, owner, "POST", "/admin/api/devices/revoke", { id: "no-such-device" })).json, { revoked: false });
    assert.equal((await call(server, owner, "POST", "/admin/api/devices/revoke", {})).status, 400, "which device?");
    assert.equal(JSON.parse(await readFile(devicesFile(server), "utf8")).devices.length, 2);

    const sessionOfSecond = await login(server, { deviceToken: second.json.device.token });
    assert.deepEqual((await call(server, owner, "POST", "/admin/api/devices/revoke-all", {})).json, { revoked: 2 });
    for (const device of [second.json.device, third.json.device]) assert.equal((await login(server, { deviceToken: device.token })).status, 401);
    assert.equal((await call(server, sessionOfSecond, "GET", "/admin/api/status")).status, 401);
    assert.equal((await call(server, owner, "GET", "/admin/api/status")).status, 200, "the owner who is looking is not signed out");
    assert.deepEqual((await call(server, owner, "GET", "/admin/api/devices")).json, { devices: [] });
    assert.deepEqual((await call(server, owner, "POST", "/admin/api/devices/revoke-all", {})).json, { revoked: 0 });
  });
});

test("P13 devices: changing the admin code, by rotating it or by setting it, revokes every remembered device", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const one = (await login(server, { code, remember: true })).json.device;
    const two = (await login(server, { code, remember: true })).json.device;
    const owner = await login(server, { code });
    const rotated = await call(server, owner, "POST", "/admin/api/admin-code/rotate", {});
    assert.equal(rotated.status, 200);
    for (const device of [one, two]) assert.equal((await login(server, { deviceToken: device.token })).status, 401, "a remembered browser does not outlive the code it was let in with");
    assert.deepEqual(JSON.parse(await readFile(devicesFile(server), "utf8")).devices, [], "and nothing of them is kept");

    const fresh = await login(server, { code: rotated.json.code, remember: true });
    assert.equal(fresh.status, 200, "the new code works, and can remember again");
    const typed = `${"s".repeat(40)}-typed-code`;
    assert.equal((await call(server, fresh, "POST", "/admin/api/admin-code/set", { code: typed })).status, 200);
    assert.equal((await login(server, { deviceToken: fresh.json.device.token })).status, 401, "setting the code revokes them too");
    const again = await login(server, { code: typed });
    assert.deepEqual((await call(server, again, "GET", "/admin/api/devices")).json, { devices: [] });
  });
});

test("P13 devices: a code that is edited in its file while the server is down revokes the remembered devices when it starts again", async () => {
  await withAuth(async ({ open, codeFile }) => {
    let auth = await open();
    const code = (await readFile(codeFile, "utf8")).trim();
    const session = await auth.login(code);
    const device = await auth.rememberDevice(session.cookie, "Test · Linux");
    assert.equal((await auth.loginWithDevice(device.token)).csrf.length > 10, true);
    auth = await open();
    assert.equal((await auth.loginWithDevice(device.token)).csrf.length > 10, true, "reopened with the same code: still remembered");
    await writeFile(codeFile, `${"n".repeat(40)}\n`, { mode: 0o600 });
    auth = await open();
    await assert.rejects(() => auth.loginWithDevice(device.token), { code: "admin_login" });
    assert.deepEqual(auth.listDevices(), []);
  });
});

test("P13 devices: signing out with the device's id forgets it on the server, and signing out without one touches no device", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const mine = (await login(server, { code, remember: true })).json.device;
    const other = (await login(server, { code, remember: true })).json.device;
    const session = await login(server, { deviceToken: mine.token });
    const out = await call(server, session, "POST", "/admin/api/logout", { deviceId: mine.id });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await login(server, { deviceToken: mine.token })).status, 401, "this device is not remembered any more");
    const second = await login(server, { deviceToken: other.token });
    assert.equal(second.status, 200, "another one is");
    assert.equal((await call(server, second, "POST", "/admin/api/logout", {})).status, 200);
    assert.equal((await login(server, { deviceToken: other.token })).status, 200, "a plain sign-out keeps every device");
  });
});

test("P13 devices: twenty devices at most; the next sign-in works, says that it could not remember, and makes nothing", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    for (let index = 0; index < 20; index += 1) assert.equal((await login(server, { code, remember: true })).json.device.token.startsWith("nrd_"), true, `device ${index + 1}`);
    const over = await login(server, { code, remember: true });
    assert.equal(over.status, 200, "the sign-in itself works");
    assert.deepEqual(Object.keys(over.json).sort(), ["csrf", "deviceLimit"]);
    assert.equal(over.json.deviceLimit, true);
    assert.equal(JSON.parse(await readFile(devicesFile(server), "utf8")).devices.length, 20);
    assert.equal((await call(server, over, "GET", "/admin/api/status")).status, 200);
    const [oldest] = (await call(server, over, "GET", "/admin/api/devices")).json.devices;
    assert.deepEqual((await call(server, over, "POST", "/admin/api/devices/revoke", { id: oldest.id })).json, { revoked: true });
    assert.equal((await login(server, { code, remember: true })).json.device.token.startsWith("nrd_"), true, "room again");
  });
});

test("P13 devices: the routes need the admin session and its token, and answer only to the panel's own origin; a client token opens none of them", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const owner = await login(server, { code, remember: true });
    const origin = server.adminUrl;
    for (const [method, route] of [["GET", "/admin/api/devices"], ["POST", "/admin/api/devices/revoke"], ["POST", "/admin/api/devices/revoke-all"], ["GET", "/admin/api/session"]]) {
      const bare = await fetch(`${origin}${route}`, { method, headers: { origin, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(bare.status, 401, `${method} ${route} without a session`);
      const foreign = await fetch(`${origin}${route}`, { method, headers: { origin: "https://evil.example", cookie: owner.cookie, "x-csrf-token": owner.csrf, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(foreign.status, 403, `${method} ${route} from another origin`);
      const bearer = await fetch(`${origin}${route}`, { method, headers: { origin, authorization: `Bearer ${(await server.auth.issue("c", ["read", "write", "run", "update"])).token}`, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(bearer.status, 401, `${method} ${route} with a client token`);
    }
    for (const route of ["/admin/api/devices/revoke", "/admin/api/devices/revoke-all"]) {
      const noToken = await fetch(`${origin}${route}`, { method: "POST", headers: { origin, cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ id: owner.json.device.id }) });
      assert.equal(noToken.status, 403, `${route} without the session's token for changes`);
    }
    assert.equal(JSON.parse(await readFile(devicesFile(server), "utf8")).devices.length, 1, "and nothing was revoked");
    assert.equal((await fetch(`${server.url}/api/v1/devices`, { headers: { authorization: `Bearer ${(await server.auth.issue("c2", ["read"])).token}` } })).status, 404, "the clients' API knows no such route");
  });
});

test("P13 devices: a session that has the cookie can ask for its token for changes, which lets a second tab join without signing in again; nobody else can", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const owner = await login(server, { code });
    const origin = server.adminUrl;
    const none = await fetch(`${origin}/admin/api/session`, { headers: { origin } });
    assert.equal(none.status, 401);
    const asked = await fetch(`${origin}/admin/api/session`, { headers: { origin, cookie: owner.cookie } });
    assert.equal(asked.status, 200);
    assert.deepEqual(await asked.json(), { csrf: owner.csrf });
    assert.equal((await call(server, { cookie: owner.cookie, csrf: (await (await fetch(`${origin}/admin/api/session`, { headers: { origin, cookie: owner.cookie } })).json()).csrf }, "POST", "/admin/api/pairing", {})).status, 200, "and it is the one that works");
    const wrongCookie = await fetch(`${origin}/admin/api/session`, { headers: { origin, cookie: "nrs_admin_1=nope" } });
    assert.equal(wrongCookie.status, 401);
  });
});

test("P13 devices: the log says how each sign-in came (the code or a device), the devices that were remembered and revoked, and never a token", async () => {
  const lines = [];
  await withServer(async (server) => {
    const code = await adminCode(server);
    const remembered = await login(server, { code, remember: true }, { "user-agent": CHROME_WINDOWS });
    const { device } = remembered.json;
    for (let attempt = 0; attempt < 3; attempt += 1) await login(server, { deviceToken: WRONG_TOKEN });
    const silent = await login(server, { deviceToken: device.token });
    const owner = await login(server, { code });
    const revoked = await call(server, owner, "POST", "/admin/api/devices/revoke", { id: device.id });
    assert.equal(revoked.status, 200);
    const entries = (await call(server, owner, "GET", "/admin/api/log?limit=100")).json.entries;
    const of = (action, extra = () => true) => entries.filter((entry) => entry.action === action && extra(entry));
    const codeLogin = of("admin.login", (entry) => entry.ok && entry.detail === "code");
    const deviceLogin = of("admin.login", (entry) => entry.ok && entry.detail === "device");
    const refused = of("admin.login", (entry) => !entry.ok && entry.detail === "device");
    assert.ok(codeLogin.length >= 1 && deviceLogin.length === 1, JSON.stringify(entries.map((entry) => [entry.action, entry.ok, entry.detail])));
    assert.deepEqual([refused.length, refused[0].count, refused[0].code, refused[0].actor.kind], [1, 3, "admin_login", "anonymous"], "three wrong tokens are one line, with the way they came");
    const remember = of("admin.device.remember");
    assert.deepEqual([remember.length, remember[0].actor.kind, remember[0].object, remember[0].label, remember[0].type], [1, "admin", device.id, "Chrome · Windows", "access"]);
    const revoke = of("admin.device.revoke");
    assert.deepEqual([revoke.length, revoke[0].actor.kind, revoke[0].object, revoke[0].label, revoke[0].ok], [1, "admin", device.id, "Chrome · Windows", true]);
    const file = await readFile(path.join(server.data.root, "admin-log.jsonl"), "utf8");
    for (const secret of [device.token, WRONG_TOKEN, sha256(device.token), code]) assert.equal(file.includes(secret), false, `not in the log: ${secret.slice(0, 12)}…`);
    assert.ok(silent.status === 200);

    await call(server, owner, "POST", "/admin/api/devices/revoke-all", {});
    const again = (await login(server, { code, remember: true })).json.device;
    const ownerTwo = await login(server, { code });
    await call(server, ownerTwo, "POST", "/admin/api/admin-code/rotate", {});
    const after = (await login(server, { code: await adminCode(server) }));
    const revokedByCode = (await call(server, after, "GET", "/admin/api/log?limit=100")).json.entries.filter((entry) => entry.action === "admin.device.revoke" && entry.detail === "code-changed");
    assert.deepEqual([revokedByCode.length, revokedByCode[0].object], [1, "1"], "a changed code that revoked a device says how many");
    assert.equal(file.includes(again.token), false);
  }, { log: (line) => lines.push(String(line)) });
  assert.equal(lines.some((line) => /nrd_[A-Za-z0-9_-]{43}/.test(line)), false, "and none in the server's own log");
});

test("P13 devices: the token is in no answer but the sign-in that made it: not the status, the list, the log, the risks, the health or the history", async () => {
  await withServer(async (server, client) => {
    const code = await adminCode(server);
    const remembered = await login(server, { code, remember: true }, { "user-agent": CHROME_WINDOWS });
    const { device } = remembered.json;
    const silent = await login(server, { deviceToken: device.token });
    const seen = [];
    for (const route of ["/admin/api/status", "/admin/api/devices", "/admin/api/log?limit=200", "/admin/api/risks", "/admin/api/health", "/admin/api/runs", "/admin/api/updates", "/admin/api/updates/history", "/admin/api/mcp", "/admin/api/session"]) {
      const answer = await call(server, silent, "GET", route);
      seen.push([route, answer.text]);
    }
    seen.push(["logout", (await call(server, silent, "POST", "/admin/api/logout", {})).text]);
    for (const [route, text] of seen) {
      assert.equal(text.includes(device.token), false, `${route} holds the token`);
      assert.equal(text.includes(sha256(device.token)), false, `${route} holds its hash`);
    }
    assert.equal(JSON.stringify(remembered.json).includes(device.token), true, "the sign-in that made it said it once");
    assert.ok(client);
  });
});

test("P13 devices: silent sign-ins that arrive together are all let in, and the file stays one valid record", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const { json: { device } } = await login(server, { code, remember: true });
    const answers = await Promise.all(Array.from({ length: 6 }, () => login(server, { deviceToken: device.token })));
    assert.deepEqual(answers.map((answer) => answer.status), Array(6).fill(200));
    assert.equal(new Set(answers.map((answer) => answer.cookie)).size, 6, "a session for each");
    const file = JSON.parse(await readFile(devicesFile(server), "utf8"));
    assert.equal(file.devices.length, 1);
    assert.equal(file.devices[0].hash, sha256(device.token));
  });
});

test("P13 devices: a devices file that cannot be read never stops the server: the devices are forgotten, the file is kept aside, and the owner is told", async () => {
  await withAuth(async ({ root, open }) => {
    let auth = await open();
    const code = (await readFile(path.join(root, "private", "admin-code.txt"), "utf8")).trim();
    const device = await auth.rememberDevice((await auth.login(code)).cookie, "Test · Linux");
    await writeFile(path.join(root, "private", "admin-devices.json"), "{ this is not json", { mode: 0o600 });
    auth = await open();
    assert.match(auth.devicesWarning ?? "", /admin-devices\.json/);
    await assert.rejects(() => auth.loginWithDevice(device.token), { code: "admin_login" });
    assert.deepEqual(auth.listDevices(), []);
    assert.ok((await readFile(path.join(root, "private", "admin-devices.json.damaged"), "utf8")).includes("this is not json"), "kept for the owner");
    assert.equal((await auth.rememberDevice((await auth.login(code)).cookie, "Again · Linux")).token.startsWith("nrd_"), true, "and it can remember again");
    // A record that is not one is a damaged file too, not a device.
    await writeFile(path.join(root, "private", "admin-devices.json"), JSON.stringify({ version: 1, devices: [{ id: "x", hash: "short", label: 5 }] }), { mode: 0o600 });
    auth = await open();
    assert.deepEqual(auth.listDevices(), []);
    assert.match(auth.devicesWarning ?? "", /admin-devices\.json/);
  });
});

test("P13 devices: the risks name a remembered device, say how many, and speak up when the panel is on the internet", async () => {
  await withServer(async (server) => {
    const code = await adminCode(server);
    const owner = await login(server, { code });
    const ids = async () => (await call(server, owner, "GET", "/admin/api/risks")).json.risks.map((risk) => risk.id);
    assert.equal((await ids()).includes("device-remember"), false, "no device, no note");
    const one = (await login(server, { code, remember: true })).json.device;
    let risks = (await call(server, owner, "GET", "/admin/api/risks")).json.risks;
    assert.deepEqual(risks.find((risk) => risk.id === "device-remember"), { id: "device-remember", level: "note", facts: { count: 1, remote: false } });
    await login(server, { code, remember: true });
    await call(server, owner, "POST", "/admin/api/network", { allowedAiBases: [], origins: [], publicUrl: "", adminPublicUrl: "https://admin.example.test", allowRemoteAdmin: true });
    risks = (await call(server, owner, "GET", "/admin/api/risks")).json.risks;
    assert.deepEqual(risks.find((risk) => risk.id === "device-remember").facts, { count: 2, remote: true }, "the same note, with the fact that makes it matter more");
    await call(server, owner, "POST", "/admin/api/devices/revoke", { id: one.id });
    assert.equal((await call(server, owner, "GET", "/admin/api/risks")).json.risks.find((risk) => risk.id === "device-remember").facts.count, 1);
    await call(server, owner, "POST", "/admin/api/devices/revoke-all", {});
    assert.equal((await ids()).includes("device-remember"), false, "and it goes with the last one");
  });
});

test("P13 devices: the pure risk list knows the note, and leaves it out for no devices or odd facts", () => {
  const { buildRisks } = testing;
  const base = { remoteAdmin: { on: false }, clients: [], apps: [], mcp: {}, aiBases: [], spend: {}, aiConfigured: false };
  assert.deepEqual(buildRisks({ ...base, devices: { count: 3 } }).risks, [{ id: "device-remember", level: "note", facts: { count: 3, remote: false } }]);
  assert.deepEqual(buildRisks({ ...base, devices: { count: 3 }, remoteAdmin: { on: true, address: "https://admin.example.test" } }).risks.map((risk) => [risk.id, risk.facts.remote]), [["remote-admin", undefined], ["device-remember", true]]);
  assert.deepEqual(buildRisks({ ...base, devices: { count: 0 } }).risks, []);
  for (const odd of [undefined, null, {}, { count: -1 }, { count: "many" }, { count: 1.5 }, 5]) assert.deepEqual(buildRisks({ ...base, devices: odd }).risks, [], JSON.stringify(odd));
  assert.deepEqual(buildRisks({ ...base, devices: { count: 1 } }).counts, { high: 0, medium: 0, note: 1 });
});
