/**
 * The words of the published reader, in English and Italian: the language of the book picks them (`it`, `it-IT`... are Italian, every
 * other language reads the English ones). The shell is rendered with them and the browser code receives the same table.
 */
export type ReaderLanguage = "en" | "it";
export declare function readerLanguage(bookLanguage: string | undefined): ReaderLanguage;
declare const en: {
    readonly skipToText: "Skip to the text";
    readonly loading: "Opening the book…";
    readonly lockTitle: "This book is protected";
    readonly lockIntro: "Enter the password you were given to read it.";
    readonly passwordLabel: "Password";
    readonly showPassword: "Show password";
    readonly rememberLabel: "Remember the password on this device";
    readonly unlock: "Open the book";
    readonly unlocking: "Checking the password…";
    readonly wrongPassword: "That password does not open this book. Check it and try again.";
    readonly revokedPassword: "The password saved on this device is no longer valid. Enter a new one.";
    readonly unverifiedPassword: "You seem to be offline and the saved password could not be checked. Enter the password to read the copy on this device.";
    readonly openFailed: "The book could not be opened.";
    readonly reload: "Reload";
    readonly unsupported: "This book was published by a newer reader: reload the page.";
    readonly staleShell: "A newer version of the reader is published; reload the page to use it.";
    readonly offline: "You are offline: this is the copy last saved by this browser.";
    readonly noChapters: "This book has no chapters yet.";
    readonly emptyChapter: "This chapter has no text yet.";
    readonly chapterLabel: "Chapter {number}";
    readonly chapterOf: "Chapter {number} of {total}";
    readonly previousChapter: "Previous chapter";
    readonly nextChapter: "Next chapter";
    readonly contents: "Contents";
    readonly forgetPassword: "Forget the password on this device";
    readonly passwordForgotten: "The password is no longer saved on this device.";
    readonly downloadEpub: "Download the EPUB";
    readonly bookOverview: "Characters, places and timeline";
};
export type ReaderLabels = {
    [K in keyof typeof en]: string;
};
export declare const READER_LABELS: Record<ReaderLanguage, ReaderLabels>;
export declare function readerLabels(bookLanguage: string | undefined): ReaderLabels;
/** `{name}` placeholders filled in. */
export declare function formatLabel(template: string, values: Record<string, string | number>): string;
export {};
//# sourceMappingURL=reader-i18n.d.ts.map