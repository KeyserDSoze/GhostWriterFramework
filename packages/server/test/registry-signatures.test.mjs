import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify as verifySignature } from "node:crypto";
import * as server from "../dist/testing.mjs";
import {
  REAL_OLD_KEY_SIGNATURE,
  REAL_RELEASE,
  REAL_REGISTRY_KEYS,
  REAL_VERSION,
  REGISTRY_KEY,
  fakeRegistry,
  forgeRelease,
  integrityFor,
  keyEntry,
  keysDocument,
  keysUrl,
  makeRegistryKey,
  packumentUrl,
  registrySignature,
  signedVersionDocument,
  silence,
  versionUrl,
} from "./release-fixtures.mjs";

// The new exports are read from the namespace: before they exist each test fails by itself instead of breaking the whole file.
const { NpmRegistryKeyring, RegistrySignatureError, RegistryUnreadableError, parseNpmRegistryKeys, verifyNpmRegistrySignatures } = server;

// What the server checks of a release itself, whatever npm the machine has: the registry's signature of it. `dist.signatures` of the version's document is an ECDSA
// P-256 SHA-256 signature of `narrarium-server@<version>:<integrity>`, made with a key that the registry lists at /-/npm/v1/keys. The real key of the registry cannot
// be had offline, so these tests make one (see release-fixtures.mjs) and a registry that lists it.

