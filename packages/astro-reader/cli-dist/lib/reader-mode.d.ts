export declare function isFullCanonMode(): boolean;
/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export declare function getReaderPassword(): string | null;
//# sourceMappingURL=reader-mode.d.ts.map