import { Suspense, lazy, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import "@/i18n/githubApp";
import { Button } from "@/components/ui/button";
import type { SavedBookToken } from "@/components/book/BookTokenDialog";
import type { BookEntry } from "@/types/settings";

// The dialog and its check with GitHub are a chunk of their own: nothing of it is loaded until the button is pressed.
const BookTokenDialog = lazy(() => import("@/components/book/BookTokenDialog").then((module) => ({ default: module.BookTokenDialog })));

/**
 * The dialog that asks for a personal access token for a book, for the place that offers it. The place keeps `dialog` where it stays on the screen whatever happens to the offer: the notice about
 * the app's token goes as soon as the book has a token of its own, which is before the dialog has said how the save went, and the dialog must not go with it.
 */
export function usePersonalTokenDialog(book: BookEntry | undefined, onSaved?: (saved: SavedBookToken) => void): { open: () => void; isOpen: boolean; dialog: ReactNode } {
  const [isOpen, setOpen] = useState(false);
  const dialog = isOpen && book ? <Suspense fallback={null}><BookTokenDialog book={book} onClose={() => setOpen(false)} onSaved={onSaved} /></Suspense> : null;
  return { open: () => setOpen(true), isOpen, dialog };
}

/** «Use a personal access token for this book»: the button that opens the dialog (`usePersonalTokenDialog`). `named` adds the book's name for a screen reader, where several books are listed. */
export function UsePersonalTokenButton({ book, onOpen, named = false }: { book: BookEntry; onOpen: () => void; named?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button type="button" size="sm" variant="outline" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left" aria-label={named ? t("accountSync.github.server.usePatFor", { book: book.name || book.repo }) : undefined} aria-haspopup="dialog" onClick={onOpen}>
      <KeyRound aria-hidden="true" className="mr-1 h-3.5 w-3.5" />{t("accountSync.github.server.usePat")}
    </Button>
  );
}