const VERSION = "0.2.0";
const release = forgeRelease(VERSION);
const NOW = () => new Date("2026-11-22T12:00:00.000Z");
const LONG_AGO = "2025-01-29T00:00:00.000Z";
const json = (body, status = 200, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

/** The registry, answering for the release: its document is signed with `signatures` (or is `document`), it lists `keys`, and says it was `published` at that time. */
function registry({ signatures, document, keys, published, routes = {} } = {}) {
  const served = document !== undefined ? document : signatures === undefined ? undefined : signedVersionDocument(release, signatures);
  return fakeRegistry({
    releases: [release],
    latest: VERSION,
    keys,
    published: published ? { [VERSION]: published } : {},
    routes: { ...(served !== undefined ? { [versionUrl(VERSION)]: () => json(served) } : {}), ...routes },
  });
}

const verify = (reg, options = {}, integrity = release.integrity, version = VERSION) => verifyNpmRegistrySignatures(version, integrity, reg.fetch, { now: NOW, ...options });

const rejected = (pattern) => (error) => {
  assert.ok(error instanceof RegistrySignatureError, `a RegistrySignatureError, not ${error?.name}: ${error?.message}`);
  assert.equal(error.name, "RegistrySignatureError");
  assert.equal(typeof error.reason, "string");
  assert.ok(error.message.includes(error.reason), "the message says the reason");
  assert.match(error.message, pattern);
  return true;
};
const unreadable = (pattern) => (error) => {
  assert.ok(error instanceof RegistryUnreadableError, `a RegistryUnreadableError, not ${error?.name}: ${error?.message}`);
  assert.equal(error.name, "RegistryUnreadableError");
  assert.match(error.message, pattern);
  return true;
};

const good = registrySignature(REGISTRY_KEY, VERSION, release.integrity);
const expiredKey = keyEntry(REGISTRY_KEY, { expires: LONG_AGO });

// ─── A genuine signature ───────────────────────────────────────────────────

test("S8 registry: a release signed with a key the registry lists is accepted; the server reads the document of the release and the list of keys, the way it reads the registry everywhere: GET, no redirect, no credentials, no cache", async () => {
  const reg = registry();
  assert.equal(await verify(reg), undefined);
  assert.deepEqual(reg.urls(), [versionUrl(VERSION), keysUrl], "nothing else: the publication date is read only when a key has expired");
  for (const { init } of reg.requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error", "a redirect is never followed");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).has("authorization"), false, "no credential reaches the registry");
    assert.equal(new Headers(init.headers).get("accept"), "application/json");
    assert.ok(init.signal instanceof AbortSignal, "every read has a timeout");
  }
});

test("S8 registry: the signature is of the package name, the version and the integrity together, so every version the workflow publishes passes with its own and none with another's", async () => {
  for (const version of ["0.1.3", "0.2.0", "1.0.0"]) {
    const other = forgeRelease(version);
    const reg = fakeRegistry({ releases: [other], latest: version });
    assert.equal(await verifyNpmRegistrySignatures(version, other.integrity, reg.fetch, { now: NOW }), undefined, version);
  }
  const next = forgeRelease("0.3.0");
  const replayed = fakeRegistry({ releases: [next], latest: "0.3.0", routes: { [versionUrl("0.3.0")]: () => json(signedVersionDocument(next, release.packument.dist.signatures)) } });
  await assert.rejects(() => verifyNpmRegistrySignatures("0.3.0", next.integrity, replayed.fetch, { now: NOW }), rejected(/not valid/), "the signature of 0.2.0 on the document of 0.3.0");
});

test("S8 registry: a release that carries two signatures by one key, as the registry gives them, has both checked: one that is not valid refuses it", async () => {
  const again = registrySignature(REGISTRY_KEY, VERSION, release.integrity);
  assert.equal(await verify(registry({ signatures: [good, again] })), undefined);
  const bad = registrySignature(REGISTRY_KEY, VERSION, integrityFor("another tarball"));
  await assert.rejects(() => verify(registry({ signatures: [good, bad] })), rejected(/not valid/));
  await assert.rejects(() => verify(registry({ signatures: [bad, good] })), rejected(/not valid/), "whatever the order");
});

test("S8 registry: the real signed document of narrarium-server@0.1.2 (two signatures, one key) is read; its key is not one this test has, so it is refused, and a listed key under the same id does not make it pass", async () => {
  const realKeyId = REAL_RELEASE.packument.dist.signatures[0].keyid;
  assert.equal(REAL_RELEASE.packument.dist.signatures.length, 2, "the registry really gives two entries");
  const serving = (keys) => fakeRegistry({ releases: [REAL_RELEASE], latest: REAL_VERSION, keys, routes: { [versionUrl(REAL_VERSION)]: () => json(REAL_RELEASE.packument) } });
  const unknown = serving([keyEntry(REGISTRY_KEY)]);
  await assert.rejects(() => verifyNpmRegistrySignatures(REAL_VERSION, REAL_RELEASE.integrity, unknown.fetch, { now: NOW }), (error) => rejected(/does not list/)(error) && error.message.includes(realKeyId));
  const impostor = serving([{ ...keyEntry(REGISTRY_KEY), keyid: realKeyId }]);
  await assert.rejects(() => verifyNpmRegistrySignatures(REAL_VERSION, REAL_RELEASE.integrity, impostor.fetch, { now: NOW }), rejected(/not valid/), "a key id proves nothing: the signature is checked with the key");
});

test("S8 registry: the real signatures of the real narrarium-server@0.1.2 verify against the registry's real keys: the whole check runs on data that the registry itself produced", async () => {
  const serving = (keys, document = REAL_RELEASE.packument) => fakeRegistry({ releases: [REAL_RELEASE], latest: REAL_VERSION, keys, routes: { [versionUrl(document.version)]: () => json(document) } });
  const check = (reg, integrity = REAL_RELEASE.integrity, version = REAL_VERSION) => verifyNpmRegistrySignatures(version, integrity, reg.fetch, { now: NOW });
  assert.equal(REAL_RELEASE.packument.dist.signatures.length, 2, "the registry really gives two signatures, by one key");

  const real = serving(REAL_REGISTRY_KEYS);
  assert.equal(await check(real), undefined, "both real signatures verify with the real key");
  assert.deepEqual(real.urls(), [versionUrl(REAL_VERSION), keysUrl], "the current key never expires: no date is read");
  assert.equal(await check(serving(REAL_REGISTRY_KEYS.slice().reverse())), undefined, "whatever the order of the list");

  // The same real data, altered one thing at a time.
  const dist = REAL_RELEASE.packument.dist;
  const withSignatures = (signatures) => ({ ...REAL_RELEASE.packument, dist: { ...dist, signatures } });
  const flipped = Buffer.from(dist.signatures[0].sig, "base64");
  flipped[flipped.length - 1] ^= 0x01;
  await assert.rejects(() => check(serving(REAL_REGISTRY_KEYS, withSignatures([{ ...dist.signatures[0], sig: flipped.toString("base64") }, dist.signatures[1]]))), rejected(/not valid/), "one signature with a bit changed");
  await assert.rejects(() => check(serving(REAL_REGISTRY_KEYS, withSignatures([dist.signatures[0], { ...dist.signatures[1], keyid: REAL_REGISTRY_KEYS[0].keyid }]))), rejected(/not valid/), "a real signature under the old key's id");
  await assert.rejects(() => check(serving(REAL_REGISTRY_KEYS, { ...REAL_RELEASE.packument, version: "0.1.3" }), REAL_RELEASE.integrity, "0.1.3"), rejected(/not valid/), "the real signatures, claimed for the next version");
  await assert.rejects(() => check(serving(REAL_REGISTRY_KEYS), integrityFor("another tarball")), rejected(/another tarball/), "another tarball than the one the registry signed");
  await assert.rejects(() => check(serving([REAL_REGISTRY_KEYS[0]])), rejected(/does not list/), "a list that has only the old key");
  await assert.rejects(() => check(serving([])), rejected(/does not list/), "a list with no key");
});

test("S8 registry: the registry's real list of keys is read as it is: two keys, the old one with the date it expired, and a real signature by the old key verifies with the key that was read", () => {
  const parsed = parseNpmRegistryKeys({ keys: REAL_REGISTRY_KEYS });
  assert.deepEqual(parsed.map((key) => [key.keyid, key.expires]), [[REAL_REGISTRY_KEYS[0].keyid, Date.parse("2025-01-29T00:00:00.000Z")], [REAL_REGISTRY_KEYS[1].keyid, undefined]]);
  const real = REAL_OLD_KEY_SIGNATURE;
  const old = parsed.find((key) => key.keyid === real.keyid);
  const message = Buffer.from(`${real.name}@${real.version}:${real.integrity}`);
  assert.equal(verifySignature("sha256", message, { key: old.key, dsaEncoding: "der" }, Buffer.from(real.sig, "base64")), true, "a real signature of the registry, by its old key: the message is name@version:integrity");
  assert.equal(verifySignature("sha256", Buffer.from(`${real.name}@1.0.1:${real.integrity}`), { key: old.key, dsaEncoding: "der" }, Buffer.from(real.sig, "base64")), false);
  const current = parsed.find((key) => key.keyid === REAL_REGISTRY_KEYS[1].keyid);
  assert.equal(verifySignature("sha256", message, { key: current.key, dsaEncoding: "der" }, Buffer.from(real.sig, "base64")), false, "and not by the current one");
});

// ─── A signature that is not genuine ───────────────────────────────────────

test("S8 registry: a signature that was not made for this very package, version and tarball by a listed key is refused", async () => {
  const stranger = makeRegistryKey();
  const bytes = Buffer.from(good.sig, "base64");
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] ^= 0x01;
  const message = Buffer.from(`narrarium-server@${VERSION}:${release.integrity}`);
  const raw = sign("sha256", message, { key: REGISTRY_KEY.privateKey, dsaEncoding: "ieee-p1363" });
  const cases = [
    ["a signature made for another tarball", [registrySignature(REGISTRY_KEY, VERSION, integrityFor("another tarball"))]],
    ["a signature of another version, replayed", [registrySignature(REGISTRY_KEY, "0.2.1", release.integrity)]],
    ["a signature of another package", [registrySignature(REGISTRY_KEY, VERSION, release.integrity, "other-package")]],
    ["a signature by another key under the id of the listed one", [{ keyid: REGISTRY_KEY.keyid, sig: registrySignature(stranger, VERSION, release.integrity).sig }]],
    ["a signature with one bit changed", [{ keyid: good.keyid, sig: flipped.toString("base64") }]],
    ["a signature in the raw r||s form instead of DER", [{ keyid: good.keyid, sig: raw.toString("base64") }]],
    ["a signature that is only bytes", [{ keyid: good.keyid, sig: Buffer.alloc(71, 7).toString("base64") }]],
    ["a signature that is a single byte", [{ keyid: good.keyid, sig: Buffer.from([0x30]).toString("base64") }]],
    ["a signature of a message with the parts in another order", [{ keyid: good.keyid, sig: sign("sha256", Buffer.from(`${release.integrity}:narrarium-server@${VERSION}`), REGISTRY_KEY.privateKey).toString("base64") }]],
  ];
  for (const [name, signatures] of cases) {
    await assert.rejects(() => verify(registry({ signatures })), rejected(/not valid/), name);
  }
});

