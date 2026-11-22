import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { WebAuthnError, decodeCbor, verifyAssertion, verifyRegistration } from "../dist/testing.mjs";
import { withServer } from "./helpers.mjs";
import { mcpFixture } from "./mcp-helpers.mjs";
import { MINUTE, PUBLIC_HOST, PUBLIC_URL, adminCode, approveWithCode, approveWithPasskey, codeOf, connectApp, enrollPasskey, exchange, makeClock, registerPasskey, setPublic, startAuthorization, web } from "./oauth-helpers.mjs";
import { SoftwarePasskey, b64u, cbor, sha256 } from "./passkey-helpers.mjs";

// Passkeys (S7, phase B, R3): what the server accepts as proof that the owner is there. WebAuthn is checked here against an authenticator made of software that signs what the
// specification says to sign, with node:crypto only: ES256, RS256 and EdDSA, user presence and verification, the sign counter, and the challenge that is used once.

const ORIGIN = "https://api.example.test";
const RP = "api.example.test";
const ALGS = [["ES256", -7], ["EdDSA", -8], ["RS256", -257]];
const rejects = (action, pattern, label) => assert.throws(action, (error) => error instanceof WebAuthnError && (pattern === undefined || pattern.test(error.message)), label ?? String(pattern));

/** A registered credential, as the server keeps it. */
function registered(alg, options = {}) {
  const passkey = new SoftwarePasskey({ alg });
  const challenge = b64u(randomBytes(32));
  const credential = verifyRegistration({ response: passkey.create({ challenge, origin: ORIGIN, rpId: RP, ...options }).response, challenge, origin: ORIGIN, rpId: RP });
  return { passkey, credential };
}
const assertion = (passkey, credential, overrides = {}, options = {}) => {
  const challenge = b64u(randomBytes(32));
  const made = passkey.get({ challenge, origin: ORIGIN, rpId: RP, ...options });
  return () => verifyAssertion({ response: made.response, challenge, origin: ORIGIN, rpId: RP, publicKey: credential.publicKey, alg: credential.alg, counter: credential.counter, ...overrides });
};

// ---------------------------------------------------------------------------------------------
// CBOR: the container of the attestation and of the public key
// ---------------------------------------------------------------------------------------------

test("S7B: the CBOR reader reads what an authenticator writes (integers of every size, byte and text strings, arrays, maps with integer keys) exactly as it was encoded", () => {
  const values = [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, -1, -24, -25, -256, -257, -65537, "", "héllo ✓", Buffer.from([]), Buffer.from([0, 255, 7]), [], [1, [2, [3]]], true, false, null];
  for (const value of values) {
    const decoded = decodeCbor(cbor(value));
    if (Buffer.isBuffer(value)) assert.deepEqual(Buffer.from(decoded), value);
    else assert.deepEqual(decoded, value);
  }
  const map = decodeCbor(cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from([9, 9])], ["fmt", "none"]])));
  assert.ok(map instanceof Map);
  assert.deepEqual([map.get(1), map.get(3), map.get(-1), Buffer.from(map.get(-2)), map.get("fmt")], [2, -7, 1, Buffer.from([9, 9]), "none"]);
});

