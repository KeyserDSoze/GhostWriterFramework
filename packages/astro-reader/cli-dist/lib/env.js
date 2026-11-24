import { existsSync } from "node:fs";
import path from "node:path";
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
/**
 * The raw values of these variables, the process's first and then the ones Astro read from `.env` (`astro build` does not put those in
 * `process.env`). Raw: a JSON of secrets must reach its parser as it is.
 */
export function readReaderEnvSnapshot(keys, sources = [process.env, astroEnv]) {
    const snapshot = {};
    for (const key of keys) {
        for (const source of sources) {
            const value = source?.[key];
            if (typeof value === "string" && value.trim()) {
                snapshot[key] = value;
                break;
            }
        }
    }
    return snapshot;
}
export function readReaderBookRootEnv(sources = [process.env, astroEnv]) {
    const value = readReaderEnv(["NARRARIUM_BOOK_ROOT", "GHOSTWRITER_BOOK_ROOT"], sources);
    if (!value || isClearlyInvalidBookRootValue(value)) {
        return undefined;
    }
    return value;
}
export function resolveReaderBookRootCandidate(value, cwd = process.cwd()) {
    const normalized = normalizeReaderEnvValue(value);
    if (!normalized || isClearlyInvalidBookRootValue(normalized)) {
        return undefined;
    }
    const resolved = path.resolve(cwd, normalized);
    return existsSync(path.join(resolved, "book.md")) ? resolved : undefined;
}
//# sourceMappingURL=env.js.map