test("S8 registry: a document that is not the release's, or that announces another tarball than the one about to be trusted, is refused whatever it is signed with", async () => {
  const signed = (patch) => ({ ...signedVersionDocument(release), ...patch });
  const dist = (patch) => ({ ...signedVersionDocument(release).dist, ...patch });
  const cases = [
    ["a document of another package", signed({ name: "other-package" }), /not about this release/],
    ["a document of another version", signed({ version: "0.2.1" }), /not about this release/],
    ["a document without a version", signed({ version: undefined }), /not about this release/],
    ["a document that is a list", [signedVersionDocument(release)], /not about this release/],
    ["a document that is null", null, /not about this release/],
    ["a document without dist", signed({ dist: undefined }), /another tarball/],
    ["a document without an integrity", signed({ dist: dist({ integrity: undefined }) }), /another tarball/],
    ["a document with the integrity of another tarball", signed({ dist: dist({ integrity: integrityFor("another tarball") }) }), /another tarball/],
    ["a document whose integrity is not a sha512 value", signed({ dist: dist({ integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }) }), /another tarball/],
  ];
  for (const [name, document, pattern] of cases) {
    await assert.rejects(() => verify(registry({ document })), rejected(pattern), name);
  }
  await assert.rejects(() => verify(registry(), {}, integrityFor("a tarball npm did not announce")), rejected(/another tarball/), "the integrity that was judged is the one the registry signed");
});