test("S7B: the CBOR reader refuses what is not plain: indefinite lengths, tags, floats, lengths that run past the data, trailing bytes, deep nesting, repeated keys", () => {
  const bad = {
    "an empty input": Buffer.alloc(0),
    "a cut integer": Buffer.from([0x19, 0x01]),
    "a cut string": Buffer.from([0x45, 1, 2]),
    "a byte string that claims four gigabytes": Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff, 1]),
    "an array that claims more items than there are bytes": Buffer.from([0x9a, 0x00, 0x10, 0x00, 0x00, 1]),
    "a map that claims more entries than there are bytes": Buffer.from([0xba, 0x00, 0x10, 0x00, 0x00, 1, 2]),
    "an indefinite byte string": Buffer.from([0x5f, 0x41, 0x01, 0xff]),
    "an indefinite array": Buffer.from([0x9f, 0x01, 0xff]),
    "an indefinite map": Buffer.from([0xbf, 0x01, 0x02, 0xff]),
    "a tag": Buffer.from([0xc1, 0x01]),
    "a half float": Buffer.from([0xf9, 0x3c, 0x00]),
    "a double": Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]),
    "undefined": Buffer.from([0xf7]),
    "an integer past 2^53": Buffer.from([0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
    "a reserved additional information": Buffer.from([0x1c]),
    "trailing bytes": Buffer.concat([cbor(1), Buffer.from([0])]),
    "nesting that is too deep": Buffer.concat([Buffer.alloc(40, 0x81), Buffer.from([0])]),
    "the same key twice": Buffer.concat([Buffer.from([0xa2]), cbor(1), cbor(2), cbor(1), cbor(3)]),
    "a key that is neither an integer nor a text": Buffer.concat([Buffer.from([0xa1]), cbor(Buffer.from([1])), cbor(1)]),
  };
  for (const [name, bytes] of Object.entries(bad)) rejects(() => decodeCbor(bytes), undefined, name);
  assert.equal(decodeCbor(Buffer.concat([Buffer.alloc(8, 0x81), Buffer.from([0])])) !== undefined, true, "eight levels are fine");
});

// ---------------------------------------------------------------------------------------------
// Registration: what is read of a new credential
// ---------------------------------------------------------------------------------------------

const authData = (passkey, { rpId = RP, flags = 0x45, counter = 0, cose, extra = Buffer.alloc(0), credentialId = passkey.credentialId } = {}) => {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, Buffer.alloc(16), Buffer.from([credentialId.length >> 8, credentialId.length & 255]), credentialId, cose ?? passkey.cose(), extra]);
};

test("S7B: a registration with attestation none yields the credential id, the public key, the algorithm, the counter and the transports, for each algorithm the server accepts", () => {
  for (const [name, alg] of ALGS) {
    const { passkey, credential } = registered(alg, { transports: ["internal", "hybrid"], counter: 0 });
    assert.equal(credential.credentialId, passkey.id, name);
    assert.equal(credential.alg, alg, name);
    assert.equal(credential.counter, 0, name);
    assert.deepEqual(credential.transports, ["internal", "hybrid"], name);
    assert.match(credential.publicKey, /^[A-Za-z0-9_-]+$/, `${name}: SPKI, base64url`);
    assert.doesNotThrow(assertion(passkey, credential), `${name}: and the key that was read verifies what the authenticator signs`);
  }
  const first = registered(-7, { counter: 41 });
  assert.equal(first.credential.counter, 41, "an authenticator that already counts says where it is");
  const odd = registered(-7, { transports: ["internal", "carrier-pigeon", 5, "usb", "usb"] });
  assert.deepEqual(odd.credential.transports, ["internal", "usb"], "only the transports that exist, once");
});

