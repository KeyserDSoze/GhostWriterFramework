import nacl from "tweetnacl";
import { blake2b } from "blakejs";

/**
 * libsodium's `crypto_box_seal`, which is the scheme GitHub wants for the value of a secret: an ephemeral X25519 key pair, a nonce that is the BLAKE2b-24 of
 * (ephemeral public key ‖ recipient public key), a `crypto_box` (XSalsa20-Poly1305) of the message, and the result is the ephemeral public key followed by
 * the box. tweetnacl's `box` is that `crypto_box`. This module is its own lazy chunk (about 14 kB gzipped); the app never loads it until a password is saved.
 */

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The sealed box of `message` for the recipient's public key (32 bytes). `ephemeralSecretKey` is only for known-answer tests: never pass one otherwise. */
export function sealBox(message: Uint8Array, recipientPublicKey: Uint8Array, ephemeralSecretKey?: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) throw new Error("A recipient public key is 32 bytes.");
  const ephemeral = ephemeralSecretKey ? nacl.box.keyPair.fromSecretKey(ephemeralSecretKey) : nacl.box.keyPair();
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipientPublicKey.length);
  nonceInput.set(ephemeral.publicKey);
  nonceInput.set(recipientPublicKey, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const box = nacl.box(message, nonce, recipientPublicKey, ephemeral.secretKey);
  const sealed = new Uint8Array(ephemeral.publicKey.length + box.length);
  sealed.set(ephemeral.publicKey);
  sealed.set(box, ephemeral.publicKey.length);
  ephemeral.secretKey.fill(0);
  return sealed;
}

/** The value GitHub's `PUT /actions/secrets/{name}` takes: the sealed box of the secret's text, in base64, for the repository's public key (base64). */
export function sealSecret(value: string, publicKeyBase64: string): string {
  return bytesToBase64(sealBox(new TextEncoder().encode(value), base64ToBytes(publicKeyBase64)));
}
