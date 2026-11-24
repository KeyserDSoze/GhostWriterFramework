/**
 * The words of the published reader, in English and Italian: the language of the book picks them (`it`, `it-IT`... are Italian, every
 * other language reads the English ones). The shell is rendered with them and the browser code receives the same table.
 */
export function readerLanguage(bookLanguage) {
    return /^it\b/i.test(String(bookLanguage ?? "").trim()) ? "it" : "en";
}
const en = {
    skipToText: "Skip to the text",
    loading: "Opening the book…",
    lockTitle: "This book is protected",
    lockIntro: "Enter the password you were given to read it.",
    passwordLabel: "Password",
    showPassword: "Show password",
    rememberLabel: "Remember the password on this device",
    unlock: "Open the book",
    unlocking: "Checking the password…",
    wrongPassword: "That password does not open this book. Check it and try again.",
    revokedPassword: "The password saved on this device is no longer valid. Enter a new one.",
    unverifiedPassword: "You seem to be offline and the saved password could not be checked. Enter the password to read the copy on this device.",
    openFailed: "The book could not be opened.",
    reload: "Reload",
    unsupported: "This book was published by a newer reader: reload the page.",
    staleShell: "A newer version of the reader is published; reload the page to use it.",
    offline: "You are offline: this is the copy last saved by this browser.",
    noChapters: "This book has no chapters yet.",
    emptyChapter: "This chapter has no text yet.",
    chapterLabel: "Chapter {number}",
    chapterOf: "Chapter {number} of {total}",
    previousChapter: "Previous chapter",
    nextChapter: "Next chapter",
    contents: "Contents",
    forgetPassword: "Forget the password on this device",
    passwordForgotten: "The password is no longer saved on this device.",
    downloadEpub: "Download the EPUB",
    bookOverview: "Characters, places and timeline",
};
const it = {
    skipToText: "Vai al testo",
    loading: "Apertura del libro…",
    lockTitle: "Questo libro è protetto",
    lockIntro: "Inserisci la password che ti è stata data per leggerlo.",
    passwordLabel: "Password",
    showPassword: "Mostra la password",
    rememberLabel: "Ricorda la password su questo dispositivo",
    unlock: "Apri il libro",
    unlocking: "Verifica della password…",
    wrongPassword: "Questa password non apre il libro. Controllala e riprova.",
    revokedPassword: "La password salvata su questo dispositivo non è più valida. Inseriscine una nuova.",
    unverifiedPassword: "Sembri offline e non è stato possibile verificare la password salvata. Inserisci la password per leggere la copia su questo dispositivo.",
    openFailed: "Non è stato possibile aprire il libro.",
    reload: "Ricarica",
    unsupported: "Questo libro è stato pubblicato da un lettore più recente: ricarica la pagina.",
    staleShell: "È pubblicata una versione più recente del lettore; ricarica la pagina per usarla.",
    offline: "Sei offline: questa è l'ultima copia salvata da questo browser.",
    noChapters: "Questo libro non ha ancora capitoli.",
    emptyChapter: "Questo capitolo non ha ancora testo.",
    chapterLabel: "Capitolo {number}",
    chapterOf: "Capitolo {number} di {total}",
    previousChapter: "Capitolo precedente",
    nextChapter: "Capitolo successivo",
    contents: "Indice",
    forgetPassword: "Dimentica la password su questo dispositivo",
    passwordForgotten: "La password non è più salvata su questo dispositivo.",
    downloadEpub: "Scarica l'EPUB",
    bookOverview: "Personaggi, luoghi e cronologia",
};
export const READER_LABELS = { en, it };
export function readerLabels(bookLanguage) {
    return READER_LABELS[readerLanguage(bookLanguage)];
}
/** `{name}` placeholders filled in. */
export function formatLabel(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}
//# sourceMappingURL=reader-i18n.js.map