test("S7B: a registration whose proof is wrong is refused: challenge, origin, relying party, type, presence, verification, attested data, cross-origin use", () => {
  const base = (passkey, overrides = {}, options = {}) => {
    const challenge = b64u(randomBytes(32));
    const made = passkey.create({ challenge, origin: ORIGIN, rpId: RP, ...options });
    return () => verifyRegistration({ response: made.response, challenge, origin: ORIGIN, rpId: RP, ...overrides });
  };
  const passkey = new SoftwarePasskey();
  assert.doesNotThrow(base(passkey));
  rejects(base(passkey, { challenge: b64u(randomBytes(32)) }), /challenge/i);
  rejects(base(passkey, { origin: "https://evil.example" }), /origin/i);
  rejects(base(passkey, { rpId: "evil.example" }), /relying party|rp/i);
  rejects(base(passkey, {}, { type: "webauthn.get" }), /type/i);
  rejects(base(passkey, {}, { flags: 0x44 }), /presen/i);
  rejects(base(passkey, {}, { flags: 0x41 }), /verif/i);
  rejects(base(passkey, {}, { flags: 0x05 }), /credential data|attested/i);
  rejects(base(passkey, {}, { clientData: { crossOrigin: true } }), /cross/i);
  rejects(base(passkey, {}, { clientData: { topOrigin: "https://evil.example" } }), /cross|top/i);
  rejects(base(passkey, {}, { clientData: { origin: "android:apk-key-hash:abc" } }), /origin/i);
  rejects(base(passkey, { response: { clientDataJSON: b64u("not json"), attestationObject: b64u(cbor(new Map())) } }), undefined);
  rejects(base(passkey, { response: { clientDataJSON: b64u("x".repeat(5000)), attestationObject: "" } }), undefined);
  rejects(base(passkey, { response: null }), undefined);
  rejects(base(passkey, { challenge: 5 }), undefined);

  const attest = (data, fmt = "none") => ({ clientDataJSON: undefined, attestationObject: b64u(cbor(new Map([["fmt", fmt], ["attStmt", new Map()], ["authData", data]]))) });
  const withData = (data, extra = {}) => {
    const challenge = b64u(randomBytes(32));
    const made = passkey.create({ challenge, origin: ORIGIN, rpId: RP });
    return () => verifyRegistration({ response: { ...made.response, attestationObject: attest(data, extra.fmt).attestationObject }, challenge, origin: ORIGIN, rpId: RP });
  };
  assert.doesNotThrow(withData(authData(passkey)));
  assert.doesNotThrow(withData(authData(passkey), { fmt: "packed" }), "attestation is not asked for and is not judged");
  assert.doesNotThrow(withData(authData(passkey, { flags: 0xc5, extra: cbor(new Map([["credProps", new Map([["rk", true]])]])) })), "extensions after the key, when the flag says so");
  rejects(withData(authData(passkey, { extra: Buffer.from([1, 2, 3]) })), /trailing|extra/i);
  rejects(withData(authData(passkey).subarray(0, 40)), undefined);
  rejects(withData(authData(passkey, { credentialId: Buffer.alloc(0) })), /credential id/i);
  rejects(withData(authData(passkey, { credentialId: randomBytes(1100) })), /credential id/i);
  rejects(withData(Buffer.concat([authData(passkey).subarray(0, 37 + 16), Buffer.from([0x03, 0xff])])), undefined);

  const rawAttestation = (value) => () => {
    const challenge = b64u(randomBytes(32));
    const made = passkey.create({ challenge, origin: ORIGIN, rpId: RP });
    return verifyRegistration({ response: { ...made.response, attestationObject: b64u(value) }, challenge, origin: ORIGIN, rpId: RP });
  };
  rejects(rawAttestation(cbor([1, 2])), undefined);
  rejects(rawAttestation(cbor(new Map([["fmt", "none"]]))), undefined);
  rejects(rawAttestation(cbor(new Map([["authData", "text"]]))), undefined);
});

