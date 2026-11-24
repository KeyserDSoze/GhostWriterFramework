import type { ReaderLabels } from "./reader-i18n.js";
import { type ReaderBoot } from "./reader-session.js";
/** The browser side of the shell: the lock and the opening of the book; then the e-reader (ereader/app.ts) lays it out. */
export interface ShellBoot extends ReaderBoot {
    labels: ReaderLabels;
    uiLanguage: string;
    bookLanguage: string;
    /** The pages of the canon, published only for a public book. */
    canonHref: string | null;
}
export declare function startReaderShell(): Promise<void>;
//# sourceMappingURL=reader-shell.d.ts.map