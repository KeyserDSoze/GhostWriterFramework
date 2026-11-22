import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedBookFiles } from "narrarium-engine/testing";
// New exports are read through the namespace, so a missing one fails the test that needs it and nothing else.
import * as testing from "../dist/testing.mjs";
import { Auth, SERVER_VERSION, Vault, atomicJson, requestLocalClientToken, startNarrariumServer } from "../dist/testing.mjs";
import { adminLogin, noRelease, releaseAvailable, until, withServer } from "./helpers.mjs";

const ALL_SCOPES = ["read", "write", "run", "update"];
const JSON_HEADERS = { "content-type": "application/json" };
const ATTACKER = "203.0.113.9";
const OWNER = "198.51.100.4";
const BYSTANDER = "192.0.2.77";
const WRONG_CODE = "x".repeat(43);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The header Cloudflare writes. Without an address the request is the local one. */
const via = (ip) => (ip ? { "cf-connecting-ip": ip } : {});
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const noTunnel = { findBinary: () => undefined, detectOtherConnectors: async () => [] };

/** One request with full control of the headers. Resolves with the status, the headers and the parsed body. */
function send(url, { method = "GET", headers = {}, body, agent = false, timeoutMs = 20_000 } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers, agent, timeout: timeoutMs }, (response) => {
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
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    if (body !== undefined) request.write(typeof body === "string" ? body : JSON.stringify(body));
    request.end();
  });
}

/** The server as it is reached through its Cloudflare tunnel: a public address is configured, so cf-connecting-ip is believed. */
async function behindTunnel(server) {
  await server.data.updateConfig((config) => {
    config.publicUrl = "https://books.example.com";
    config.adminPublicUrl = "https://admin.example.com";
    config.allowRemoteAdmin = true;
  });
}

const adminCode = async (server) => (await readFile(path.join(server.data.root, "private", "admin-code.txt"), "utf8")).trim();
const login = (server, code, ip) => send(`${server.adminUrl}/admin/api/login`, { method: "POST", headers: { origin: server.adminUrl, ...JSON_HEADERS, ...via(ip) }, body: { code } });
const requestPairing = (server, code, ip, nonce = "a".repeat(64)) => send(`${server.url}/api/v1/pairings`, { method: "POST", headers: { ...JSON_HEADERS, ...via(ip) }, body: { code, nonce, label: "A device" } });
const pairingResult = (server, id, nonce, ip) => send(`${server.url}/api/v1/pairings/${id}/result`, { method: "POST", headers: { ...JSON_HEADERS, ...via(ip) }, body: { nonce } });
const info = (server, ip, agent) => send(`${server.url}/api/v1/info`, { headers: via(ip), agent });
const wrongCodeFor = (code) => (code === "123456789" ? "987654321" : "123456789");

/** A socket that sends `head` (headers and the start of a body) and then stops, optionally dripping one byte now and then. */
function openStalled(port, head, dripMs) {
  const socket = net.connect(port, "127.0.0.1");
  let text = "";
  let closed = false;
  socket.on("data", (chunk) => {
    text += chunk;
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    closed = true;
  });
  socket.write(head);
  const timer = dripMs ? setInterval(() => !socket.destroyed && socket.write(" "), dripMs) : undefined;
  return {
    get text() {
      return text;
    },
    get closed() {
      return closed;
    },
    destroy() {
      clearInterval(timer);
      socket.destroy();
    },
  };
}

const requestHead = (lines) => `${[...lines, "", ""].join("\r\n")}`;

// ---------------------------------------------------------------------------------------------
// C6: every limit is counted per source; an anonymous caller cannot lock the owner out
// ---------------------------------------------------------------------------------------------

test("C6: an anonymous source that guesses admin codes is stopped by its own budget and never locks the owner out", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const code = await adminCode(server);
    const attempts = [];
    for (let index = 0; index < 12; index += 1) attempts.push(await login(server, WRONG_CODE, ATTACKER));
    assert.deepEqual(attempts.map((attempt) => attempt.status), [...Array(10).fill(401), 429, 429], "ten wrong codes per source, then 429 instead of 401");
    assert.equal(attempts[0].json.code, "admin_login");
    assert.equal(attempts[10].json.code, "too_many_attempts");
    const wait = Number(attempts[10].headers["retry-after"]);
    assert.ok(Number.isInteger(wait) && wait > 0 && wait <= 300, `Retry-After: ${attempts[10].headers["retry-after"]}`);
    assert.equal((await login(server, code, ATTACKER)).status, 429, "a blocked source is refused even with the right code");
    assert.equal((await login(server, code, OWNER)).status, 200, "the owner, from another address");
    assert.equal((await login(server, code, BYSTANDER)).status, 200, "anybody else");
    assert.equal((await login(server, code)).status, 200, "the owner on this computer (the local source)");
  });
});

/** A `cloudflared` that starts and stays up: enough for the server to consider its own connector enabled. */
function stayingConnector() {
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.pid = 51_000;
    child.exitCode = null;
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.finish = (code, signal = null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code ?? 0;
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
    };
    child.kill = (signal) => {
      setImmediate(() => child.finish(null, signal));
      return true;
    };
    if (args[0] === "--version") {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("cloudflared version 2025.6.1 (built 2025-06-01-1200 UTC)\n"));
        child.finish(0);
      });
    }
    return child;
  };
  return { findBinary: () => "/opt/cloudflared/bin/cloudflared", spawn, detectOtherConnectors: async () => [] };
}