test("S7B: a public key is accepted only in the forms the server can check: ES256 on P-256, EdDSA on Ed25519, RS256 with a modulus of 2048 bits or more", () => {
  const challenge = () => b64u(randomBytes(32));
  const using = (passkey, cose) => () => {
    const value = challenge();
    return verifyRegistration({ response: passkey.create({ challenge: value, origin: ORIGIN, rpId: RP, cose }).response, challenge: value, origin: ORIGIN, rpId: RP });
  };
  const ec = new SoftwarePasskey({ alg: -7 });
  const jwk = ec.publicKey.export({ format: "jwk" });
  const part = (name) => Buffer.from(jwk[name], "base64url");
  assert.doesNotThrow(using(ec, ec.cose()));
  rejects(using(ec, cbor(new Map([[1, 2], [3, -35], [-1, 2], [-2, part("x")], [-3, part("y")]]))), /algorithm/i);
  rejects(using(ec, cbor(new Map([[1, 2], [3, -7], [-1, 2], [-2, part("x")], [-3, part("y")]]))), /curve/i);
  rejects(using(ec, cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, part("x").subarray(1)], [-3, part("y")]]))), /coordinate|length|key/i);
  rejects(using(ec, cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, part("x")]]))), /key/i);
  rejects(using(ec, cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 1)]]))), /key/i);
  rejects(using(ec, cbor(new Map([[1, 3], [3, -7], [-1, 1], [-2, part("x")], [-3, part("y")]]))), /type|key/i);
  rejects(using(ec, cbor(new Map([[3, -7]]))), undefined);
  rejects(using(ec, cbor([1])), undefined);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
  rejects(using(ec, cbor(new Map([[1, 3], [3, -257], [-1, Buffer.from(rsa.n, "base64url")], [-2, Buffer.from(rsa.e, "base64url")]]))), /2048|small|weak/i);
  const ed = new SoftwarePasskey({ alg: -8 });
  const edJwk = ed.publicKey.export({ format: "jwk" });
  rejects(using(ed, cbor(new Map([[1, 1], [3, -8], [-1, 7], [-2, Buffer.from(edJwk.x, "base64url")]]))), /curve/i);
  rejects(using(ed, cbor(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.alloc(31)]]))), /key|length/i);
  assert.doesNotThrow(using(new SoftwarePasskey({ alg: -257 }), undefined));
});

// ---------------------------------------------------------------------------------------------
// Assertion: what is read of a sign-in
// ---------------------------------------------------------------------------------------------

test("S7B: an assertion that is right is accepted for each algorithm, and gives the new counter", () => {
  for (const [name, alg] of ALGS) {
    const { passkey, credential } = registered(alg);
    assert.deepEqual(assertion(passkey, credential)(), { counter: 1 }, name);
    assert.deepEqual(assertion(passkey, credential, { counter: 1 })(), { counter: 2 }, name);
  }
});

test("S7B: an assertion that is wrong is refused: challenge, origin, relying party, type, presence, verification, cross-origin use, and every way to alter what was signed", () => {
  for (const [name, alg] of ALGS) {
    const { passkey, credential } = registered(alg);
    const fail = (overrides, options, pattern) => rejects(assertion(passkey, credential, overrides, options), pattern);
    assert.doesNotThrow(assertion(passkey, credential), name);
    fail({ challenge: b64u(randomBytes(32)) }, {}, /challenge|signature/i);
    fail({ origin: "https://evil.example" }, {}, /origin/i);
    fail({ rpId: "evil.example" }, {}, /relying party|rp/i);
    fail({}, { type: "webauthn.create" }, /type/i);
    fail({}, { flags: 0x04 }, /presen/i);
    fail({}, { flags: 0x01 }, /verif/i);
    fail({}, { flags: 0x00 }, /presen/i);
    fail({}, { clientData: { crossOrigin: true } }, /cross/i);
    fail({}, { clientData: { topOrigin: ORIGIN } }, /cross|top/i);
    fail({ publicKey: registered(alg).credential.publicKey }, {}, /signature/i);
    fail({ alg: alg === -7 ? -8 : -7 }, {}, /signature|algorithm|key/i);
    fail({ alg: -36 }, {}, /algorithm/i);
  }
  const { passkey, credential } = registered(-7);
  const challenge = b64u(randomBytes(32));
  const made = passkey.get({ challenge, origin: ORIGIN, rpId: RP });
  const verify = (response) => () => verifyAssertion({ response, challenge, origin: ORIGIN, rpId: RP, publicKey: credential.publicKey, alg: credential.alg, counter: 0 });
  assert.doesNotThrow(verify(made.response));
  const flip = (field, byte = 10) => {
    const bytes = Buffer.from(made.response[field], "base64url");
    bytes[byte % bytes.length] ^= 1;
    return { ...made.response, [field]: b64u(bytes) };
  };
  rejects(verify(flip("signature")), /signature/i);
  rejects(verify(flip("authenticatorData", 33)), /signature|counter/i);
  rejects(verify(flip("clientDataJSON", 3)), undefined);
  rejects(verify({ ...made.response, signature: "" }), undefined);
  rejects(verify({ ...made.response, signature: b64u(Buffer.from(made.response.signature, "base64url").subarray(0, 30)) }), undefined);
  const raw = Buffer.alloc(64, 7);
  rejects(verify({ ...made.response, signature: b64u(raw) }), /signature/i);
  rejects(verify({ ...made.response, authenticatorData: b64u(Buffer.alloc(10)) }), undefined);
  rejects(verify({ ...made.response, clientDataJSON: b64u("x".repeat(5000)) }), undefined);
  rejects(verify({ ...made.response, clientDataJSON: undefined }), undefined);
  rejects(verify({ ...made.response, signature: 5 }), undefined);
  rejects(verify(null), undefined);
});

