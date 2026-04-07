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