test("C6: with the server's own connector enabled, the tunnel header is believed even before a public address is set", async () => {
  // Cloudflare may be told to rewrite the Host header to the local one: then no public address is needed to reach the server.
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const configured = await admin.call("POST", "/admin/api/tunnel/configure", { token: "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=" });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(server.data.config.publicUrl, undefined, "no public address is configured");
    const statuses = [];
    for (let index = 0; index < 12; index += 1) statuses.push((await requestPairing(server, "123456789", ATTACKER)).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
    assert.equal((await login(server, await adminCode(server))).status, 200, "the owner on this computer is not charged for the attacker's attempts");
    assert.equal((await requestPairing(server, "123456789", OWNER)).status, 401, "another address has its own budget (the code is simply wrong)");
  }, { tunnel: stayingConnector() });
});

test("C6: 22 anonymous pairing requests no longer lock the owner out of the admin panel or out of pairing", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const statuses = [];
    for (let index = 0; index < 22; index += 1) statuses.push((await requestPairing(server, "123456789", ATTACKER)).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), ...Array(12).fill(429)], "ten attempts per source in five minutes, whether or not a pairing is open");
    assert.equal((await login(server, await adminCode(server), OWNER)).status, 200, "the owner's admin login");

    const { code } = await server.auth.startPairing();
    const nonce = "b".repeat(64);
    const owner = await requestPairing(server, code, OWNER, nonce);
    assert.equal(owner.status, 200, "the owner's pairing with the right code");
    await server.auth.approvePairing(owner.json.id);
    const result = await pairingResult(server, owner.json.id, nonce, OWNER);
    assert.equal(result.status, 200);
    assert.match(result.json.token, /^nrs_/);
    assert.equal((await send(`${server.url}/api/v1/session`, { headers: bearer(result.json.token) })).status, 200, "and the token works");

    // The same from this computer (the local source), while the attacker is still blocked.
    const again = await server.auth.startPairing();
    const localNonce = "f".repeat(64);
    const local = await requestPairing(server, again.code, undefined, localNonce);
    assert.equal(local.status, 200, "the owner's pairing from the local source");
    await server.auth.approvePairing(local.json.id);
    assert.match((await pairingResult(server, local.json.id, localNonce)).json.token, /^nrs_/);
    assert.equal((await requestPairing(server, "123456789", ATTACKER)).status, 429, "and the attacker is still refused");
  });
});

test("C6: the CLI helper says so when its sign-in is paused, instead of blaming a server that is not running", async () => {
  await withServer(async (server) => {
    const options = { dataRoot: server.data.root, adminPort: server.adminPort, label: "Terminal", scopes: ["read"] };
    assert.ok((await requestLocalClientToken(options)).token, "works while the local budget is untouched");
    for (let index = 0; index < 10; index += 1) assert.equal((await login(server, WRONG_CODE)).status, 401);
    await assert.rejects(() => requestLocalClientToken(options), /too many wrong codes/i);
  });
});

test("C6: successful sign-ins are not counted: twenty-five in a row from one source", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const code = await adminCode(server);
    for (let index = 0; index < 25; index += 1) assert.equal((await login(server, code, OWNER)).status, 200, `sign-in ${index + 1}`);
    for (let index = 0; index < 25; index += 1) assert.equal((await login(server, code)).status, 200, `local sign-in ${index + 1}`);
  });
});

test("C6: a successful sign-in resets the failures of that source", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const code = await adminCode(server);
    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 9; index += 1) assert.equal((await login(server, WRONG_CODE, OWNER)).status, 401, `round ${round}, wrong code ${index + 1}`);
      assert.equal((await login(server, code, OWNER)).status, 200, `round ${round}: the right code still works after nine mistakes`);
    }
    // A reset is per source: the attacker's failures do not come back because the owner signed in.
    for (let index = 0; index < 10; index += 1) await login(server, WRONG_CODE, ATTACKER);
    await login(server, code, OWNER);
    assert.equal((await login(server, WRONG_CODE, ATTACKER)).status, 429);
  });
});

test("C6: without a public address the Cloudflare header is ignored: spoofed addresses share the one local budget", async () => {
  await withServer(async (server) => {
    const statuses = [];
    for (let index = 0; index < 12; index += 1) statuses.push((await login(server, WRONG_CODE, `203.0.113.${index + 1}`)).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429], "twelve different claimed addresses are still one source");
    const code = await adminCode(server);
    assert.equal((await login(server, code, BYSTANDER)).status, 429, "no public address: the header proves nothing, so this is the same blocked source");
  });
});

test("C6: inside a pairing a source gets five wrong guesses, and a source that used them does not burn the pairing for anybody else", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const { code } = await server.auth.startPairing();
    const wrong = wrongCodeFor(code);
    for (let index = 0; index < 5; index += 1) assert.equal((await requestPairing(server, wrong, ATTACKER)).status, 401);
    assert.equal((await requestPairing(server, code, ATTACKER)).status, 401, "this source used its five guesses: even the right code is refused");
    assert.ok(server.auth.list().pairing, "the pairing is still open");
    const owner = await requestPairing(server, code, OWNER, "c".repeat(64));
    assert.equal(owner.status, 200, "the owner's right code works");
    assert.equal(server.auth.list().pairing.requested, true);
  });
});

test("C6: fifty wrong guesses from many sources cancel the pairing", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const { code } = await server.auth.startPairing();
    const wrong = wrongCodeFor(code);
    for (let source = 0; source < 10; source += 1) {
      for (let guess = 0; guess < 5; guess += 1) assert.equal((await requestPairing(server, wrong, `203.0.113.${100 + source}`)).status, 401, `source ${source}, guess ${guess}`);
    }
    assert.equal(server.auth.list().pairing, null, "the pairing was cancelled by the ceiling");
    assert.equal((await requestPairing(server, code, OWNER)).status, 401, "the code no longer works");
    const fresh = await server.auth.startPairing();
    assert.equal((await requestPairing(server, fresh.code, OWNER, "d".repeat(64))).status, 200, "the owner starts again and pairs");
  });
});