test("S7B: the sign counter must go up, unless the authenticator has none (zero before and after): a counter that stands still or goes back is a copy of the key", () => {
  const { passkey, credential } = registered(-7);
  const at = (stored, sent) => assertion(passkey, credential, { counter: stored }, { counter: sent });
  assert.deepEqual(at(5, 6)(), { counter: 6 });
  assert.deepEqual(at(5, 1000)(), { counter: 1000 });
  assert.deepEqual(at(0, 3)(), { counter: 3 }, "an authenticator that starts counting");
  assert.deepEqual(at(0, 0)(), { counter: 0 }, "one that never counts");
  rejects(at(5, 5), /counter/i);
  rejects(at(5, 4), /counter/i);
  rejects(at(5, 0), /counter/i);
  rejects(at(1, 0), /counter/i);
});

// ---------------------------------------------------------------------------------------------
// Through the server: the challenge is single use and short, the decision is bound to it, the credential must be for this host
// ---------------------------------------------------------------------------------------------

const prepared = async (server, client, options = {}) => {
  const { slug } = await mcpFixture(server, client);
  await setPublic(server);
  const passkey = new SoftwarePasskey(options);
  await enrollPasskey(server, passkey, { slug });
  return { slug, passkey, w: web(server, { host: PUBLIC_HOST }) };
};

test("S7B: a passkey challenge is used once, whatever happened to the answer, and lives two minutes", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug, passkey, w } = await prepared(server, client);
    const header = (page) => ({ "x-csrf-token": page.csrf });
    const ask = async (page) => (await w.post("/oauth/authorize/challenge", { json: { requestId: page.requestId, scopes: ["read"] }, headers: header(page) })).json.publicKey;
    const send = (page, credential) => w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, proof: { type: "passkey", credential } }, headers: header(page) });

    const { page } = await startAuthorization(w, { slug });
    const options = await ask(page);
    assert.deepEqual([options.rpId, options.userVerification], [PUBLIC_HOST, "required"]);
    assert.deepEqual(options.allowCredentials.map((entry) => [entry.type, entry.id]), [["public-key", passkey.id]]);
    assert.ok(options.timeout <= 120_000);

    const wrong = passkey.get({ challenge: options.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST, flags: 0x01 });
    const refused = await send(page, wrong);
    assert.equal(refused.status, 401);
    assert.equal(refused.json.code, "passkey_invalid");
    assert.doesNotMatch(refused.text, /presen|verif|flag/i, "it does not say what was wrong: that would be an oracle");
    const right = passkey.get({ challenge: options.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST });
    const spent = await send(page, right);
    assert.equal(spent.status, 409, "the challenge went with the first answer, right or wrong");
    assert.equal(spent.json.code, "challenge_expired");

    const next = await ask(page);
    clock.advance(2 * MINUTE + 1000);
    const late = await send(page, passkey.get({ challenge: next.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }));
    assert.deepEqual([late.status, late.json.code], [409, "challenge_expired"], "two minutes is the most");

    const third = await ask(page);
    clock.advance(60 * 1000);
    assert.equal((await send(page, passkey.get({ challenge: third.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }))).status, 200, "a minute is in time");

    const unasked = await startAuthorization(w, { slug });
    const none = await send(unasked.page, passkey.get({ challenge: b64u(randomBytes(32)), origin: PUBLIC_URL, rpId: PUBLIC_HOST }));
    assert.deepEqual([none.status, none.json.code], [409, "challenge_expired"], "an answer to a challenge that was never given");
  }, { now: clock.now });
});

