import { readReaderEnv } from "./env.js";
export function isFullCanonMode() {
    const raw = String(readReaderEnv(["NARRARIUM_READER_CANON_MODE", "NARRARIUM_READER_ALLOW_FULL_CANON"]) ?? "")
        .trim()
        .toLowerCase();
    return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}
/**
 * Returns the raw NARRARIUM_READER_PASSWORD env var value, or null when the
 * variable is not set. Used at build time to derive the AES-256-GCM key for
 * content encryption. Never embedded in the built HTML.
 */
export function getReaderPassword() {
    return readReaderEnv(["NARRARIUM_READER_PASSWORD"]) ?? null;
}
//# sourceMappingURL=reader-mode.js.map