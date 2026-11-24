import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChapter, createParagraph, initializeBookRepo } from "narrarium";
import {
  createContentKey,
  createKeySlots,
  decryptArtifact as decryptArtifactNode,
  encryptArtifact,
  encryptBundle,
  unwrapContentKeyNode,
} from "../cli-dist/lib/content-crypto.js";
import { buildReaderOutput } from "../cli-dist/lib/reader-build.js";
import { READER_AAD, READER_KDF_ITERATIONS } from "../cli-dist/lib/reader-protocol.js";
import { decryptArtifact, openBundle, unwrapContentKey } from "../cli-dist/lib/reader-unlock.js";

const exportKey = async (key) => Buffer.from(await crypto.subtle.exportKey("raw", key));

test("the slots use PBKDF2-SHA256 with at least 600,000 iterations and a random salt for each slot", async () => {
  assert.ok(READER_KDF_ITERATIONS >= 600_000);
  const protection = await createKeySlots(createContentKey(), ["first password", "second password", "third password"]);
  assert.equal(protection.kdf, "PBKDF2-SHA256");
  assert.equal(protection.cipher, "AES-256-GCM");
  assert.equal(protection.iterations, READER_KDF_ITERATIONS);
  const salts = protection.slots.map((slot) => slot.salt);
  assert.equal(new Set(salts).size, 3, "every slot has its own salt");
  for (const slot of protection.slots) {
    assert.equal(Buffer.from(slot.salt, "base64").length, 16);
    assert.equal(Buffer.from(slot.iv, "base64").length, 12);
    assert.equal(Buffer.from(slot.key, "base64").length, 48, "K wrapped: 32 bytes and the 16-byte tag");
  }
});

test("what Node seals, Web Crypto opens: the content key, the bundle and an asset", async () => {
  const contentKey = createContentKey();
  const protection = await createKeySlots(contentKey, ["correct horse battery staple"]);
  const unlocked = await unwrapContentKey("correct horse battery staple", protection);
  assert.ok(unlocked);
  assert.equal(unlocked.slot, 0);
  assert.deepEqual(await exportKeyOrRaw(unlocked.key, contentKey), contentKey);

  const bundle = JSON.stringify({ format: 1, chapters: [{ title: "Una notte à Gray Harbor", scenes: [] }] });
  assert.equal(await openBundle(unlocked.key, encryptBundle(contentKey, bundle)), bundle);

  const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);
  assert.deepEqual(new Uint8Array(await decryptArtifact(unlocked.key, encryptArtifact(contentKey, image, READER_AAD.asset), READER_AAD.asset)), image);

  // And Node opens its own slots the same way.
  assert.deepEqual(await unwrapContentKeyNode(protection.slots[0], "correct horse battery staple", protection.iterations), contentKey);
});

/** The key Web Crypto unwrapped is not extractable (on purpose): prove it is K by opening something only K sealed. */
async function exportKeyOrRaw(key, contentKey) {
  try {
    return await exportKey(key);
  } catch {
    const probe = encryptArtifact(contentKey, Buffer.from("probe"), READER_AAD.asset);
    assert.equal(Buffer.from(await decryptArtifact(key, probe, READER_AAD.asset)).toString(), "probe");
    return contentKey;
  }
}

test("a wrong password never unwraps the key, and every near miss is a wrong password", async () => {
  const protection = await createKeySlots(createContentKey(), ["Gray Harbor 1897"]);
  for (const attempt of ["gray harbor 1897", "Gray Harbor 1898", "Gray Harbor1897", "Gray Harbor 1897!", "", "   ", "Grey Harbor 1897"]) {
    assert.equal(await unwrapContentKey(attempt, protection), null, `«${attempt}» must not open`);
  }
  assert.equal(await unwrapContentKeyNode(protection.slots[0], "gray harbor 1897", protection.iterations), null);
});

