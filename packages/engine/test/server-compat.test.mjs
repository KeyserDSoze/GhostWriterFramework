import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as engine from "../dist/index.js";

// New exports are read from the namespace so that, before they exist, each test fails on its own.
const { MAX_SUPPORTED_SERVER_API, MIN_SUPPORTED_SERVER_API, NarrariumServerClient, SERVER_API_VERSION, ServerRequestError, pairWithServer, pairWithServerDetailed, randomNonce, serverCompatibility, serverIdentityMessage, verifyServerIdentity } = engine;

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

let keys;
async function identity() {
  keys ??= await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", keys.publicKey));
  return { publicKey: base64(spki), fingerprint: createHash("sha256").update(spki).digest("hex") };
}

/** What `GET /api/v1/info?nonce=…` of a server answers: signed, with the API version it speaks. */
async function signedInfo(nonce, extra = {}) {
  const { publicKey, fingerprint } = await identity();
  const serverId = "server-1";
  const signature = base64(new Uint8Array(await globalThis.crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(serverIdentityMessage(nonce, serverId, publicKey)))));
  return { name: "narrarium-server", apiVersion: 1, serverVersion: "0.1.2", engineVersion: "0.1.2", serverId, label: "test server", git: true, features: [], publicKey, fingerprint, nonce, signature, ...extra };
}

const verdictOf = (info) => serverCompatibility(info).status;

// ─── The versions ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("a server that speaks the API this client knows is compatible, an older or a newer one is said to be, and nothing throws", () => {
  assert.equal(typeof serverCompatibility, "function");
  assert.equal(typeof MIN_SUPPORTED_SERVER_API, "number");
  assert.equal(typeof MAX_SUPPORTED_SERVER_API, "number");
  assert.ok(MIN_SUPPORTED_SERVER_API <= SERVER_API_VERSION && SERVER_API_VERSION <= MAX_SUPPORTED_SERVER_API, "the API this engine announces is one it supports");
  assert.deepEqual([MIN_SUPPORTED_SERVER_API, MAX_SUPPORTED_SERVER_API], [1, 1]);

  const ok = serverCompatibility({ apiVersion: 1 });
  assert.equal(ok.status, "ok");
  assert.equal(typeof ok.message, "string");
  const older = serverCompatibility({ apiVersion: MIN_SUPPORTED_SERVER_API - 1 });
  assert.equal(older.status, "server-older");
  assert.match(older.message, /update the server/i);
  assert.ok(older.message.includes(String(MIN_SUPPORTED_SERVER_API - 1)), "it says which version the server speaks");
  const newer = serverCompatibility({ apiVersion: MAX_SUPPORTED_SERVER_API + 1 });
  assert.equal(newer.status, "server-newer");
  assert.match(newer.message, /update (Narrarium|the app)/i);
  assert.ok(newer.message.includes(String(MAX_SUPPORTED_SERVER_API + 1)));
});

test("a server that does not say which API it speaks, or says it oddly, is taken for an old one, never an exception", () => {
  for (const apiVersion of [undefined, null, Number.NaN, "1", "", {}, Number.POSITIVE_INFINITY * -1]) assert.equal(verdictOf({ apiVersion }), "server-older", String(apiVersion));
  assert.equal(verdictOf({}), "server-older");
  assert.equal(verdictOf(undefined), "server-older");
  assert.equal(verdictOf(null), "server-older");
  assert.equal(verdictOf({ apiVersion: 1.5 }), "server-newer");
  assert.equal(verdictOf({ apiVersion: 99 }), "server-newer");
});