test("C6: attempts while no pairing is open spend only the caller's own budget and write nothing", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const file = path.join(server.data.root, "private", "authorization.json");
    const before = await readFile(file, "utf8");
    for (let index = 0; index < 8; index += 1) assert.equal((await requestPairing(server, "123456789", ATTACKER)).status, 401);
    assert.equal(await readFile(file, "utf8"), before, "anonymous noise is not written to disk");
    const { code } = await server.auth.startPairing();
    assert.equal(JSON.parse(await readFile(file, "utf8")).pairing.attempts, 0, "the pairing starts with a clean count");
    assert.equal((await requestPairing(server, code, OWNER, "e".repeat(64))).status, 200);
  });
});

test("C6: GET /info is limited per source: 120 a minute, so one source cannot starve the web app's identity check", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  try {
    await withServer(async (server) => {
      await behindTunnel(server);
      const statuses = [];
      for (let index = 0; index < 125; index += 1) statuses.push((await info(server, ATTACKER, agent)).status);
      assert.equal(statuses.filter((status) => status === 200).length, 120);
      assert.ok(statuses.slice(120).every((status) => status === 429), "everything after the 120th is refused");
      const refused = await info(server, ATTACKER, agent);
      assert.equal(refused.json.code, "rate_limit");
      assert.ok(Number(refused.headers["retry-after"]) >= 1);
      assert.equal((await info(server, OWNER, agent)).status, 200, "another source");
      assert.equal((await info(server, undefined, agent)).status, 200, "the local source");
    });
  } finally {
    agent.destroy();
  }
});

test("C6: failed authentications are limited per source (60 a minute); a valid token is never throttled by them", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  try {
    await withServer(async (server) => {
      await behindTunnel(server);
      const good = (await server.auth.issue("device", ["read"])).token;
      const call = (token, ip) => send(`${server.url}/api/v1/session`, { headers: { ...bearer(token), ...via(ip) }, agent });
      const statuses = [];
      for (let index = 0; index < 65; index += 1) statuses.push((await call(`nrs_${"z".repeat(43)}`, ATTACKER)).status);
      assert.equal(statuses.filter((status) => status === 401).length, 60);
      assert.ok(statuses.slice(60).every((status) => status === 429), "after sixty failures the source gets 429");
      const refused = await call(`nrs_${"z".repeat(43)}`, ATTACKER);
      assert.equal(refused.json.code, "rate_limit");
      assert.ok(Number(refused.headers["retry-after"]) >= 1);
      assert.equal((await call(good, ATTACKER)).status, 200, "the same source with a valid token is served");
      assert.equal((await call(`nrs_${"y".repeat(43)}`, OWNER)).status, 401, "another source has its own budget");
    });
  } finally {
    agent.destroy();
  }
});

test("C6: the authenticated budget is 6000 a minute per client, not one budget for everybody", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });
  try {
    await withServer(async (server) => {
      const first = (await server.auth.issue("device one", ["read"])).token;
      const second = (await server.auth.issue("device two", ["read"])).token;
      const call = (token) => send(`${server.url}/api/v1/session`, { headers: bearer(token), agent });
      let rejected = 0;
      for (let batch = 0; batch < 120; batch += 1) {
        const results = await Promise.all(Array.from({ length: 50 }, () => call(first)));
        rejected += results.filter((result) => result.status !== 200).length;
      }
      assert.equal(rejected, 0, "six thousand requests in a few seconds: the web app syncing a big book");
      const refused = await call(first);
      assert.equal(refused.status, 429);
      assert.equal(refused.json.code, "rate_limit");
      assert.ok(Number(refused.headers["retry-after"]) >= 1);
      assert.equal((await call(second)).status, 200, "another client is not affected");
    });
  } finally {
    agent.destroy();
  }
});

test("C6: authorization.json keeps no attempt counters, and a file written by the previous version is still read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-auth-"));
  try {
    const vault = await Vault.open(root);
    const auth = await Auth.open(root, vault);
    const file = path.join(root, "private", "authorization.json");
    const code = (await readFile(path.join(root, "private", "admin-code.txt"), "utf8")).trim();
    const fresh = JSON.parse(await readFile(file, "utf8"));
    assert.equal("failures" in fresh, false);
    assert.equal("failureWindow" in fresh, false);
    for (let index = 0; index < 15; index += 1) await assert.rejects(() => auth.login(WRONG_CODE));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), fresh, "failed attempts are not persisted");

    // The previous version stored its shared budget: with the budget used up it must not lock anybody out now.
    await writeFile(file, JSON.stringify({ ...fresh, failures: 99, failureWindow: Date.now() }, null, 2));
    const legacy = await Auth.open(root, vault);
    assert.ok((await legacy.login(code)).csrf, "the old counters are ignored");
    await legacy.issue("forces a write", ["read"]);
    const rewritten = JSON.parse(await readFile(file, "utf8"));
    assert.equal("failures" in rewritten, false);
    assert.equal("failureWindow" in rewritten, false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------------------------
// C7: the admin gateway does not leak live streams
// ---------------------------------------------------------------------------------------------

/** Open a live stream; resolves with the status (200 once the first event has arrived) and the request, to close it. */
function openStream({ port, token, host, ip }) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/api/v1/events", agent: false, headers: { ...(host ? { host } : {}), ...bearer(token), accept: "text/event-stream", ...via(ip) } }, (response) => {
      if (response.statusCode !== 200) {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ request, status: response.statusCode, text }));
        return;
      }
      response.once("data", () => resolve({ request, response, status: 200 }));
    });
    request.on("error", () => resolve({ request, status: 0 }));
    request.end();
  });
}

