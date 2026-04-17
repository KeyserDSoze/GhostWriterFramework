/** Return the singleton salt for this build/dev process, creating it on first call. */
export declare function getBuildSalt(): Buffer;
/** Base64-encoded build salt, ready to embed in an HTML attribute. */
export declare function getBuildSaltBase64(): string;
/**
 * Known plaintext embedded (encrypted) in the built HTML so the browser can
 * verify a password by attempting decryption rather than comparing a fast hash.
 * This forces brute-force attempts to pay the full PBKDF2 cost every time.
 */
export declare const CANARY_PLAINTEXT = "narrarium-ok";
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
export declare function encryptString(plaintext: string, password: string): EncryptedChunk;
/**
 * Encrypt the canary plaintext with the same PBKDF2-derived build key.
 *
 * Embed `iv` and `ct` in the built HTML as `data-canary-iv` / `data-canary-ct`.
 * The browser verifies the password by decrypting the canary and checking that
 * the result equals `CANARY_PLAINTEXT` — no fast-hash oracle in the HTML.
 */
export declare function encryptCanary(password: string): EncryptedChunk;
/**
 * Encrypt a raw Buffer with AES-256-GCM using the same PBKDF2-derived build
 * key. Returns raw `iv` and `ct` Buffers for binary file endpoints.
 *
 * Wire format (concatenate before serving):
 *   [12-byte IV][ciphertext ∥ 16-byte GCM auth tag]
 *
 * Client side: `bytes.slice(0, 12)` = IV, `bytes.slice(12)` = ciphertext+tag.
 */
export declare function encryptBufferRaw(data: Buffer, password: string): {
    iv: Buffer;
    ct: Buffer;
};
//# sourceMappingURL=content-crypto.d.ts.map