test("S7B: what the owner chose is bound to the challenge: changing the scopes or the book between the challenge and the answer changes nothing", async () => {
  await withServer(async (server, client) => {
    const { slug, passkey, w } = await prepared(server, client);
    const { page, app, verifier, resource, redirectUri } = await startAuthorization(w, { slug, scope: "mcp:read mcp:write" });
    const options = (await w.post("/oauth/authorize/challenge", { json: { requestId: page.requestId, scopes: ["read"] }, headers: { "x-csrf-token": page.csrf } })).json.publicKey;
    const credential = passkey.get({ challenge: options.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST });
    const approved = await w.post("/oauth/authorize/approve", { json: { requestId: page.requestId, scopes: ["read", "write"], book: "another-book", proof: { type: "passkey", credential } }, headers: { "x-csrf-token": page.csrf } });
    assert.equal(approved.status, 200, approved.text);
    const tokens = await exchange(w, { code: codeOf(approved.json.redirect), verifier, clientId: app.client_id, redirectUri, resource });
    assert.equal(tokens.json.scope, "mcp:read", "what he agreed to when he tapped, not what the page said afterwards");
  });
});

test("S7B: a passkey that is not registered, a counter that went back, and an assertion for another host are refused, and a refusal does not move the counter", async () => {
  await withServer(async (server, client) => {
    const { slug, passkey, w } = await prepared(server, client);
    const attempt = async (key, options = {}) => {
      const { page } = await startAuthorization(w, { slug });
      return approveWithPasskey(w, page, { passkey: key, scopes: ["read"], ...options });
    };
    assert.equal((await attempt(passkey)).status, 200, "counter 1");
    assert.equal((await attempt(passkey)).status, 200, "counter 2");
    const stranger = await attempt(new SoftwarePasskey());
    assert.deepEqual([stranger.status, stranger.json.code], [401, "passkey_invalid"], "a credential the server does not have");
    passkey.counter = 1;
    const cloned = await attempt({ get: (parameters) => passkey.get({ ...parameters, counter: 1 }), id: passkey.id });
    assert.deepEqual([cloned.status, cloned.json.code], [401, "passkey_invalid"], "counter 1 again: a copy");
    passkey.counter = 2;
    assert.equal((await attempt(passkey)).status, 200, "counter 3: the real one goes on, as if nothing happened");
    const origin = await attempt(passkey, { origin: "https://evil.example" });
    assert.equal(origin.status, 401, "an answer given on another origin");
    const rp = await attempt(passkey, { rpId: "evil.example" });
    assert.equal(rp.status, 401, "an answer for another relying party");
  });
});

test("S7B: ES256, EdDSA and RS256 passkeys all work at the consent page, next to each other", async () => {
  await withServer(async (server, client) => {
    const { slug, passkey, w } = await prepared(server, client);
    const others = [new SoftwarePasskey({ alg: -8 }), new SoftwarePasskey({ alg: -257 })];
    for (const other of others) {
      const offered = await connectApp(server, { slug, w, name: "Enrolling" });
      const options = await w.post("/oauth/passkeys/options", { json: { ticket: offered.approved.passkeyOffer.ticket } });
      assert.ok(options.json.publicKey.excludeCredentials.length >= 1, "what the owner already has is not offered again");
      assert.equal((await registerPasskey(w, offered.approved.passkeyOffer.ticket, other)).status, 200);
    }
    for (const key of [passkey, ...others]) {
      const connected = await connectApp(server, { slug, w, passkey: key });
      assert.equal(connected.tokens.token_type, "Bearer");
    }
  });
});

