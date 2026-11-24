/** The book on the screen of this tab, if any: a branch chosen on another device is not put under it (see `adoptRememberedBranches`). */
let openBookId: string | null = null;

export function setOpenBook(bookId: string | null): void {
  openBookId = bookId;
}

export function openBook(): string | null {
  return openBookId;
}