test("C7: streams opened through the admin gateway are released when the browser leaves", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const tokens = [];
    for (let index = 0; index < 6; index += 1) tokens.push((await server.auth.issue(`tab ${index}`, ["read"])).token);
    const opened = [];
    for (let index = 0; index < 50; index += 1) opened.push(await openStream({ port: server.adminPort, token: tokens[index % 5], host: "admin.example.com", ip: OWNER }));
    assert.equal(opened.filter((stream) => stream.status === 200).length, 50, "fifty streams through the gateway");
    const full = await openStream({ port: server.port, token: tokens[5] });
    assert.equal(full.status, 429, "the global cap is reached");
    assert.match(full.text, /too_many_streams/);
    full.request.destroy();

    for (const stream of opened) stream.request.destroy();
    const freed = await until(async () => {
      const attempt = await openStream({ port: server.port, token: tokens[5] });
      attempt.request.destroy();
      return attempt.status === 200;
    }, 6_000).then(() => true, () => false);
    assert.equal(freed, true, "a new stream is accepted within seconds of the browsers leaving");
  });
});

test("C7: one client holds at most ten live streams; others are unaffected and a closed stream frees its slot at once", async () => {
  await withServer(async (server) => {
    const [busy, other] = await Promise.all([server.auth.issue("busy tab", ["read"]), server.auth.issue("other device", ["read"])]);
    const mine = [];
    for (let index = 0; index < 10; index += 1) mine.push(await openStream({ port: server.port, token: busy.token }));
    assert.deepEqual(mine.map((stream) => stream.status), Array(10).fill(200));
    const eleventh = await openStream({ port: server.port, token: busy.token });
    assert.equal(eleventh.status, 429);
    assert.match(eleventh.text, /too_many_streams/);
    eleventh.request.destroy();
    const unaffected = await openStream({ port: server.port, token: other.token });
    assert.equal(unaffected.status, 200, "another client still gets its stream");

    mine[0].request.destroy();
    const replaced = await until(async () => {
      const attempt = await openStream({ port: server.port, token: busy.token });
      if (attempt.status === 200) return attempt;
      attempt.request.destroy();
      return undefined;
    }, 3_000).catch(() => undefined);
    assert.ok(replaced, "the slot of the closed stream is free within moments");
    replaced?.request.destroy();
    unaffected.request.destroy();
    for (const stream of mine) stream.request.destroy();
  });
});

test("C7: the gateway keeps cf-connecting-ip and authorization, even when the Connection header names them", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  try {
    await withServer(async (server) => {
      await behindTunnel(server);
      const token = (await server.auth.issue("device", ["read"])).token;
      const viaGateway = (headers) => send(`${server.adminUrl}/api/v1/info`, { headers: { host: "admin.example.com", ...headers }, agent });
      const statuses = [];
      for (let index = 0; index < 124; index += 1) statuses.push((await viaGateway({ ...via(ATTACKER), connection: "keep-alive, cf-connecting-ip, authorization" })).status);
      assert.equal(statuses.filter((status) => status === 200).length, 120, "the API saw one source and counted its 120 requests");
      assert.ok(statuses.slice(120).every((status) => status === 429));
      assert.equal((await info(server, undefined, agent)).status, 200, "the attacker's requests were not charged to the local source");
      const session = await send(`${server.adminUrl}/api/v1/session`, { headers: { host: "admin.example.com", ...bearer(token), connection: "authorization" }, agent });
      assert.equal(session.status, 200, "authorization reaches the API");
    });
  } finally {
    agent.destroy();
  }
});

