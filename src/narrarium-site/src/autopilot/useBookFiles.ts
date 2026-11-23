import { useEffect, useRef, useState } from "react";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";

export interface BookFiles {
  /** The files that exist among the ones asked for, by path; `null` while the first reading is under way. */
  files: ReadonlyMap<string, string> | null;
  /** The book could not be read here (it has no working copy in this browser yet). */
  failed: boolean;
}

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * A few files of the book, read from its working copy in this browser (the one the autopilot of the browser writes to, and the personal server's
 * work comes back to), and read again when `refresh` changes. Only the paths asked for are read, never the whole book: a plan has no maximum number
 * of chapters. What was read stays on the screen while the next files are read.
 */
export function useBookFiles(bookId: string, paths: readonly string[], refresh: unknown = null): BookFiles {
  const book = useSettingsStore((state) => state.settings.books.find((entry) => entry.id === bookId));
  const { branch, ready } = useWorkingBranch(bookId);
  // The settings are replaced whenever they are read again: the book is the same one as long as these are.
  const bookKey = book ? `${book.id}|${book.owner}/${book.repo}|${book.storageMode ?? ""}` : "";
  const bookRef = useRef(book);
  bookRef.current = book;
  const key = paths.join("\n");
  const [result, setResult] = useState<{ files: ReadonlyMap<string, string>; failed: boolean } | null>(null);

  useEffect(() => {
    const target = bookRef.current;
    if (!key || !bookKey || !target || !ready) return undefined;
    let current = true;
    const store = createBrowserBookStore(target, branch);
    const wanted = key.split("\n");
    const reading = store.readMany ? store.readMany(wanted) : Promise.all(wanted.map((path) => store.read(path))).then((files) => files.filter((file) => file !== null));
    reading
      .then((files) => {
        if (current) setResult({ files: new Map(files.map((file) => [file.path, file.content])), failed: false });
      })
      .catch(() => {
        if (current) setResult({ files: NONE, failed: true });
      });
    return () => {
      current = false;
    };
  }, [bookKey, branch, ready, key, refresh]);

  if (!key) return { files: NONE, failed: false };
  return { files: result?.files ?? null, failed: result?.failed ?? false };
}
