/**
 * Which passwords protect this build, read from the environment of the build step:
 *  - `READER_PASSWORD_SECRETS`: the names of the repository secrets that hold the passwords (a repository variable in the Pages workflow:
 *    `READER_PASSWORD_SECRETS: ${{ vars.READER_PASSWORD_SECRETS }}`), for example `READER_PASSWORD_001,READER_PASSWORD_002`;
 *  - the SLOTS of version 3 of the Pages workflow: `READER_PASSWORD_001` … `READER_PASSWORD_024`, one environment variable each
 *    (`READER_PASSWORD_001: ${{ secrets.READER_PASSWORD_001 }}`), given to the build step only. A listed name that is a slot is read from
 *    its own variable, and no other variable of the environment is ever looked at;
 *  - `NARRARIUM_READER_SECRETS`: the JSON of the repository's secrets (`${{ toJSON(secrets) }}`, what version 2 of the workflow gave the
 *    build step, and the way to pass any name that is not a slot). Still read, so that a book whose workflow is version 2 keeps working.
 *    Only the names listed above are read from it; every other secret, `GITHUB_TOKEN` included, is never looked at;
 *  - `NARRARIUM_READER_PASSWORD`: the single password of the books published before the list existed, still one slot.
 * No name and no single password: the book is public and nothing is encrypted.
 *
 * Nothing here ever puts a value in a message: errors and summaries name the secrets, never what they hold.
 */
export declare const READER_PASSWORD_LIST_ENV = "READER_PASSWORD_SECRETS";
export declare const READER_SECRETS_JSON_ENV = "NARRARIUM_READER_SECRETS";
export declare const READER_LEGACY_PASSWORD_ENV = "NARRARIUM_READER_PASSWORD";
export interface ReaderPassword {
    /** The secret it came from (or `NARRARIUM_READER_PASSWORD`): what the build log may say. */
    name: string;
    password: string;
}
export interface PickedReaderPasswords {
    passwords: ReaderPassword[];
    /** The names the list asked for. */
    listed: string[];
    /** Listed names that the secrets do not have, or have empty. */
    missing: string[];
    /** True when `NARRARIUM_READER_PASSWORD` gave a slot. */
    legacy: boolean;
}
export declare class ReaderPasswordError extends Error {
    constructor(message: string);
}
type Env = Record<string, string | undefined>;
/** The passwords of this build; throws `ReaderPasswordError` (names only) when the list asks for passwords the build cannot have. */
export declare function pickReaderPasswords(env?: Env): PickedReaderPasswords;
/** One line for the build log: how many passwords, and the names of their secrets. */
export declare function describeReaderPasswords(picked: PickedReaderPasswords): string;
export {};
//# sourceMappingURL=reader-passwords.d.ts.map