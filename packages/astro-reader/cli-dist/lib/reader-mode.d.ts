export declare function isFullCanonMode(): boolean;
/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export declare function getReaderPassword(): string | null;
/**
 * Returns a SHA-256 hex hash of the NARRARIUM_READER_PASSWORD env var,
 * or null when the variable is not set. The hash is embedded in the built
 * HTML and compared against the user's input at runtime via SubtleCrypto
 * as a fast pre-filter before the more expensive PBKDF2 key derivation.
 */
export declare function getReaderPasswordHash(): string | null;
//# sourceMappingURL=reader-mode.d.ts.map