test("S7B: a passkey is registered only with a ticket, only for this host, only when it proves user verification, and never twice", async () => {
  const clock = makeClock();
  await withServer(async (server, client) => {
    const { slug, passkey, w } = await prepared(server, client);
    const ticketOf = async () => (await connectApp(server, { slug, w, name: "Enrolling" })).approved.passkeyOffer.ticket;
    const options = async (ticket) => (await w.post("/oauth/passkeys/options", { json: { ticket } })).json.publicKey;
    const register = (ticket, credential, label = "Phone") => w.post("/oauth/passkeys/register", { json: { ticket, label, credential } });
    const key = () => new SoftwarePasskey();

    const missing = await w.post("/oauth/passkeys/options", { json: { ticket: "nonsense" } });
    assert.deepEqual([missing.status, missing.json.code], [404, "ticket_invalid"]);
    assert.equal((await w.post("/oauth/passkeys/options", { json: {} })).status, 400);

    const refusals = [
      ["another origin", (challenge) => key().create({ challenge, origin: "https://evil.example", rpId: PUBLIC_HOST })],
      ["another relying party", (challenge) => key().create({ challenge, origin: PUBLIC_URL, rpId: "evil.example" })],
      ["no user verification", (challenge) => key().create({ challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST, flags: 0x41 })],
      ["another challenge", () => key().create({ challenge: b64u(randomBytes(32)), origin: PUBLIC_URL, rpId: PUBLIC_HOST })],
    ];
    for (const [name, make] of refusals) {
      const ticket = await ticketOf();
      const asked = await options(ticket);
      const refused = await register(ticket, make(asked.challenge));
      assert.deepEqual([refused.status, refused.json.code], [400, "passkey_invalid"], name);
      const again = await register(ticket, key().create({ challenge: asked.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }));
      assert.deepEqual([again.status, again.json.code], [409, "challenge_expired"], `${name}: the challenge went with the first answer; the ticket did not`);
      const fresh = await options(ticket);
      assert.equal((await register(ticket, key().create({ challenge: fresh.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }))).status, 200, `${name}: a new challenge for the same ticket works`);
    }

    const ticket = await ticketOf();
    const asked = await options(ticket);
    const duplicate = await register(ticket, passkey.create({ challenge: asked.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }));
    assert.deepEqual([duplicate.status, duplicate.json.code], [409, "passkey_exists"], "the first passkey cannot be registered again");

    const late = await ticketOf();
    const lateOptions = await options(late);
    clock.advance(11 * MINUTE);
    const expired = await register(late, key().create({ challenge: lateOptions.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }));
    assert.deepEqual([expired.status, expired.json.code], [404, "ticket_invalid"], "a ticket lasts ten minutes");

    const cross = await web(server, { host: PUBLIC_HOST }).post("/oauth/passkeys/options", { json: { ticket: await ticketOf() }, origin: "https://evil.example" });
    assert.equal(cross.status, 403, "from another site: refused before the ticket is looked at");
  }, { now: clock.now });
});

test("S7B: a passkey on this computer's own address is not possible: a relying party cannot be an IP address, and the owner is told to use the admin code", async () => {
  await withServer(async (server, client) => {
    const { slug } = await mcpFixture(server, client);
    const local = web(server);
    const started = await startAuthorization(local, { slug });
    assert.equal(started.page.passkeys.available, false);
    assert.match(started.html, /admin code|codice admin/i, "the page still offers the way that works here");
    const answer = await approveWithCode(local, started.page, { code: await adminCode(server) });
    assert.equal(answer.status, 200);
    assert.equal((await local.post("/oauth/passkeys/options", { json: { ticket: "x" } })).status, 404);
    const page = await local.get("/oauth/passkeys/add");
    assert.equal(page.status, 200);
    assert.match(page.text, /public address|indirizzo pubblico/i, "the page for adding a passkey says why it cannot be done here");
  });
});