test("S8 registry: a release without signatures, or whose signatures cannot be read, is refused", async () => {
  const cases = [
    ["no signatures property", undefined, /no registry signature/],
    ["an empty list", [], /no registry signature/],
    ["a list that is an object", { 0: good }, /no registry signature/],
    ["a list that is text", good.sig, /no registry signature/],
    ["a list that is null", null, /no registry signature/],
    ["nine signatures", Array.from({ length: 9 }, () => good), /too many/],
    ["an entry that is null", [null], /malformed/],
    ["an entry that is text", [good.sig], /malformed/],
    ["an entry without a key id", [{ sig: good.sig }], /malformed/],
    ["an entry with an empty key id", [{ keyid: "", sig: good.sig }], /malformed/],
    ["an entry whose key id is not text", [{ keyid: 7, sig: good.sig }], /malformed/],
    ["an entry whose key id is 300 characters long", [{ keyid: "k".repeat(300), sig: good.sig }], /malformed/],
    ["an entry without a signature", [{ keyid: good.keyid }], /malformed/],
    ["an entry with an empty signature", [{ keyid: good.keyid, sig: "" }], /malformed/],
    ["an entry whose signature is not text", [{ keyid: good.keyid, sig: 12345 }], /malformed/],
    ["a signature that is not base64", [{ keyid: good.keyid, sig: "not base64 at all!" }], /malformed/],
    ["a signature with a line break inside", [{ keyid: good.keyid, sig: `${good.sig.slice(0, 20)}\n${good.sig.slice(20)}` }], /malformed/],
    ["a signature of 300 characters", [{ keyid: good.keyid, sig: "A".repeat(300) }], /malformed/],
    ["a good signature next to a malformed entry", [good, { keyid: good.keyid }], /malformed/],
  ];
  for (const [name, signatures, pattern] of cases) {
    await assert.rejects(() => verify(registry({ document: { ...signedVersionDocument(release), dist: { ...signedVersionDocument(release).dist, signatures } } })), rejected(pattern), name);
  }
  assert.equal(await verify(registry({ signatures: Array.from({ length: 8 }, () => good) })), undefined, "eight is the most the server reads");
});

test("S8 registry: a signature by a key the registry does not list is refused, even beside a valid one, and so is a list of keys that has none", async () => {
  const stranger = makeRegistryKey();
  const strange = registrySignature(stranger, VERSION, release.integrity);
  const named = (error) => rejected(/does not list/)(error) && error.message.includes(stranger.keyid);
  await assert.rejects(() => verify(registry({ signatures: [strange] })), named, "a genuine signature of a key nobody lists");
  await assert.rejects(() => verify(registry({ signatures: [good, strange] })), named, "one signature that cannot be checked is enough");
  await assert.rejects(() => verify(registry({ signatures: [strange, good] })), named);
  await assert.rejects(() => verify(registry({ keys: [] })), rejected(/does not list/), "the registry lists no key");
  await assert.rejects(() => verify(registry({ keys: [keyEntry(stranger)] })), rejected(/does not list/), "it lists other keys");
  assert.equal(await verify(registry({ keys: [keyEntry(stranger), keyEntry(REGISTRY_KEY)] })), undefined, "any listed key will do, among others");
});

