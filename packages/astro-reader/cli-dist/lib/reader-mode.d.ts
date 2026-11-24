type ReaderCanonMode = "full" | "public" | undefined;
export declare function isFullCanonMode(): boolean;
export declare function runWithReaderCanonMode<T>(mode: ReaderCanonMode, callback: () => T): T;
export declare function readerCanonModeFromCookieHeader(cookieHeader: string): ReaderCanonMode;
export {};
//# sourceMappingURL=reader-mode.d.ts.map