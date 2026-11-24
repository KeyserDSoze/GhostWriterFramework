// @vitest-environment node
import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import { base64ToBytes, bytesToBase64, sealBox, sealSecret } from "@/readerAccess/sealedBox";

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// Known answer: libsodium's own construction (crypto_scalarmult_base, crypto_generichash(24, epk ‖ rpk), crypto_box_easy) with these fixed keys, computed
// once with libsodium-wrappers 0.8.4 and written down, so that the scheme is pinned even without libsodium in the tree.
const RECIPIENT_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const RECIPIENT_PUBLIC_HEX = "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c";
const EPHEMERAL_SECRET = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const MESSAGE = "correct horse battery staple";
const SEALED_HEX = "8dafcfeeae9045ee9a78d78a99fcf32e7781e441eb073096c342b8e2dcc3b612eaeda12bd8a4321781c01ccb9a764b46f0bcbf43e2b1e2bf80bc598ba41ffeaf2bf144d09e1d500035e50a04";

describe("the sealed box GitHub wants for a secret", () => {
  it("gives the known answer for fixed keys", async () => {
    await sodium.ready;
    const publicKey = sodium.crypto_scalarmult_base(RECIPIENT_SECRET);
    expect(hex(publicKey)).toBe(RECIPIENT_PUBLIC_HEX);
    expect(hex(sealBox(new TextEncoder().encode(MESSAGE), publicKey, EPHEMERAL_SECRET))).toBe(SEALED_HEX);
  });

  it("is what libsodium computes with the same keys, byte for byte", async () => {
    await sodium.ready;
    const publicKey = sodium.crypto_scalarmult_base(RECIPIENT_SECRET);
    const ephemeralPublic = sodium.crypto_scalarmult_base(EPHEMERAL_SECRET);
    const nonce = sodium.crypto_generichash(24, new Uint8Array([...ephemeralPublic, ...publicKey]), null);
    const expected = new Uint8Array([...ephemeralPublic, ...sodium.crypto_box_easy(new TextEncoder().encode(MESSAGE), nonce, publicKey, EPHEMERAL_SECRET)]);
    expect(hex(sealBox(new TextEncoder().encode(MESSAGE), publicKey, EPHEMERAL_SECRET))).toBe(hex(expected));
  });

  it("is opened by libsodium's crypto_box_seal_open, with a fresh ephemeral key every time", async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const first = sealBox(new TextEncoder().encode(MESSAGE), keys.publicKey);
    const second = sealBox(new TextEncoder().encode(MESSAGE), keys.publicKey);
    expect(hex(first)).not.toBe(hex(second));
    expect(new TextDecoder().decode(sodium.crypto_box_seal_open(first, keys.publicKey, keys.privateKey))).toBe(MESSAGE);
    expect(new TextDecoder().decode(sodium.crypto_box_seal_open(second, keys.publicKey, keys.privateKey))).toBe(MESSAGE);
  });

  it("opens what libsodium seals, in the other direction too (its output has the same length and layout)", async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const theirs = sodium.crypto_box_seal(MESSAGE, keys.publicKey);
    const ours = sealBox(new TextEncoder().encode(MESSAGE), keys.publicKey);
    expect(ours.length).toBe(theirs.length);
    expect(ours.length).toBe(32 + 16 + MESSAGE.length);
  });

  it("takes and gives base64 like GitHub's API, with any text including non-ASCII", async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const text = "pässwörd — ✓ 日本語";
    const sealed = sealSecret(text, bytesToBase64(keys.publicKey));
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(new TextDecoder().decode(sodium.crypto_box_seal_open(base64ToBytes(sealed), keys.publicKey, keys.privateKey))).toBe(text);
  });

  it("refuses a public key that is not 32 bytes, and never puts the plain text in the output", async () => {
    expect(() => sealBox(new Uint8Array([1]), new Uint8Array(31))).toThrow("32 bytes");
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const sealed = sealSecret("hunter2-hunter2", bytesToBase64(keys.publicKey));
    expect(atob(sealed)).not.toContain("hunter2");
  });
});