test("C7: a chunked request body and a streamed answer pass through the gateway", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const { token } = await server.auth.issue("writer", ["read", "write"]);
    const body = JSON.stringify({ title: "Through the gateway", storage: { kind: "local" } });
    const socket = net.connect(server.adminPort, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", () => undefined);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(requestHead(["PUT /api/v1/books/g1 HTTP/1.1", "Host: admin.example.com", `Authorization: Bearer ${token}`, "Content-Type: application/json", "Transfer-Encoding: chunked", "Connection: close"]));
    socket.write(`${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    await Promise.race([closed, sleep(5_000)]);
    socket.destroy();
    assert.match(text, /^HTTP\/1\.1 200 /, text.slice(0, 200));
    assert.match(text, /"bookId":"g1"/);
    const stream = await openStream({ port: server.adminPort, token, host: "admin.example.com" });
    assert.equal(stream.status, 200, "an event stream is delivered through the gateway");
    stream.request.destroy();
  });
});

test("C7: the gateway forwards end-to-end headers only: hop-by-hop headers are dropped, cf-connecting-ip and authorization never", () => {
  const { forwardedHeaders } = testing;
  const kept = forwardedHeaders({
    host: "admin.example.com",
    connection: "keep-alive, x-trace",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "websocket",
    te: "trailers",
    trailer: "x-checksum",
    "proxy-authorization": "Basic abc",
    "proxy-connection": "keep-alive",
    "proxy-authenticate": "Basic",
    "proxy-anything": "x",
    "x-trace": "named by Connection",
    expect: "100-continue",
    authorization: "Bearer token",
    "cf-connecting-ip": ATTACKER,
    "content-type": "application/json",
    "content-length": "2",
    cookie: "a=b",
    origin: "https://narrarium.net",
  });
  assert.deepEqual(Object.keys(kept).sort(), ["authorization", "cf-connecting-ip", "content-length", "content-type", "cookie", "host", "origin"]);
  const protectedHeaders = forwardedHeaders({ connection: "cf-connecting-ip, authorization, x-other", authorization: "Bearer token", "cf-connecting-ip": ATTACKER, "x-other": "dropped" });
  assert.deepEqual(protectedHeaders, { authorization: "Bearer token", "cf-connecting-ip": ATTACKER }, "naming them in Connection does not strip them");
  assert.deepEqual(forwardedHeaders({ "set-cookie": ["a=1", "b=2"], "content-type": "text/event-stream", connection: "keep-alive", "transfer-encoding": "chunked" }), { "set-cookie": ["a=1", "b=2"], "content-type": "text/event-stream" }, "the same filter serves the answer");
});

// ---------------------------------------------------------------------------------------------
// C11: bodies that stall, large bodies, and held connections
// ---------------------------------------------------------------------------------------------

test("C11: both listeners give a whole request five minutes and keep the header timeout", async () => {
  await withServer(async (server) => {
    for (const [name, listener] of Object.entries(server.servers)) {
      assert.equal(listener.requestTimeout, 300_000, `${name}: requestTimeout`);
      assert.equal(listener.headersTimeout, 20_000, `${name}: headersTimeout`);
      assert.ok(listener.maxConnections >= 1 && listener.maxConnections <= 256, `${name}: maxConnections`);
    }
  });
});

test("C11: a request body that stops arriving is answered with 408 request_timeout and the connection is closed", async () => {
  await withServer(async (server) => {
    const head = requestHead(["POST /api/v1/pairings HTTP/1.1", `Host: 127.0.0.1:${server.port}`, "Content-Type: application/json", "Content-Length: 200"]);
    const stalled = openStalled(server.port, `${head}{"code":`);
    const closed = await until(() => stalled.closed, 5_000).then(() => true, () => false);
    stalled.destroy();
    assert.match(stalled.text, /^HTTP\/1\.1 408 /, `the answer was: ${JSON.stringify(stalled.text.slice(0, 120))}`);
    assert.match(stalled.text, /"code":"request_timeout"/);
    assert.equal(closed, true, "the connection is closed after the answer");
    assert.equal((await info(server)).status, 200, "the server is not affected");
  }, { limits: { bodyIdleMs: 300 } });
});

test("C11: the admin listener times out a stalled login body too", async () => {
  await withServer(async (server) => {
    const head = requestHead(["POST /admin/api/login HTTP/1.1", `Host: 127.0.0.1:${server.adminPort}`, `Origin: ${server.adminUrl}`, "Content-Type: application/json", "Content-Length: 100"]);
    const stalled = openStalled(server.adminPort, `${head}{"code":"`);
    const closed = await until(() => stalled.closed, 5_000).then(() => true, () => false);
    stalled.destroy();
    assert.match(stalled.text, /^HTTP\/1\.1 408 /, `the answer was: ${JSON.stringify(stalled.text.slice(0, 120))}`);
    assert.equal(closed, true);
  }, { limits: { bodyIdleMs: 300 } });
});

test("C11: the timer measures inactivity: a body that arrives slowly but steadily is accepted", async () => {
  await withServer(async (server) => {
    const body = JSON.stringify({ code: "123456789", nonce: "a".repeat(64), label: "A slow phone on a bad connection" });
    const socket = net.connect(server.port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", () => undefined);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(requestHead(["POST /api/v1/pairings HTTP/1.1", `Host: 127.0.0.1:${server.port}`, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close"]));
    const started = Date.now();
    const pieces = 6;
    const size = Math.ceil(body.length / pieces);
    for (let piece = 0; piece < pieces; piece += 1) {
      socket.write(body.slice(piece * size, (piece + 1) * size));
      await sleep(250);
    }
    await Promise.race([closed, sleep(5_000)]);
    socket.destroy();
    assert.ok(Date.now() - started > 1_000, "the upload took longer than the idle time");
    assert.match(text, /^HTTP\/1\.1 401 /, `the whole body was read and parsed: ${JSON.stringify(text.slice(0, 120))}`);
    assert.match(text, /pairing_invalid/);
  }, { limits: { bodyIdleMs: 1_000 } });
});

test("C11: an oversized chunked body is answered with 413 and the connection closes (it used to be reset before the answer)", async () => {
  await withServer(async (server) => {
    const socket = net.connect(server.port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", () => undefined);
    const closed = new Promise((resolve) => socket.on("close", resolve));
    socket.write(requestHead(["POST /api/v1/pairings HTTP/1.1", `Host: 127.0.0.1:${server.port}`, "Content-Type: application/json", "Transfer-Encoding: chunked"]));
    const chunk = `${"x".repeat(1024)}`;
    for (let index = 0; index < 6; index += 1) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    await Promise.race([closed, sleep(5_000)]);
    socket.destroy();
    assert.match(text, /^HTTP\/1\.1 413 /, `the answer was: ${JSON.stringify(text.slice(0, 120))}`);
    assert.match(text, /payload_too_large/);
    assert.equal((await info(server)).status, 200);
  });
});

test("C11: at most two large bodies are read at once; the third caller gets 503 busy with Retry-After 2, and the gate reopens when they end", async () => {
  const lines = [];
  await withServer(async (server) => {
    const { token } = await server.auth.issue("writer", ["read", "write"]);
    const auth = bearer(token);
    assert.equal((await send(`${server.url}/api/v1/books/big`, { method: "PUT", headers: { ...auth, ...JSON_HEADERS }, body: { title: "Big", storage: { kind: "local" } } })).status, 200);
    const head = requestHead(["POST /api/v1/books/big/files/commit HTTP/1.1", `Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${token}`, "Content-Type: application/json", "Content-Length: 5000000"]);
    const first = openStalled(server.port, `${head}{"changes":[`, 100);
    const second = openStalled(server.port, `${head}{"changes":[`, 100);
    try {
      const commit = () => send(`${server.url}/api/v1/books/big/files/commit`, { method: "POST", headers: { ...auth, ...JSON_HEADERS }, body: { changes: [{ path: "a.md", content: "hello\n" }], message: "m" } });
      // The server needs a moment to start reading the two stalled bodies: ask until it says it is busy.
      const third = await until(async () => {
        const attempt = await commit();
        return attempt.status === 503 ? attempt : undefined;
      }, 6_000);
      assert.equal(third.json.code, "busy");
      assert.equal(third.headers["retry-after"], "2");
      assert.equal((await send(`${server.url}/api/v1/books`, { headers: auth })).status, 200, "everything else is served");
      first.destroy();
      second.destroy();
      const reopened = await until(async () => (await commit()).status === 200, 6_000).then(() => true, () => false);
      assert.equal(reopened, true, "the gate reopens when the stalled bodies are gone");
    } finally {
      first.destroy();
      second.destroy();
    }
    assert.deepEqual(lines.filter((line) => /^Error/.test(line)), [], "uploads that were abandoned are not server errors");
  }, { log: (line) => lines.push(line) });
});

test("C11: one source cannot hold more than sixteen anonymous requests at a time; another source is not affected", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const code = await adminCode(server);
    const head = (ip) => requestHead(["POST /admin/api/login HTTP/1.1", `Host: 127.0.0.1:${server.adminPort}`, `Origin: ${server.adminUrl}`, `cf-connecting-ip: ${ip}`, "Content-Type: application/json", "Content-Length: 100"]);
    const held = Array.from({ length: 16 }, () => openStalled(server.adminPort, `${head(ATTACKER)}{"code":"`, 100));
    try {
      // The server needs a moment to see all sixteen: ask until it refuses the next one.
      const refused = await until(async () => {
        const attempt = await login(server, WRONG_CODE, ATTACKER);
        return attempt.status === 429 ? attempt : undefined;
      }, 6_000);
      assert.equal(refused.json.code, "rate_limit");
      assert.ok(Number(refused.headers["retry-after"]) >= 1);
      assert.equal((await login(server, code, OWNER)).status, 200, "the owner is served meanwhile");
      for (const stalled of held) stalled.destroy();
      const freed = await until(async () => (await login(server, WRONG_CODE, ATTACKER)).status === 401, 6_000).then(() => true, () => false);
      assert.equal(freed, true, "the slots come back when the connections close");
    } finally {
      for (const stalled of held) stalled.destroy();
    }
  });
});