test("N passwords all open the book, each through its own slot, and the remembered slot is tried first", async () => {
  const passwords = ["alpha-ALPHA-1", "bravo bravo 2", "charlie é 3", "delta 4 ∆"];
  const contentKey = createContentKey();
  const protection = await createKeySlots(contentKey, passwords);
  assert.equal(protection.slots.length, passwords.length);
  const sealed = encryptBundle(contentKey, '{"ok":true}');
  for (const [index, password] of passwords.entries()) {
    const unlocked = await unwrapContentKey(password, protection);
    assert.ok(unlocked, password);
    assert.equal(unlocked.slot, index);
    assert.equal(await openBundle(unlocked.key, sealed), '{"ok":true}');
    const hinted = await unwrapContentKey(password, protection, index);
    assert.equal(hinted?.slot, index);
  }
  // A wrong hint costs a derivation, never a wrong answer.
  assert.equal((await unwrapContentKey(passwords[2], protection, 0))?.slot, 2);
});

test("the same password twice is one slot; the text is compared in NFC and without the spaces around it", async () => {
  const protection = await createKeySlots(createContentKey(), ["caf\u00e9 au lait", "cafe\u0301 au lait  ", "  caf\u00e9 au lait"]);
  assert.equal(protection.slots.length, 1);
  assert.ok(await unwrapContentKey("cafe\u0301 au lait", protection));
  assert.ok(await unwrapContentKey(" caf\u00e9 au lait ", protection));
  await assert.rejects(createKeySlots(createContentKey(), ["   "]), /non-empty password/);
  await assert.rejects(createKeySlots(createContentKey(), []), /at least one/);
});

test("each piece of data opens only as what it is: a slot is not a bundle, an asset is not a bundle, a changed byte opens nothing", async () => {
  const contentKey = createContentKey();
  const asset = encryptArtifact(contentKey, Buffer.from("image bytes"), READER_AAD.asset);
  const key = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["decrypt"]);
  await assert.rejects(decryptArtifact(key, asset, READER_AAD.bundle));
  assert.throws(() => decryptArtifactNode(contentKey, asset, READER_AAD.slot));
  const tampered = Buffer.from(encryptBundle(contentKey, '{"a":1}'));
  tampered[tampered.length - 20] ^= 1;
  await assert.rejects(openBundle(key, tampered));
});

async function sampleBook() {
  const root = await mkdtemp(path.join(os.tmpdir(), "narrarium-reader-crypto-"));
  await initializeBookRepo(root, { title: "The Glass Harbor", language: "en", author: "Ada Byron" });
  await createChapter(root, { number: 1, title: "Lanterns" });
  await createParagraph(root, { chapter: "001-lanterns", number: 1, title: "The Quay", body: "MARKER-PROSE the lanterns of the quay burned green." });
  await createChapter(root, { number: 2, title: "Tides" });
  await createParagraph(root, { chapter: "002-tides", number: 1, title: "Low Water", body: "MARKER-SECOND the tide went out and did not come back." });
  return root;
}

