/** Return the singleton salt for this build process, creating it on first call. */
export declare function getBuildSalt(): Buffer;
/** Base64-encoded build salt, ready to embed in an HTML attribute. */
export declare function getBuildSaltBase64(): string;
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
//# sourceMappingURL=content-crypto.d.ts.map