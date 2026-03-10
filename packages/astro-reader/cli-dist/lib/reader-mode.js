export function isFullCanonMode() {
    const raw = String(process.env.NARRARIUM_READER_CANON_MODE ?? process.env.NARRARIUM_READER_ALLOW_FULL_CANON ?? "")
        .trim()
        .toLowerCase();
    return raw === "1" || raw === "true" || raw === "full" || raw === "author" || raw === "spoilers";
}
//# sourceMappingURL=reader-mode.js.map