test("S8 registry: a key that is not a P-256 key (another curve, another type, unreadable) is as good as not listed; the key decides, not the label the registry gives it", async () => {
  const p384 = makeRegistryKey({ namedCurve: "P-384" });
  const edwards = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const cases = [
    ["a P-384 key under the P-256 label", [{ ...keyEntry(p384), keyid: REGISTRY_KEY.keyid }]],
    ["an Ed25519 key under the P-256 label", [{ ...keyEntry(REGISTRY_KEY), key: edwards }]],
    ["a key that is not base64", [{ ...keyEntry(REGISTRY_KEY), key: "not a key!" }]],
    ["a key that is base64 of nothing useful", [{ ...keyEntry(REGISTRY_KEY), key: Buffer.alloc(91, 1).toString("base64") }]],
    ["a key that is missing", [{ ...keyEntry(REGISTRY_KEY), key: undefined }]],
  ];
  for (const [name, keys] of cases) {
    await assert.rejects(() => verify(registry({ keys })), rejected(/does not list/), name);
  }
  const spaced = REGISTRY_KEY.spki.replace(/(.{64})/g, "$1\n");
  for (const [name, entry] of [["a label of another type", { ...keyEntry(REGISTRY_KEY), keytype: "some-other-label", scheme: "x" }], ["no label at all", { ...keyEntry(REGISTRY_KEY), keytype: undefined, scheme: undefined }], ["key material broken into lines", { ...keyEntry(REGISTRY_KEY), key: spaced }]]) {
    assert.equal(await verify(registry({ keys: [entry] })), undefined, `${name}: a P-256 key is a P-256 key`);
  }
});

// ─── Keys that expire ──────────────────────────────────────────────────────

test("S8 registry: a key that has not expired needs no publication date; one that never expires (null, or no date) does not either", async () => {
  for (const expires of ["2099-01-01T00:00:00.000Z", null, undefined]) {
    const reg = registry({ keys: [keyEntry(REGISTRY_KEY, { expires })] });
    assert.equal(await verify(reg), undefined, String(expires));
    assert.deepEqual(reg.urls(), [versionUrl(VERSION), keysUrl], `${expires}: the packument is not read`);
  }
  const { expires, ...withoutDate } = keyEntry(REGISTRY_KEY);
  assert.equal(await verify(registry({ keys: [withoutDate] })), undefined, "an entry that has no expires at all");
});

test("S8 registry: a key that has expired signs a release only if the release was published before it expired: the date is the registry's, read from its packument once", async () => {
  const published = (when) => registry({ keys: [expiredKey], published: when });
  const before = published("2024-12-01T00:00:00.000Z");
  assert.equal(await verify(before), undefined, "published before the key expired");
  assert.deepEqual(before.urls(), [versionUrl(VERSION), keysUrl, packumentUrl]);
  assert.equal(await verify(published("2025-01-28T23:59:59.999Z")), undefined, "a millisecond before");
  await assert.rejects(() => verify(published(LONG_AGO)), rejected(/expired before this release was published/), "at the very moment it expired");
  await assert.rejects(() => verify(published("2025-01-29T00:00:00.001Z")), rejected(/expired before/), "a millisecond after");
  await assert.rejects(() => verify(published("2026-01-10T10:00:00.000Z")), (error) => rejected(/expired before/)(error) && error.message.includes(REGISTRY_KEY.keyid), "published long after");
  const two = registry({ keys: [expiredKey], published: "2024-12-01T00:00:00.000Z", signatures: [good, registrySignature(REGISTRY_KEY, VERSION, release.integrity)] });
  assert.equal(await verify(two), undefined);
  assert.equal(two.urls().filter((url) => url === packumentUrl).length, 1, "two signatures by the expired key, one read of the dates");
});

test("S8 registry: the expiry is judged at the time the server says (an injected clock), not at some other", async () => {
  const soon = keyEntry(REGISTRY_KEY, { expires: "2026-12-01T00:00:00.000Z" });
  const reg = registry({ keys: [soon], published: "2026-12-02T00:00:00.000Z" });
  assert.equal(await verify(reg, { now: () => new Date("2026-11-30T00:00:00.000Z") }), undefined, "still valid then: no date needed");
  await assert.rejects(() => verify(reg, { now: () => new Date("2026-12-01T00:00:00.000Z") }), rejected(/expired before/), "expired from the moment it says");
  assert.equal(await verify(registry({ keys: [expiredKey], published: "2024-12-01T00:00:00.000Z" }), { now: undefined }), undefined, "and the real clock when none is given");
});