test("removing a password from the list makes it fail on the next build, and the old key opens nothing new", async () => {
  const root = await sampleBook();
  try {
    const firstSecrets = {};
    const first = await buildReaderOutput({ bookRoot: root, bookId: "book", passwords: [{ name: "A", password: "pass A" }, { name: "B", password: "pass B" }, { name: "C", password: "pass C" }], includeEpub: false }, firstSecrets);
    const secondSecrets = {};
    const second = await buildReaderOutput({ bookRoot: root, bookId: "book", passwords: [{ name: "A", password: "pass A" }, { name: "C", password: "pass C" }], includeEpub: false }, secondSecrets);
    assert.ok(await unwrapContentKey("pass B", first.versionFile.protection), "B opened the first build");
    assert.equal(await unwrapContentKey("pass B", second.versionFile.protection), null, "B does not open the build without it");
    assert.ok(await unwrapContentKey("pass A", second.versionFile.protection));
    assert.ok(await unwrapContentKey("pass C", second.versionFile.protection));
    assert.notEqual(first.version, second.version);
    assert.notDeepEqual(firstSecrets.contentKey, secondSecrets.contentKey, "a new content key at every build");

    // The key B could unwrap from the first build does not open the second build's bundle.
    const oldKey = (await unwrapContentKey("pass B", first.versionFile.protection)).key;
    const newBundle = second.files.get(second.versionFile.bundle.path);
    await assert.rejects(openBundle(oldKey, newBundle));
    const fresh = await unwrapContentKey("pass A", second.versionFile.protection);
    assert.match(await openBundle(fresh.key, newBundle), /MARKER-SECOND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function encodings(bytes) {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString("base64"),
    buffer.toString("base64url"),
    buffer.toString("hex"),
    buffer.toString("hex").toUpperCase(),
  ];
}

function textEncodings(text) {
  return [text, Buffer.from(text, "utf8").toString("base64"), Buffer.from(text, "utf8").toString("hex"), Buffer.from(text, "utf16le").toString("hex"), encodeURIComponent(text), JSON.stringify(text).slice(1, -1)];
}

function containsBytes(haystack, needle) {
  return Buffer.from(haystack).indexOf(Buffer.from(needle)) >= 0;
}

test("no password and no content key is in anything a protected build publishes, in any usual encoding", async () => {
  const root = await sampleBook();
  try {
    await mkdir(path.join(root, "assets"), { recursive: true });
    const passwords = [{ name: "READER_PASSWORD_001", password: "Zebra-Ocelot-9431" }, { name: "READER_PASSWORD_002", password: "piano verde 77" }];
    const secrets = {};
    const build = await buildReaderOutput({ bookRoot: root, bookId: "github-1", passwords }, secrets);
    const published = [Buffer.from(JSON.stringify(build.versionFile)), ...build.files.values()];
    assert.ok(build.files.size >= 2, "bundle and EPUB");
    for (const file of published) {
      for (const { password } of passwords) {
        for (const needle of textEncodings(password)) assert.ok(!containsBytes(file, Buffer.from(needle)), "a password is in the output");
      }
      assert.ok(!containsBytes(file, secrets.contentKey), "the raw content key is in the output");
      for (const needle of encodings(secrets.contentKey)) assert.ok(!containsBytes(file, Buffer.from(needle)), "the content key is in the output");
      for (const marker of ["MARKER-PROSE", "MARKER-SECOND", "The Quay", "Lanterns"]) assert.ok(!containsBytes(file, Buffer.from(marker)), `${marker} is in clear`);
    }
    assert.equal(build.versionFile.protected, true);
    assert.equal(build.versionFile.protection.slots.length, 2);
    assert.equal(build.versionFile.protection.iterations, READER_KDF_ITERATIONS);
    assert.equal(build.versionFile.bundle.encoding, "gzip+aes-256-gcm");
    assert.equal(build.versionFile.epub.encoding, "aes-256-gcm");
    assert.match(build.versionFile.bundle.path, /^content\/book-[0-9a-f]{16}\.bin$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a public build is not encrypted and names its artifacts after their bytes", async () => {
  const root = await sampleBook();
  try {
    const first = await buildReaderOutput({ bookRoot: root, bookId: "book", passwords: [], includeEpub: false });
    const again = await buildReaderOutput({ bookRoot: root, bookId: "book", passwords: [], includeEpub: false });
    assert.equal(first.versionFile.protected, false);
    assert.equal(first.versionFile.protection, undefined);
    assert.equal(first.version, again.version, "the same book, the same version");
    const bundle = JSON.parse(Buffer.from(first.files.get(first.versionFile.bundle.path)).toString("utf8"));
    assert.equal(bundle.chapters.length, 2);
    assert.match(bundle.chapters[0].scenes[0].html, /MARKER-PROSE/);
    assert.match(first.versionFile.bundle.path, new RegExp(`book-${first.versionFile.bundle.sha256.slice(0, 16)}\\.json$`));
    await writeFile(path.join(root, "chapters", "001-lanterns", "001-the-quay.md"), "---\ntype: paragraph\nid: paragraph:001-lanterns:001-the-quay\nchapter: chapter:001-lanterns\nnumber: 1\ntitle: The Quay\n---\n\nA changed line.\n");
    const changed = await buildReaderOutput({ bookRoot: root, bookId: "book", passwords: [], includeEpub: false });
    assert.notEqual(changed.version, first.version);
    assert.notEqual(changed.versionFile.bundle.path, first.versionFile.bundle.path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