test("verifyServerIdentity says whether the server is compatible, for a server of any version, without throwing for it", async () => {
  for (const [apiVersion, status] of [[1, "ok"], [0, "server-older"], [2, "server-newer"]]) {
    const nonce = randomNonce();
    const check = await verifyServerIdentity(await signedInfo(nonce, { apiVersion }), nonce);
    assert.equal(check.verified, true);
    assert.equal(check.compatibility.status, status);
    assert.equal(typeof check.compatibility.message, "string");
  }
  const nonce = randomNonce();
  const info = await signedInfo(nonce);
  delete info.apiVersion;
  assert.equal((await verifyServerIdentity(info, nonce)).compatibility.status, "server-older");
  const wrong = await signedInfo("0".repeat(64));
  await assert.rejects(() => verifyServerIdentity(wrong, nonce), /prove its identity/, "a wrong answer still throws, as it did");
});

// ─── A fake personal server ─────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /info`, the pairing and `DELETE /session` of a server; `options` say what this server knows how to say. */
function fakeServer(options = {}) {
  const log = [];
  let polls = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method, path: url.pathname, authorization: init.headers?.authorization, body });
    const key = `${method} ${url.pathname}`;
    if (key === "GET /api/v1/info") {
      if (options.infoFails) return Response.json({ code: "http_error", message: "no" }, { status: 500 });
      return Response.json(await signedInfo(url.searchParams.get("nonce") ?? "", options.info));
    }
    if (key === "POST /api/v1/pairings") return Response.json(options.requestAnswer ?? { id: "pair-1", verification: "1234" });
    if (key === "POST /api/v1/pairings/pair-1/result") {
      polls += 1;
      return Response.json(polls <= (options.pendingPolls ?? 1) ? { pending: true } : options.resultAnswer ?? { token: "nrs_token", verification: "5678" });
    }
    if (key === "DELETE /api/v1/session") return options.sessionAnswer ? options.sessionAnswer() : Response.json({ revoked: true });
    return Response.json({ code: "not_found", message: "unknown" }, { status: 404 });
  };
  return { fetch, log };
}

const PAIR = { baseUrl: "http://127.0.0.1:24242", code: "123 456 789", label: "My browser", pollMs: 0 };

test("pairing hands back the token as ever, and the verification of the request and of the token when the server sends them", async () => {
  const server = fakeServer();
  const waiting = [];
  const token = await pairWithServer({ ...PAIR, fetch: server.fetch, onWaitingApproval: (request) => waiting.push(request) });
  assert.equal(token, "nrs_token", "pairWithServer still answers the token itself");
  const paired = [];
  assert.equal(await pairWithServer({ ...PAIR, fetch: fakeServer().fetch, onPaired: (pairing) => paired.push(pairing) }), "nrs_token");
  assert.deepEqual(paired.map((pairing) => [pairing.token, pairing.verification, pairing.requestVerification, pairing.compatibility.status]), [["nrs_token", "5678", "1234", "ok"]], "and onPaired hands over the rest");
  assert.deepEqual(waiting.map((request) => request?.verification), ["1234"], "the four digits the owner sees next to the request are handed over while waiting");

  const detailed = await pairWithServerDetailed({ ...PAIR, fetch: fakeServer().fetch });
  assert.equal(detailed.token, "nrs_token");
  assert.equal(detailed.verification, "5678", "the digits shown next to the client once approved");
  assert.equal(detailed.requestVerification, "1234");
  assert.deepEqual(detailed.compatibility.status, "ok");
  const sent = server.log.find((entry) => entry.path === "/api/v1/pairings");
  assert.equal(sent.body.code, "123456789");
  assert.equal(sent.body.label, "My browser");
});

test("a server that is older or newer than the app is reported when pairing, and pairing goes on", async () => {
  for (const [apiVersion, status] of [[0, "server-older"], [7, "server-newer"]]) {
    const waiting = [];
    const detailed = await pairWithServerDetailed({ ...PAIR, fetch: fakeServer({ info: { apiVersion } }).fetch, onWaitingApproval: (request) => waiting.push(request) });
    assert.equal(detailed.token, "nrs_token");
    assert.equal(detailed.compatibility.status, status);
    assert.equal(waiting[0].compatibility.status, status, "and the app is told while the owner is asked");
  }
});