test("C11: the API holds back anonymous requests per source too (stalled pairing polls)", async () => {
  await withServer(async (server) => {
    await behindTunnel(server);
    const head = requestHead(["POST /api/v1/pairings/00000000-0000-4000-8000-000000000000/result HTTP/1.1", `Host: 127.0.0.1:${server.port}`, `cf-connecting-ip: ${ATTACKER}`, "Content-Type: application/json", "Content-Length: 100"]);
    const held = Array.from({ length: 16 }, () => openStalled(server.port, `${head}{"nonce":"`, 100));
    try {
      await until(async () => (await info(server, ATTACKER)).status === 429, 6_000);
      assert.equal((await info(server, OWNER)).status, 200);
    } finally {
      for (const stalled of held) stalled.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C20: errors are mapped on purpose, never by what a library happens to put in `status`
// ---------------------------------------------------------------------------------------------

test("C20: a non-ASCII CSRF token is a 403, not a 500 with Node's message", async () => {
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    const response = await send(`${server.adminUrl}/admin/api/pairing/cancel`, {
      method: "POST",
      headers: { origin: server.adminUrl, cookie: admin.cookie, ...JSON_HEADERS, "x-csrf-token": "é".repeat(43) },
      body: {},
    });
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.code, "csrf");
    for (const token of ["", "short", "é".repeat(5), "x".repeat(43), "é".repeat(200)]) {
      const wrong = await send(`${server.adminUrl}/admin/api/pairing/cancel`, { method: "POST", headers: { origin: server.adminUrl, cookie: admin.cookie, ...JSON_HEADERS, "x-csrf-token": token }, body: {} });
      assert.equal(wrong.status, 403, JSON.stringify(token.slice(0, 10)));
    }
    assert.equal((await admin.call("POST", "/admin/api/pairing/cancel", {})).status, 200, "the right token still works");
  });
});

test("C20: a malformed percent escape in a path is a 400 invalid_path", async () => {
  await withServer(async (server) => {
    const { token } = await server.auth.issue("writer", ["read", "write"]);
    const headers = { ...bearer(token), ...JSON_HEADERS };
    for (const [method, route] of [["PUT", "/api/v1/books/%E0%A4%A"], ["POST", "/api/v1/books/%E0%A4%A/files/read"], ["DELETE", "/api/v1/books/%"], ["GET", "/api/v1/books/%zz/manifest"], ["GET", "/api/v1/books/%E0%A4%A/autopilot"]]) {
      const response = await send(`${server.url}${route}`, { method, headers, body: method === "PUT" || method === "POST" ? {} : undefined });
      assert.equal(response.status, 400, `${method} ${route}: ${response.text}`);
      assert.equal(response.json.code, "invalid_path");
    }
    assert.equal((await send(`${server.url}/api/v1/books/ok%2Dbook`, { method: "PUT", headers, body: { title: "Fine", storage: { kind: "local" } } })).status, 200, "a valid escape still works");
  });
});

test("C20: an unknown error answers 500 with a generic message and a request id; the real error is only in the log", async () => {
  const lines = [];
  await withServer(async (server) => {
    const { token } = await server.auth.issue("runner", ["read", "write", "run"]);
    const headers = { ...bearer(token), ...JSON_HEADERS };
    assert.equal((await send(`${server.url}/api/v1/books/b`, { method: "PUT", headers, body: { title: "B", storage: { kind: "local" } } })).status, 200);
    const changes = Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content }));
    assert.equal((await send(`${server.url}/api/v1/books/b/files/commit`, { method: "POST", headers, body: { changes, message: "seed" } })).status, 200);
    const response = await send(`${server.url}/api/v1/books/b/director/ask`, { method: "POST", headers, body: { target: { kind: "book" }, question: "Does it work?" } });
    assert.equal(response.status, 500, "not the 401 that the provider's error carried: that would read as 'your server token is invalid'");
    assert.equal(response.json.code, "internal");
    assert.equal(response.json.message, "The server could not complete the request.");
    assert.match(response.json.requestId, /^[0-9a-f]{8}$/);
    assert.equal(response.headers["x-request-id"], response.json.requestId);
    assert.ok(!response.text.includes("sk-secret-1234") && !response.text.includes("/home/owner"), "nothing of the real error is sent");
    const logged = lines.find((line) => line.includes(response.json.requestId));
    assert.ok(logged, `a log line carries the request id:\n${lines.join("\n")}`);
    assert.match(logged, /sk-secret-1234/, "and the real error");
  }, {
    log: (line) => lines.push(line),
    ai: { complete: async () => { throw Object.assign(new Error("provider said: key sk-secret-1234 rejected, see /home/owner/.secret"), { status: 401, code: "invalid_api_key" }); } },
  });
});

