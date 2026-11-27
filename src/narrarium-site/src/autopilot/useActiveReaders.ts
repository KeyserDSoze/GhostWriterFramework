import { useMemo } from "react";
import { DIRECTOR_FILE, activeReaders, defaultDirector, mergeReaderPersonas, parseDirector, parseReaderPersona, type DirectorProfile } from "narrarium-engine";
import { useBookFiles } from "@/autopilot/useBookFiles";
import type { BookStructure } from "@/types/book";

/** A simulated reader that reads the book in a run, with the weight the director gives it. */
export interface ActiveReader {
  slug: string;
  name: string;
  weight: number;
}

export interface ActiveReaders {
  /** The readers of a run, in the order of the panel. Empty until the files are read. */
  readers: ActiveReader[];
  /** The director as its file says it (the defaults of the book's language for a book without one). */
  director: DirectorProfile;
  /** The files are read: before that the list is not the book's. */
  ready: boolean;
}

/**
 * The simulated readers that read the chapters of the book in a run: the panel (the built-in readers and the book's own `personas/`) that is enabled and that the director does
 * not ignore (a weight of 0), as many as `maxReaders` takes: the very list the engine reads with (`activeReaders`), read from the working copy in this browser. Nothing is read when
 * `enabled` is false (a closed dialog).
 */
export function useActiveReaders(bookId: string, structure: BookStructure | undefined, maxReaders: number, enabled = true): ActiveReaders {
  const personaPaths = useMemo(() => (structure?.readerPersonas ?? []).map((entry) => entry.path), [structure?.readerPersonas]);
  const wanted = useMemo(() => (enabled ? [DIRECTOR_FILE, ...personaPaths] : []), [enabled, personaPaths]);
  const files = useBookFiles(bookId, wanted);
  const language = structure?.language;
  return useMemo(() => {
    const read = files.files;
    const directorText = read?.get(DIRECTOR_FILE);
    const director = directorText === undefined ? defaultDirector(language) : parseDirector(directorText, language);
    const overrides = personaPaths.flatMap((path) => {
      const text = read?.get(path);
      return text === undefined ? [] : [parseReaderPersona(path.slice("personas/".length, -".md".length), text)];
    });
    const panel = mergeReaderPersonas(language, overrides);
    const readers = activeReaders(panel, director, maxReaders).map((reader) => ({ slug: reader.slug, name: reader.name, weight: director.readerWeights[reader.slug] ?? 1 }));
    return { readers, director, ready: read !== null && enabled };
  }, [files.files, personaPaths, language, maxReaders, enabled]);
}