test("S8 registry: when the date of publication cannot be had, a release signed with an expired key is refused", async () => {
  const NAME = "narrarium-server";
  const withDates = (route, options = {}) => verify(registry({ keys: [expiredKey], routes: { [packumentUrl]: route } }), options);
  const dated = (time, extra = {}) => json({ name: NAME, "dist-tags": { latest: VERSION }, time, ...extra });
  const cases = [
    ["a registry that answers 500", () => json({ error: "boom" }, 500), unreadable(/answered 500/)],
    ["a registry that answers 404", () => json({}, 404), unreadable(/answered 404/)],
    ["an answer that is not JSON", () => json("not json"), unreadable(/did not answer/)],
    ["a packument without time", () => json({ name: NAME }), rejected(/does not say when/)],
    ["a time that is a list", () => dated([VERSION]), rejected(/does not say when/)],
    ["a time without this version", () => dated({ "0.1.0": "2024-01-01T00:00:00.000Z" }), rejected(/does not say when/)],
    ["a date that is not a date", () => dated({ [VERSION]: "yesterday" }), rejected(/not valid/)],
    ["a date that is a number", () => dated({ [VERSION]: 1738000000000 }), rejected(/does not say when|not valid/)],
    ["a date that is very long", () => dated({ [VERSION]: `2024-12-01T00:00:00.000Z${" ".repeat(100)}` }), rejected(/not valid/)],
    ["a packument of another package", () => dated({ [VERSION]: "2024-12-01T00:00:00.000Z" }, { name: "other-package" }), rejected(/another package/)],
    ["a packument that is a list", () => json([]), rejected(/another package|does not say when/)],
    ["a packument that is null", () => json("null"), rejected(/another package|does not say when/)],
    ["an answer that claims to be over the limit", () => json("{}", 200, { "content-length": String(9 * 1024 * 1024) }), unreadable(/did not answer/)],
    ["a network that fails", () => Promise.reject(new TypeError("fetch failed")), unreadable(/did not answer/)],
  ];
  for (const [name, route, matcher] of cases) {
    await assert.rejects(() => withDates(route), matcher, name);
  }
  await assert.rejects(() => withDates(silence, { timeoutMs: 30 }), unreadable(/did not answer/), "an answer that never comes");
});

test("S8 registry: the packument is read with a larger limit than the other answers (it holds every version), but a limit still: 300 KiB passes, 9 MiB does not", async () => {
  const dated = (padding) => json({ name: "narrarium-server", time: { [VERSION]: "2024-12-01T00:00:00.000Z" }, padding });
  const big = registry({ keys: [expiredKey], routes: { [packumentUrl]: () => dated("x".repeat(300 * 1024)) } });
  assert.equal(await verify(big), undefined, "over 256 KiB, which is all a document of a release may have");
  const huge = registry({ keys: [expiredKey], routes: { [packumentUrl]: () => json("{}", 200, { "content-length": String(9 * 1024 * 1024) }) } });
  await assert.rejects(() => verify(huge), unreadable(/did not answer/));
});

// ─── The list of the registry's keys ───────────────────────────────────────