/** A stand-in for an AI provider that answers every request with one status. */
async function fakeProvider(status, body) {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test("C20: an AI provider's 401 is a 502 ai_provider, never a 401 that the web app would read as an invalid server token", async () => {
  const provider = await fakeProvider(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
  try {
    await withServer(async (server, client) => {
      await client.registerBook("p", { title: "P", storage: { kind: "local" } });
      await client.commitFiles("p", Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content })), "seed");
      await client.putAiConfig({ aiIntegrations: [{ id: "p", name: "Local provider", provider: "openai", endpoint: provider.url, apiKey: "sk-test", chatModels: [{ id: "m", name: "gpt-test", capabilities: ["default"] }] }] });
      // The server calls only what its owner approved: this is the owner approving the provider's origin.
      await server.data.updateConfig((config) => {
        config.allowedAiBases = [new URL(provider.url).origin];
      });
      await assert.rejects(
        () => client.askDirector("p", { target: { kind: "book" }, question: "Does it work?" }),
        (error) => error.status === 502 && error.code === "ai_provider" && /401/.test(error.message),
      );
      assert.equal((await client.session()).clientLabel, "test client", "the client's own token is untouched");
    }, { ai: undefined });
  } finally {
    await provider.close();
  }
});

test("C20: a corrupt autopilot state is a 409 state_corrupt and the book list says why", async () => {
  await withServer(async (server, client) => {
    await client.registerBook("c", { title: "C", storage: { kind: "local" } });
    await client.commitFiles("c", Object.entries(seedBookFiles()).map(([file, content]) => ({ path: file, content })), "seed");
    const [healthy] = await client.listBooks();
    assert.equal(healthy.error, undefined);
    const folder = path.join(server.data.bookDirectory("c"), "autopilot");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "state.json"), "<<<<<<< ours\n{\"version\": 1}\n=======\n{\"version\": 2}\n>>>>>>> theirs\n");
    await assert.rejects(
      () => client.startAutopilot("c", { brief: { idea: "A harbor", targetChapters: 1, scenesPerChapter: 1 }, options: { readers: false, readersOnPlan: false } }),
      (error) => error.status === 409 && error.code === "state_corrupt" && /state\.json/.test(error.message),
    );
    const [broken] = await client.listBooks();
    assert.equal(broken.autopilot, null);
    assert.match(broken.error ?? "", /state\.json/, "the summary carries the engine's message");
    const snapshot = await client.autopilot("c");
    assert.equal(snapshot.stateError.code, "state_corrupt");
  });
});

test("C20: errorStatus trusts only HttpError, the known engine errors and the explicit mappings", () => {
  const { errorStatus, HttpError, AiProviderError, AiReplyRejectedError, AutopilotStateCorruptError } = testing;
  const shape = (error) => {
    const { status, code, message } = errorStatus(error);
    return { status, code, message };
  };
  assert.deepEqual(shape(new HttpError(418, "teapot", "short and stout")), { status: 418, code: "teapot", message: "short and stout" });
  assert.deepEqual(shape(new HttpError(429, "slow_down", "later", { "retry-after": "7" })), { status: 429, code: "slow_down", message: "later" });
  assert.deepEqual(errorStatus(new HttpError(429, "slow_down", "later", { "retry-after": "7" })).headers, { "retry-after": "7" });
  assert.deepEqual(shape(new AutopilotStateCorruptError({ path: "autopilot/state.json", reason: "conflict markers" })), {
    status: 409,
    code: "state_corrupt",
    message: new AutopilotStateCorruptError({ path: "autopilot/state.json", reason: "conflict markers" }).message,
  });
  assert.deepEqual(shape(new AiProviderError("openai gpt: HTTP 401 — bad key", 401)), { status: 502, code: "ai_provider", message: "openai gpt: HTTP 401 — bad key" });
  assert.equal(errorStatus(new AiReplyRejectedError("the reply was empty")).status, 502, "its subclasses too");
  assert.deepEqual(shape(new Error("Unsafe book path: ../x")), { status: 400, code: "invalid_path", message: "Unsafe book path: ../x" });

  // Everything else is an internal error, whatever a library put on it.
  const hostile = [
    Object.assign(new Error("boom: /home/owner/secret"), { status: 401, code: "invalid_api_key" }),
    Object.assign(new Error("boom"), { status: 403, code: "scope" }),
    Object.assign(new Error("boom"), { statusCode: 404 }),
    { status: 401, code: "unauthorized", message: "not even an Error" },
    "a string", null, undefined, 42,
  ];
  const requestIds = new Set();
  for (const error of hostile) {
    const mapped = errorStatus(error);
    assert.equal(mapped.status, 500);
    assert.equal(mapped.code, "internal");
    assert.equal(mapped.message, "The server could not complete the request.");
    assert.match(mapped.requestId, /^[0-9a-f]{8}$/);
    assert.ok(mapped.detail, "the real error is kept for the log");
    requestIds.add(mapped.requestId);
  }
  assert.ok(requestIds.size > 1, "request ids differ");
  assert.match(errorStatus(hostile[0]).detail, /boom: \/home\/owner\/secret/);
});

// ---------------------------------------------------------------------------------------------
// Small items
// ---------------------------------------------------------------------------------------------

