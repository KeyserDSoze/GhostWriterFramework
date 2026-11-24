import { READER_RELOAD_PARAM } from "./reader-freshness.js";
import { type ReaderBundle, type ReaderVersionFile } from "./reader-protocol.js";
/**
 * Opening the published book in the browser, with the browser's APIs passed in (the tests run it in Node):
 *  1. the current `version.json` (no-store, a query never seen before), or the copy the shell was built with when offline;
 *  2. one reload when the shell is not the current one (see `reader-freshness.ts`);
 *  3. for a protected book, the password: the remembered one is tried against the CURRENT slots on every open; when it opens none it is
 *     forgotten and the reader is told it is no longer valid (offline, with only the shell's own copy of the slots, it is kept);
 *  4. the bundle, by its hashed name, decrypted when needed.
 */
export interface ReaderBoot {
    /** The build the shell belongs to. */
    version: string;
    bookId: string;
    /** The `version.json` of that build: what the shell reads with when `version.json` cannot be fetched. */
    fallback: ReaderVersionFile;
}
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface ReaderSessionDeps {
    fetch: typeof fetch;
    local: StorageLike;
    session: StorageLike;
    /** The address of the page now. */
    href: string;
    /** The base the site's relative addresses resolve from (`document.baseURI`). */
    baseHref: string;
    replaceLocation(url: string): void;
    now?(): number;
}
export type PasswordReason = "first" | "wrong" | "revoked" | "unverified";
export interface PasswordAnswer {
    password: string;
    remember: boolean;
}
/** Shows the lock and resolves with what the reader typed; `reason` says what to tell them first. */
export type PasswordPrompt = (reason: PasswordReason) => Promise<PasswordAnswer>;
export interface OpenedReader {
    kind: "open";
    versionFile: ReaderVersionFile;
    bundle: ReaderBundle;
    /** False when `version.json` could not be fetched and the shell's own copy was used. */
    online: boolean;
    /** True when the HTML is older than `version.json` even after the one reload: the content is the current one all the same. */
    staleShell: boolean;
    /** The bytes of an artifact of this build (an image, the EPUB), decrypted when the book is protected. */
    loadArtifact(artifactPath: string): Promise<Uint8Array>;
    /** Forget the password this device remembers for the book. */
    forgetPassword(): void;
}
export type ReaderSessionResult = OpenedReader | {
    kind: "reloading";
    url: string;
};
export declare class ReaderOpenError extends Error {
    readonly code: "unsupported" | "bundle-unavailable" | "bundle-invalid";
    constructor(code: "unsupported" | "bundle-unavailable" | "bundle-invalid", message: string);
}
export declare function readerStorageKeys(bookId: string): {
    password: string;
    slot: string;
    reloadedFor: string;
    prefix: string;
};
export declare function openReaderSession(boot: ReaderBoot, deps: ReaderSessionDeps, prompt: PasswordPrompt): Promise<ReaderSessionResult>;
export { READER_RELOAD_PARAM };
//# sourceMappingURL=reader-session.d.ts.map