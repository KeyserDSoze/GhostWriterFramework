import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * Build-time AES-256-GCM content encryption utilities.
 *
 * A single random 16-byte salt is generated once per Node process (i.e. once
 * per Astro build). It is embedded publicly in the built HTML via
 * `data-crypto-salt` on `<body>` so the client can run PBKDF2 key derivation
 * with the same parameters. A public salt is fine — it only prevents rainbow
 * tables; the security comes from the password entropy.
 */

let _buildSalt: Buffer | null = null;

/** Return the singleton salt for this build process, creating it on first call. */
export function getBuildSalt(): Buffer {
  if (!_buildSalt) {
    _buildSalt = randomBytes(16);
    console.info("[narrarium-reader] Content encryption enabled (AES-256-GCM).");
  }
  return _buildSalt;
}

/** Base64-encoded build salt, ready to embed in an HTML attribute. */
export function getBuildSaltBase64(): string {
  return getBuildSalt().toString("base64");
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, 100_000, 32, "sha256");
}

/**
 * Known plaintext embedded (encrypted) in the built HTML so the browser can
 * verify a password by attempting decryption rather than comparing a fast hash.
 * This forces brute-force attempts to pay the full PBKDF2 cost every time.
 */
export const CANARY_PLAINTEXT = "narrarium-ok";

export interface EncryptedChunk {
  /** Base64-encoded 12-byte random IV. */
  iv: string;
  /** Base64-encoded (ciphertext ∥ 16-byte GCM auth tag). */
  ct: string;
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM using PBKDF2-derived key.
 *
 * The ciphertext field contains the encrypted bytes immediately followed by
 * the 16-byte GCM authentication tag, so Web Crypto's AES-GCM decrypt can
 * verify integrity without any additional framing.
 */
export function encryptString(plaintext: string, password: string): EncryptedChunk {
  const salt = getBuildSalt();
  const key = deriveKey(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // always 16 bytes for AES-GCM
  return {
    iv: iv.toString("base64"),
    ct: Buffer.concat([body, tag]).toString("base64"),
  };
}

/**
 * Encrypt the canary plaintext with the same PBKDF2-derived build key.
 *
 * Embed `iv` and `ct` in the built HTML as `data-canary-iv` / `data-canary-ct`.
 * The browser verifies the password by decrypting the canary and checking that
 * the result equals `CANARY_PLAINTEXT` — no fast-hash oracle in the HTML.
 */
export function encryptCanary(password: string): EncryptedChunk {
  return encryptString(CANARY_PLAINTEXT, password);
}

/**
 * Encrypt a raw Buffer with AES-256-GCM using the same PBKDF2-derived build
 * key. Returns raw `iv` and `ct` Buffers for binary file endpoints.
 *
 * Wire format (concatenate before serving):
 *   [12-byte IV][ciphertext ∥ 16-byte GCM auth tag]
 *
 * Client side: `bytes.slice(0, 12)` = IV, `bytes.slice(12)` = ciphertext+tag.
 */
export function encryptBufferRaw(data: Buffer, password: string): { iv: Buffer; ct: Buffer } {
  const salt = getBuildSalt();
  const key = deriveKey(password, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag(); // always 16 bytes for AES-GCM
  return { iv, ct: Buffer.concat([body, tag]) };
}