test("S8 registry: the list of keys is read strictly: what it holds is a key with an id, a date or none, and key material of the one kind this server checks", async () => {
  const [a, b] = [makeRegistryKey(), makeRegistryKey()];
  const parsed = parseNpmRegistryKeys(keysDocument(keyEntry(a, { expires: LONG_AGO }), keyEntry(b), keyEntry(makeRegistryKey(), { expires: null })));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.slice(0, 2).map((key) => [key.keyid, key.expires]), [[a.keyid, Date.parse(LONG_AGO)], [b.keyid, undefined]], "an expiry is milliseconds, no expiry is nothing");
  assert.equal(parsed[2].expires, undefined, "null never expires");
  assert.equal(parsed[0].key.asymmetricKeyType, "ec");
  assert.deepEqual(parseNpmRegistryKeys(keysDocument()), [], "a registry that lists nothing has no keys, which refuses every release later");

  const edwards = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const skipped = [
    ["another curve", keyEntry(makeRegistryKey({ namedCurve: "P-384" }))],
    ["another type of key, under the right label", { ...keyEntry(a), key: edwards }],
    ["a key that is not base64", { ...keyEntry(a), key: "###" }],
    ["key material that is not a key", { ...keyEntry(a), key: Buffer.from("not a key at all").toString("base64") }],
    ["no key material", { ...keyEntry(a), key: undefined }],
  ];
  for (const [name, entry] of skipped) assert.deepEqual(parseNpmRegistryKeys(keysDocument(entry)), [], name);
  assert.equal(parseNpmRegistryKeys(keysDocument({ ...keyEntry(a), keytype: undefined, scheme: undefined })).length, 1, "the label of the key's type is not what decides");

  const refused = [
    ["a document that is not an object", "keys", /not a list of keys/],
    ["a document that is null", null, /not a list of keys/],
    ["a document that is a list", [keyEntry(a)], /not a list of keys/],
    ["a document without keys", {}, /not a list of keys/],
    ["keys that are an object", { keys: { a: keyEntry(a) } }, /not a list of keys/],
    ["an entry that is null", keysDocument(null), /not a key/],
    ["an entry that is text", keysDocument("key"), /not a key/],
    ["an entry without an id", keysDocument({ ...keyEntry(a), keyid: undefined }), /no (valid )?id/],
    ["an entry with an empty id", keysDocument({ ...keyEntry(a), keyid: "" }), /no (valid )?id/],
    ["an entry whose id is a number", keysDocument({ ...keyEntry(a), keyid: 1 }), /no (valid )?id/],
    ["an entry whose id is 300 characters long", keysDocument({ ...keyEntry(a), keyid: "k".repeat(300) }), /no (valid )?id/],
    ["two entries with one id", keysDocument(keyEntry(a), { ...keyEntry(b), keyid: a.keyid }), /listed twice/],
    ["two entries with one id, one of them of another type", keysDocument(keyEntry(a), { ...keyEntry(b), keyid: a.keyid, keytype: "other" }), /listed twice/],
    ["a date that is not a date", keysDocument({ ...keyEntry(a), expires: "someday" }), /expiry date/],
    ["a date that is a number", keysDocument({ ...keyEntry(a), expires: 1738000000000 }), /expiry date/],
    ["a date that is an object", keysDocument({ ...keyEntry(a), expires: {} }), /expiry date/],
    ["a date that is true", keysDocument({ ...keyEntry(a), expires: true }), /expiry date/],
    ["a date that is empty", keysDocument({ ...keyEntry(a), expires: "" }), /expiry date/],
    ["thirty-three keys", keysDocument(...Array.from({ length: 33 }, (_, index) => ({ keyid: `SHA256:k${index}`, keytype: "other", key: "" }))), /too many/],
  ];
  for (const [name, document, pattern] of refused) {
    assert.throws(() => parseNpmRegistryKeys(document), rejected(pattern), name);
  }
  assert.equal(parseNpmRegistryKeys(keysDocument(...Array.from({ length: 32 }, (_, index) => ({ keyid: `SHA256:k${index}`, keytype: "other", key: "" })))).length, 0, "thirty-two is the most it reads");
});

test("S8 registry: a list of keys that is refused refuses the release, a key whose date is wrong among them too", async () => {
  await assert.rejects(() => verify(registry({ routes: { [keysUrl]: () => json({ keys: "none" }) } })), rejected(/not a list of keys/));
  await assert.rejects(() => verify(registry({ keys: [keyEntry(REGISTRY_KEY), { ...keyEntry(makeRegistryKey()), expires: "someday" }] })), rejected(/expiry date/));
  await assert.rejects(() => verify(registry({ keys: [keyEntry(REGISTRY_KEY), keyEntry(REGISTRY_KEY)] })), rejected(/listed twice/));
});

// ─── Cached for the run ────────────────────────────────────────────────────