test("small: the release check is cached ten minutes per version; POST /updates always asks again", async () => {
  let checks = 0;
  const checkRelease = async (installed) => {
    checks += 1;
    return releaseAvailable("0.2.0")(installed);
  };
  await withServer(async (_server, client) => {
    await client.updates();
    await client.updates();
    await client.updates();
    assert.equal(checks, 1, "three reads, one question to npm");
    await client.requestUpdate("0.2.0", SERVER_VERSION);
    assert.equal(checks, 2, "a POST sees fresh data");
    await client.updates();
    assert.equal(checks, 2, "what the POST learned is what the next read shows");
  }, { checkRelease, supervised: true, scopes: ALL_SCOPES });

  checks = 0;
  await withServer(async (server) => {
    const admin = await adminLogin(server);
    await admin.call("GET", "/admin/api/updates");
    await admin.call("GET", "/admin/api/updates");
    assert.equal(checks, 1, "the admin panel's reads are cached too");
    const accepted = await admin.call("POST", "/admin/api/updates", { version: "0.2.0", installedVersion: SERVER_VERSION });
    assert.equal(accepted.status, 202);
    assert.equal(checks, 2, "the admin POST asked again");
  }, { checkRelease, supervised: true });
});

test("small: an unavailable registry is asked again soon, and a check that throws is never cached", async () => {
  let checks = 0;
  let outcome = "unavailable";
  const checkRelease = async (installed) => {
    checks += 1;
    if (outcome === "throws") throw new Error("registry exploded");
    if (outcome === "unavailable") return { packageName: "narrarium-server", installedVersion: installed, available: false, signed: false, reason: "unavailable", message: "npm could not be checked: no update is offered." };
    return releaseAvailable("0.2.0")(installed);
  };
  await withServer(async (server, client) => {
    assert.equal((await client.updates()).reason, "unavailable");
    assert.equal((await client.updates()).reason, "unavailable");
    assert.equal(checks, 1, "an unreachable registry is not asked on every call either");

    outcome = "throws";
    const admin = await adminLogin(server);
    const failed = await admin.call("POST", "/admin/api/updates", { version: "0.2.0", installedVersion: SERVER_VERSION });
    assert.equal(failed.status, 500, "the failure is reported");
    assert.equal(checks, 2, "the POST asked again and was not answered from the cache");

    outcome = "ok";
    const next = await client.updates();
    assert.equal(checks, 3, "neither the failure nor the stale 'unavailable' answer is served");
    assert.equal(next.available, true);
    assert.equal(next.latestVersion, "0.2.0");
  }, { checkRelease, supervised: true });
});

test("small: a GitHub token longer than 512 characters is refused before anything changes", async () => {
  await withServer(async (server, client) => {
    await assert.rejects(() => client.registerBook("t", { title: "T", storage: { kind: "local" }, githubToken: "x".repeat(513) }), (error) => error.status === 400 && error.code === "invalid_token");
    assert.deepEqual(await client.listBooks(), [], "the book was not registered either");
    const accepted = await client.registerBook("t", { title: "T", storage: { kind: "local" }, githubToken: `${"x".repeat(512)}   ` });
    assert.equal(accepted.hasGithubToken, true, "512 characters are fine (surrounding spaces are not part of the token)");
    assert.equal((await client.listBooks()).length, 1, "the list keeps working");
    await assert.rejects(() => server.data.setBookToken("t", "y".repeat(513)), (error) => error.status === 400 && error.code === "invalid_token");
    assert.equal(await server.data.bookToken("t"), "x".repeat(512), "the stored token was not replaced");
  });
});

test("small: at most 200 books; a new id above that is a 409 too_many_books, an existing one can always be registered again", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "narrarium-many-books-"));
  try {
    const now = new Date().toISOString();
    const books = Array.from({ length: 200 }, (_, index) => ({ bookId: `book-${index}`, title: `Book ${index}`, storage: { kind: "local" }, createdAt: now, updatedAt: now }));
    await atomicJson(path.join(dataDir, "books.json"), { books });
    const server = await startNarrariumServer({ dataDir, port: 0, adminPort: 0, supervised: false, checkRelease: noRelease, tunnel: noTunnel });
    try {
      const { token } = await server.auth.issue("writer", ["read", "write"]);
      const headers = { ...bearer(token), ...JSON_HEADERS };
      const register = (id, body = { title: id, storage: { kind: "local" } }) => send(`${server.url}/api/v1/books/${id}`, { method: "PUT", headers, body });
      const refused = await register("one-too-many");
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, "too_many_books");
      assert.equal((await register("book-7", { title: "Renamed", storage: { kind: "local" } })).status, 200, "an existing book is updated");
      assert.equal((await send(`${server.url}/api/v1/books/book-8`, { method: "DELETE", headers })).status, 200);
      assert.equal((await register("one-too-many")).status, 200, "a place is free again");
      assert.equal((await register("another-one")).status, 409);
      // Registrations that overlap cannot all take the last place.
      assert.equal((await send(`${server.url}/api/v1/books/book-9`, { method: "DELETE", headers })).status, 200);
      const racing = await Promise.all(["race-a", "race-b", "race-c"].map((id) => register(id)));
      assert.deepEqual(racing.map((answer) => answer.status).sort(), [200, 409, 409], "exactly one of three new books gets the one free place");
    } finally {
      await server.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("small: Retry-After can be read by the web app, which runs on another origin", async () => {
  await withServer(async (server) => {
    const response = await send(`${server.url}/api/v1/info`, { headers: { origin: "https://narrarium.net" } });
    assert.equal(response.status, 200);
    const exposed = String(response.headers["access-control-expose-headers"]).toLowerCase().split(",").map((name) => name.trim());
    assert.ok(exposed.includes("retry-after"), `exposed headers: ${exposed.join(", ")}`);
    assert.ok(exposed.includes("etag"), "etag is still exposed");
  });
});
