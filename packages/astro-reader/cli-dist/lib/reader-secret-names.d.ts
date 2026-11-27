/**
 * The repository variable `READER_PASSWORD_SECRETS`: the names of the secrets that hold the reader's passwords. The build reads it
 * (`reader-passwords.ts`) and the Narrarium site writes it, both through these functions, so that both agree on what a list is.
 */
export declare const READER_PASSWORD_SECRETS_VARIABLE = "READER_PASSWORD_SECRETS";
export declare const READER_PASSWORD_SECRET_PREFIX = "READER_PASSWORD_";
/** What GitHub accepts as a secret name, minus the `GITHUB_` prefix it reserves. */
export declare function isReaderPasswordSecretName(name: string): boolean;
/** The names of a list (commas, spaces, semicolons or new lines between them; the same name twice is one), and the entries that are not names. */
export declare function parseReaderPasswordSecretNames(value: string | null | undefined): {
    names: string[];
    invalid: Array<{
        position: number;
    }>;
};
/** The value of the variable for these names, as the build reads it back. */
export declare function formatReaderPasswordSecretNames(names: string[]): string;
/** The next free `READER_PASSWORD_NNN` (never a number already used by a listed name, so a removed name is not reused right away). */
export declare function nextReaderPasswordSecretName(existing: string[]): string;
/**
 * The password SLOTS of version 3 of the Pages workflow: it cannot index the repository's secrets by a variable, and it must not hand the build step ALL of them
 * (`toJSON(secrets)`, which is what version 2 did and what GitHub flags), so it names a fixed number of secrets, one environment variable each, in the step that
 * builds the reader. 24 is the number of passwords a book can have: a book has a handful of readers (beta readers, editor, family) and every password costs one
 * key derivation of 600,000 iterations in the browser of whoever opens the book, so there was no limit before and 24 is far above what is ever used.
 */
export declare const READER_PASSWORD_SLOT_COUNT = 24;
/** `READER_PASSWORD_001` … `READER_PASSWORD_024`, the names of the slots, in order. */
export declare function readerPasswordSlotNames(): string[];
/** Whether a name is one of the slots a workflow of version 3 passes to the build. */
export declare function isReaderPasswordSlotName(name: string): boolean;
/**
 * The first slot that none of `taken` holds (the listed names, the secrets that exist, the passwords kept), or `null` when every slot is used. A slot whose
 * password was removed is free again: its secret was deleted and the list no longer names it.
 */
export declare function freeReaderPasswordSlotName(taken: Iterable<string>): string | null;
//# sourceMappingURL=reader-secret-names.d.ts.map