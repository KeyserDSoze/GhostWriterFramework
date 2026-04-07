import { createHash } from "node:crypto";
import { readReaderEnv } from "./env.js";
export function isFullCanonMode() {
    const raw = String(readReaderEnv(["NARRARIUM_READER_CANON_MODE", "NARRARIUM_READER_ALLOW_FULL_CANON"]) ?? "")
        .trim()
        .toLowerCase();
    return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}
/**
 * Returns a SHA-256 hex hash of the NARRARIUM_READER_PASSWORD env var,
 * or null when the variable is not set. The hash is embedded in the built
 * HTML and compared against the user's input at runtime via SubtleCrypto.
 */
export function getReaderPasswordHash() {
    const raw = readReaderEnv(["NARRARIUM_READER_PASSWORD"]);
    if (!raw)
        return null;
    return createHash("sha256").update(raw).digest("hex");
}
//# sourceMappingURL=reader-mode.js.map