test("S8 registry: the keys and the dates are read once per keyring, however many releases it checks, and shared by calls that overlap; a read that failed is not remembered", async () => {
  const reg = registry({ keys: [expiredKey], published: "2024-12-01T00:00:00.000Z" });
  const keyring = new NpmRegistryKeyring(reg.fetch);
  await verify(reg, { keyring });
  await verify(reg, { keyring });
  assert.deepEqual(reg.urls(), [versionUrl(VERSION), keysUrl, packumentUrl, versionUrl(VERSION)], "the document of the release is read each time, the keys and the dates once");
  const parallel = registry();
  const shared = new NpmRegistryKeyring(parallel.fetch);
  const [first, second] = await Promise.all([shared.keys(), shared.keys()]);
  assert.equal(first, second);
  assert.deepEqual(parallel.urls(), [keysUrl], "two calls at once, one request");

  const flaky = registry({ keys: [expiredKey], published: "2024-12-01T00:00:00.000Z", routes: { [keysUrl]: (nth) => (nth === 1 ? json({ error: "boom" }, 500) : json(keysDocument(expiredKey))), [packumentUrl]: (nth) => (nth === 1 ? json({}, 503) : json({ name: "narrarium-server", time: { [VERSION]: "2024-12-01T00:00:00.000Z" } })) } });
  const retried = new NpmRegistryKeyring(flaky.fetch);
  await assert.rejects(() => retried.keys(), unreadable(/answered 500/));
  assert.equal((await retried.keys()).length, 1, "the next call asks again");
  await assert.rejects(() => retried.publishedAt(VERSION), unreadable(/answered 503/));
  assert.equal(await retried.publishedAt(VERSION), Date.parse("2024-12-01T00:00:00.000Z"), "so does the next one");
  assert.equal(await retried.publishedAt(VERSION), Date.parse("2024-12-01T00:00:00.000Z"));
  assert.equal(flaky.urls().filter((url) => url === keysUrl).length, 2);
  assert.equal(flaky.urls().filter((url) => url === packumentUrl).length, 2);
  await assert.rejects(() => retried.publishedAt("9.9.9"), rejected(/does not say when/), "a version the packument does not know");
});

// ─── Reads that fail ───────────────────────────────────────────────────────

test("S8 registry: an answer that does not come, is not a success, is too big or is not JSON refuses the release, for the document of the release and for the list of keys alike", async () => {
  const failures = [
    ["a 404", () => json({}, 404), /answered 404/],
    ["a 500", () => json({ error: "boom" }, 500), /answered 500/],
    ["a redirect, which is never followed", () => Promise.reject(new TypeError("redirect")), /did not answer/],
    ["a network that fails", () => Promise.reject(new TypeError("fetch failed")), /did not answer/],
    ["an answer that is not JSON", () => json("<html>bad gateway</html>"), /did not answer/],
    ["an answer of 300 KiB", () => json(`{"padding":"${"x".repeat(300 * 1024)}"}`), /did not answer/],
    ["an answer that claims 50 MiB", () => json("{}", 200, { "content-length": String(50 * 1024 * 1024) }), /did not answer/],
    ["an answer with no body", () => new Response(null, { status: 200 }), /not about this release|not a list of keys/],
  ];
  for (const url of [versionUrl(VERSION), keysUrl]) {
    for (const [name, route, pattern] of failures) {
      const reg = registry({ routes: { [url]: route } });
      const expected = name === "an answer with no body" ? rejected(pattern) : unreadable(/could not be checked/);
      await assert.rejects(() => verify(reg), (error) => expected(error) && pattern.test(error.message), `${url} · ${name}`);
    }
    await assert.rejects(() => verify(registry({ routes: { [url]: silence } }), { timeoutMs: 30 }), unreadable(/did not answer/), `${url} · an answer that never comes`);
  }
});

test("S8 registry: a version or an integrity that is not what it must be is refused before anything is asked of the registry", async () => {
  const cases = [
    ["a tag", "latest", release.integrity, /version is not valid/],
    ["a range", "^0.2.0", release.integrity, /version is not valid/],
    ["a path", "0.2.0/../../x", release.integrity, /version is not valid/],
    ["nothing", undefined, release.integrity, /version is not valid/],
    ["a sha1 integrity", VERSION, "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=", /not a sha512 value/],
    ["a sha512 that is too short", VERSION, "sha512-abc", /not a sha512 value/],
    ["no integrity", VERSION, undefined, /not a sha512 value/],
    ["two integrities", VERSION, `${release.integrity} ${release.integrity}`, /not a sha512 value/],
  ];
  for (const [name, version, integrity, pattern] of cases) {
    const reg = registry();
    await assert.rejects(() => verifyNpmRegistrySignatures(version, integrity, reg.fetch, { now: NOW }), rejected(pattern), name);
    assert.deepEqual(reg.requests, [], `${name}: no request was made`);
  }
});

test("S8 registry: without an injected fetch the global fetch is used, looked up at the time of the call, the way the registry is always read", async () => {
  const reg = registry();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = reg.fetch;
    assert.equal(await verifyNpmRegistrySignatures(VERSION, release.integrity, undefined, { now: NOW }), undefined);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(reg.urls(), [versionUrl(VERSION), keysUrl]);
});
