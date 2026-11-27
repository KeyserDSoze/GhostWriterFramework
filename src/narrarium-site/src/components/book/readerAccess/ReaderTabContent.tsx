import type { BookEntry } from "@/types/settings";
import { ReaderAccessCardView } from "@/components/book/readerAccess/ReaderAccessCard";
import { ReaderUpdateCard } from "@/components/book/readerAccess/ReaderUpdateCard";
import { useReaderAccess } from "@/components/book/readerAccess/useReaderAccess";

/** The Online reader tab of a GitHub book: the offer to update an old reader first, then the passwords and Pages, over one reading of GitHub. */
export function ReaderTabContent({ book }: { book: BookEntry }) {
  const access = useReaderAccess(book);
  return (
    <>
      <ReaderUpdateCard book={book} access={access} />
      <ReaderAccessCardView book={book} access={access} />
    </>
  );
}
