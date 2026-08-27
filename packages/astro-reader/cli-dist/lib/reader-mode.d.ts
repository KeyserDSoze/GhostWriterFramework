type ReaderCanonMode = "full" | "public" | undefined;
export declare function isFullCanonMode(): boolean;
export declare function runWithReaderCanonMode<T>(mode: ReaderCanonMode, callback: () => T): T;
export declare function readerCanonModeFromCookieHeader(cookieHeader: string): ReaderCanonMode;
/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export declare function getReaderPassword(): string | null;
export {};
//# sourceMappingURL=reader-mode.d.ts.map