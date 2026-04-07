export declare function isFullCanonMode(): boolean;
/**
 * Returns a SHA-256 hex hash of the NARRARIUM_READER_PASSWORD env var,
 * or null when the variable is not set. The hash is embedded in the built
 * HTML and compared against the user's input at runtime via SubtleCrypto.
 */
export declare function getReaderPasswordHash(): string | null;
//# sourceMappingURL=reader-mode.d.ts.map