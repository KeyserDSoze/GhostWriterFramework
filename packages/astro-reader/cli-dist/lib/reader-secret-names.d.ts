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
//# sourceMappingURL=reader-secret-names.d.ts.map