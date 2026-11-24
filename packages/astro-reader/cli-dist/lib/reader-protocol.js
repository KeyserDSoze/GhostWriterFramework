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
export const READER_FORMAT = 1;
/** PBKDF2-SHA256 iterations of a slot: OWASP's figure for PBKDF2-HMAC-SHA256 (2023). */
export const READER_KDF_ITERATIONS = 600_000;
/** What a browser accepts from `version.json`: fewer would be a weak build, more would freeze the page. */
export const READER_KDF_ITERATIONS_RANGE = { min: 100_000, max: 10_000_000 };
export const READER_KEY_BYTES = 32;
export const READER_SALT_BYTES = 16;
export const READER_IV_BYTES = 12;
/** Additional data of AES-GCM: a wrapped key opens only as a slot, the bundle only as a bundle, an asset only as an asset. */
export const READER_AAD = {
    slot: "narrarium-reader:slot:1",
    bundle: "narrarium-reader:bundle:1",
    asset: "narrarium-reader:asset:1",
};
/** The text a password is compared as: the same characters however the keyboard composed them, without the spaces around it. */
export function normalizeReaderPassword(password) {
    return String(password ?? "").normalize("NFC").trim();
}
export function isReaderVersionFile(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return typeof candidate.format === "number"
        && typeof candidate.version === "string"
        && typeof candidate.protected === "boolean"
        && Boolean(candidate.bundle && typeof candidate.bundle.path === "string")
        && (!candidate.protected || Boolean(candidate.protection && Array.isArray(candidate.protection.slots)));
}
export function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}
export function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
    return bytes;
}
//# sourceMappingURL=reader-protocol.js.map