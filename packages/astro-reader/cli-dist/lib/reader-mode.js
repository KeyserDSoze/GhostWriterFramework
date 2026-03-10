import { readReaderEnv } from "./env.js";
export function isFullCanonMode() {
    const raw = String(readReaderEnv(["NARRARIUM_READER_CANON_MODE", "NARRARIUM_READER_ALLOW_FULL_CANON"]) ?? "")
        .trim()
        .toLowerCase();
    return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}
//# sourceMappingURL=reader-mode.js.map