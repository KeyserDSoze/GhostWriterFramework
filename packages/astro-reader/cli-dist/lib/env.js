const astroEnv = (import.meta.env ?? {});
export function normalizeReaderEnvValue(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim() || undefined;
    }
    return trimmed;
}
export function isClearlyInvalidBookRootValue(value) {
    const normalized = normalizeReaderEnvValue(value);
    if (!normalized) {
        return true;
    }
    return normalized === "/" || normalized === "\\" || /^[a-zA-Z]:(?:[\\/])?$/.test(normalized);
}
export function readReaderEnv(keys, sources = [process.env, astroEnv]) {
    for (const source of sources) {
        if (!source) {
            continue;
        }
        for (const key of keys) {
            const value = normalizeReaderEnvValue(source[key]);
            if (value) {
                return value;
            }
        }
    }
    return undefined;
}
export function readReaderBookRootEnv(sources = [process.env, astroEnv]) {
    const value = readReaderEnv(["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"], sources);
    if (!value || isClearlyInvalidBookRootValue(value)) {
        return undefined;
    }
    return value;
}
//# sourceMappingURL=env.js.map