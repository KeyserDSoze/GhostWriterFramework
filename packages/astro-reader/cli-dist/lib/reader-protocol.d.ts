/**
 * What the published reader is made of, shared by the build (Node) and the browser: no import of Node or of the DOM here.
 *
 * A build publishes:
 *  - `index.html`, the shell: the reader's code and its labels, never a word of the book;
 *  - `version.json`, fetched by the shell on every open with `cache: "no-store"` (GitHub Pages sends `max-age=600` and that cannot be
 *    changed): which build is current, where its bundle is, and, for a protected book, the key slots;
 *  - `content/<kind>-<hash>.<ext>`, the artifacts under names that change with their bytes: the bundle of the book, its EPUB, its images.
 *
 * A protected book draws a random 256-bit content key K for each build and encrypts every artifact with it (AES-256-GCM). Each password
 * gets a slot: K wrapped with AES-256-GCM under a key derived from the password with PBKDF2-SHA256 (READER_KDF_ITERATIONS, a random salt
 * for each slot). The browser derives against the slots until one unwraps K. K is new at every publish: a password removed from the list
 * loses its slot, and the K it could unwrap before opens nothing that is published afterwards.
 */
export declare const READER_FORMAT = 1;
/** PBKDF2-SHA256 iterations of a slot: OWASP's figure for PBKDF2-HMAC-SHA256 (2023). */
export declare const READER_KDF_ITERATIONS = 600000;
/** What a browser accepts from `version.json`: fewer would be a weak build, more would freeze the page. */
export declare const READER_KDF_ITERATIONS_RANGE: {
    readonly min: 100000;
    readonly max: 10000000;
};
export declare const READER_KEY_BYTES = 32;
export declare const READER_SALT_BYTES = 16;
export declare const READER_IV_BYTES = 12;
/** Additional data of AES-GCM: a wrapped key opens only as a slot, the bundle only as a bundle, an asset only as an asset. */
export declare const READER_AAD: {
    readonly slot: "narrarium-reader:slot:1";
    readonly bundle: "narrarium-reader:bundle:1";
    readonly asset: "narrarium-reader:asset:1";
};
export interface ReaderKeySlot {
    /** Base64 of the PBKDF2 salt of this slot. */
    salt: string;
    /** Base64 of the AES-GCM IV that wrapped K. */
    iv: string;
    /** Base64 of K wrapped (32 bytes of ciphertext and the 16-byte tag). */
    key: string;
}
export interface ReaderProtection {
    kdf: "PBKDF2-SHA256";
    iterations: number;
    cipher: "AES-256-GCM";
    slots: ReaderKeySlot[];
}
export interface ReaderArtifact {
    /** Relative to the site base, for example `content/book-0123456789abcdef.bin`. */
    path: string;
    bytes: number;
    sha256: string;
}
/**
 * How the bytes of an artifact are stored: `json`/`raw` as they are (a public book), `aes-256-gcm` encrypted with K
 * (`[12-byte IV][ciphertext and tag]`), `gzip+aes-256-gcm` compressed before the encryption.
 */
export type ReaderEncoding = "json" | "raw" | "aes-256-gcm" | "gzip+aes-256-gcm";
export interface ReaderVersionFile {
    format: number;
    /** Changes with the bundle, the artifacts, the slots and the reader's own code: the shell reloads once when it differs from its own. */
    version: string;
    publishedAt: string;
    book: {
        id: string;
        title: string;
        language: string;
    };
    /** True when the artifacts are encrypted: a workflow checks this before it publishes a book that has passwords. */
    protected: boolean;
    bundle: ReaderArtifact & {
        encoding: ReaderEncoding;
    };
    epub?: ReaderArtifact & {
        encoding: ReaderEncoding;
    };
    protection?: ReaderProtection;
}
export interface ReaderFigure {
    path: string;
    type: string;
    alt: string;
    caption?: string;
    /** For example `2:3`, so that the page can keep the room of the image before it arrives. */
    aspectRatio?: string;
}
export interface ReaderScene {
    id: string;
    slug: string;
    number: number;
    title: string;
    /** Safe HTML of the prose (the core's renderer: no raw HTML, no unsafe URL). */
    html: string;
    figure?: ReaderFigure;
}
export interface ReaderChapter {
    id: string;
    slug: string;
    number: number;
    title: string;
    /** The body of `chapter.md` when it holds more than the empty headings of the template. */
    openingHtml?: string;
    figure?: ReaderFigure;
    scenes: ReaderScene[];
}
export interface ReaderBundle {
    format: number;
    book: {
        id: string;
        title: string;
        author?: string;
        language: string;
        cover?: ReaderFigure;
    };
    chapters: ReaderChapter[];
    /** How the encoding of the images is: the same as the bundle's when the book is protected. */
    assetEncoding: ReaderEncoding;
}
/** The text a password is compared as: the same characters however the keyboard composed them, without the spaces around it. */
export declare function normalizeReaderPassword(password: string): string;
export declare function isReaderVersionFile(value: unknown): value is ReaderVersionFile;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(value: string): Uint8Array;
//# sourceMappingURL=reader-protocol.d.ts.map