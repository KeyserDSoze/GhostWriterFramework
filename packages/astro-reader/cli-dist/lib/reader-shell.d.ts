import { type ReaderLabels } from "./reader-i18n.js";
import { type ReaderBoot } from "./reader-session.js";
/** The browser side of the shell: the lock, the opening of the book, and its reading view. */
export interface ShellBoot extends ReaderBoot {
    labels: ReaderLabels;
    bookLanguage: string;
    /** The pages of the canon, published only for a public book. */
    canonHref: string | null;
}
export declare function startReaderShell(): Promise<void>;
//# sourceMappingURL=reader-shell.d.ts.map