test("an older server that sends no verification, no version and no answer to info is just as good", async () => {
  const server = fakeServer({ infoFails: true, requestAnswer: { id: "pair-1" }, resultAnswer: { token: "nrs_old" } });
  const waiting = [];
  const detailed = await pairWithServerDetailed({ ...PAIR, fetch: server.fetch, onWaitingApproval: (request) => waiting.push(request) });
  assert.equal(detailed.token, "nrs_old");
  assert.equal(detailed.verification, undefined);
  assert.equal(detailed.requestVerification, undefined);
  assert.equal(detailed.compatibility, undefined, "a server that does not answer info has nothing to say about its version");
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.verification, undefined);
  assert.equal(await pairWithServer({ ...PAIR, fetch: fakeServer({ requestAnswer: { id: "pair-1" }, resultAnswer: { token: "nrs_old" } }).fetch }), "nrs_old");
});

test("a verification that is not four digits is not passed on", async () => {
  for (const wrong of ["12", "12345", "abcd", 1234, null, "12 34"]) {
    const detailed = await pairWithServerDetailed({ ...PAIR, fetch: fakeServer({ requestAnswer: { id: "pair-1", verification: wrong }, resultAnswer: { token: "nrs_t", verification: wrong } }).fetch });
    assert.equal(detailed.verification, undefined, String(wrong));
    assert.equal(detailed.requestVerification, undefined, String(wrong));
  }
});

test("the client's own calls carry the verification and the compatibility too", async () => {
  const server = fakeServer({ info: { apiVersion: 3 } });
  const client = new NarrariumServerClient({ baseUrl: PAIR.baseUrl, token: "nrs_me", fetch: server.fetch });
  assert.deepEqual(await client.requestPairing({ code: "123456789", nonce: "a".repeat(64), label: "x" }), { id: "pair-1", verification: "1234" });
  assert.deepEqual(await client.pairingResult("pair-1", "a".repeat(64)), { pending: true });
  assert.deepEqual(await client.pairingResult("pair-1", "a".repeat(64)), { token: "nrs_token", verification: "5678" });
  const { info, identity: check } = await client.verifiedInfo();
  assert.equal(info.apiVersion, 3);
  assert.equal(check.verified, true);
  assert.equal(check.compatibility.status, "server-newer");
});

// ─── Signing out ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("signOut revokes the token the client holds, and only that", async () => {
  const server = fakeServer();
  const client = new NarrariumServerClient({ baseUrl: PAIR.baseUrl, token: "nrs_me", fetch: server.fetch });
  assert.equal(typeof client.signOut, "function");
  assert.deepEqual(await client.signOut(), { revoked: true });
  assert.deepEqual(server.log.map((entry) => [entry.method, entry.path, entry.authorization]), [["DELETE", "/api/v1/session", "Bearer nrs_me"]]);
  assert.deepEqual(await client.forgetSession(), { revoked: true }, "the older name still works");
});

test("signing out with a token that was already revoked is not an error, and a server that is away is", async () => {
  const revoked = fakeServer({ sessionAnswer: () => Response.json({ code: "unauthorized", message: "This client token is not valid or was revoked." }, { status: 401 }) });
  const client = new NarrariumServerClient({ baseUrl: PAIR.baseUrl, token: "nrs_gone", fetch: revoked.fetch });
  assert.deepEqual(await client.signOut(), { revoked: false }, "the device is disconnected either way");
  await assert.rejects(() => client.forgetSession(), (error) => error instanceof ServerRequestError && error.status === 401, "the older call still reports it");
  const away = new NarrariumServerClient({ baseUrl: PAIR.baseUrl, token: "nrs_me", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => away.signOut(), (error) => error instanceof ServerRequestError && error.code === "unreachable");
  const broken = fakeServer({ sessionAnswer: () => Response.json({ code: "internal", message: "boom" }, { status: 500 }) });
  await assert.rejects(() => new NarrariumServerClient({ baseUrl: PAIR.baseUrl, token: "nrs_me", fetch: broken.fetch }).signOut(), (error) => error instanceof ServerRequestError && error.status === 500);
});
