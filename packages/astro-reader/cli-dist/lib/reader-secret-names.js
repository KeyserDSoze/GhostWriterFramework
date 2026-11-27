/**
 * The repository variable `READER_PASSWORD_SECRETS`: the names of the secrets that hold the reader's passwords. The build reads it
 * (`reader-passwords.ts`) and the Narrarium site writes it, both through these functions, so that both agree on what a list is.
 */
export const READER_PASSWORD_SECRETS_VARIABLE = "READER_PASSWORD_SECRETS";
export const READER_PASSWORD_SECRET_PREFIX = "READER_PASSWORD_";
/** What GitHub accepts as a secret name, minus the `GITHUB_` prefix it reserves. */
export function isReaderPasswordSecretName(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^GITHUB_/i.test(name);
}
/** The names of a list (commas, spaces, semicolons or new lines between them; the same name twice is one), and the entries that are not names. */
export function parseReaderPasswordSecretNames(value) {
    const names = [];
    const seen = new Set();
    const invalid = [];
    const entries = String(value ?? "").split(/[\s,;]+/).filter(Boolean);
    entries.forEach((entry, index) => {
        if (!isReaderPasswordSecretName(entry)) {
            invalid.push({ position: index + 1 });
            return;
        }
        const key = entry.toUpperCase();
        if (seen.has(key))
            return;
        seen.add(key);
        names.push(entry.toUpperCase());
    });
    return { names, invalid };
}
/** The value of the variable for these names, as the build reads it back. */
export function formatReaderPasswordSecretNames(names) {
    const parsed = parseReaderPasswordSecretNames(names.join(","));
    if (parsed.invalid.length > 0)
        throw new Error("Every reader password secret needs a valid secret name.");
    return parsed.names.join(",");
}
/** The next free `READER_PASSWORD_NNN` (never a number already used by a listed name, so a removed name is not reused right away). */
export function nextReaderPasswordSecretName(existing) {
    let highest = 0;
    for (const name of existing) {
        const match = new RegExp(`^${READER_PASSWORD_SECRET_PREFIX}(\\d+)$`, "i").exec(name);
        if (match)
            highest = Math.max(highest, Number(match[1]));
    }
    return `${READER_PASSWORD_SECRET_PREFIX}${String(highest + 1).padStart(3, "0")}`;
}
/**
 * The password SLOTS of version 3 of the Pages workflow: it cannot index the repository's secrets by a variable, and it must not hand the build step ALL of them
 * (`toJSON(secrets)`, which is what version 2 did and what GitHub flags), so it names a fixed number of secrets, one environment variable each, in the step that
 * builds the reader. 24 is the number of passwords a book can have: a book has a handful of readers (beta readers, editor, family) and every password costs one
 * key derivation of 600,000 iterations in the browser of whoever opens the book, so there was no limit before and 24 is far above what is ever used.
 */
export const READER_PASSWORD_SLOT_COUNT = 24;
/** `READER_PASSWORD_001` … `READER_PASSWORD_024`, the names of the slots, in order. */
export function readerPasswordSlotNames() {
    return Array.from({ length: READER_PASSWORD_SLOT_COUNT }, (_, index) => `${READER_PASSWORD_SECRET_PREFIX}${String(index + 1).padStart(3, "0")}`);
}
/** Whether a name is one of the slots a workflow of version 3 passes to the build. */
export function isReaderPasswordSlotName(name) {
    const match = new RegExp(`^${READER_PASSWORD_SECRET_PREFIX}(\\d{3})$`, "i").exec(name);
    if (!match)
        return false;
    const number = Number(match[1]);
    return number >= 1 && number <= READER_PASSWORD_SLOT_COUNT;
}
/**
 * The first slot that none of `taken` holds (the listed names, the secrets that exist, the passwords kept), or `null` when every slot is used. A slot whose
 * password was removed is free again: its secret was deleted and the list no longer names it.
 */
export function freeReaderPasswordSlotName(taken) {
    const used = new Set([...taken].map((name) => name.toUpperCase()));
    return readerPasswordSlotNames().find((name) => !used.has(name)) ?? null;
}
//# sourceMappingURL=reader-secret-names.js.map