import { useCallback, useEffect, useState } from "react";
import { bookChapters } from "narrarium-engine";
import { EMPTY_OUTLINE_BRIEF, briefOfFiles, type OutlineBrief } from "@/autopilot/outlineBrief";
import { browserOutlineSource } from "@/outline/outlineSource";
import { snapshotOf } from "@/outline/outlineModel";
import type { BookEntry } from "@/types/settings";

export interface OutlineBriefOfBook {
  /** The brief as the file says it (the empty one until it is read, or when it is not there). */
  brief: OutlineBrief;
  /** The chapter entries of the Scaletta: what the autopilot writes, chapter by chapter. */
  chapters: number;
  /** The number of the last chapter entry: the chapters of the book (the engine's `bookChapters`); 0 when the Scaletta has none. */
  lastChapter: number;
  /** Whether the Scaletta could be read: `false` when the book has no working copy in this browser or the read failed. */
  readable: boolean;
  /** Whether the first read is done. */
  loaded: boolean;
  reload: () => void;
}

/**
 * The brief and the number of chapter entries of a book, read from its Scaletta in this browser. The configuration of the autopilot shows and sends them,
 * and the Scaletta page edits them: nothing here writes a file.
 */
export function useOutlineBriefOf(book: BookEntry | undefined, branch: string | undefined): OutlineBriefOfBook {
  const [state, setState] = useState<Omit<OutlineBriefOfBook, "reload">>({ brief: EMPTY_OUTLINE_BRIEF, chapters: 0, lastChapter: 0, readable: false, loaded: false });
  const [revision, setRevision] = useState(0);
  const bookKey = book ? `${book.id}|${book.owner}/${book.repo}|${book.localRepositoryId ?? ""}` : "";
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!book || !branch) return undefined;
    let current = true;
    browserOutlineSource(book, branch).files()
      .then(async (files) => {
        const snapshot = await snapshotOf(files);
        // The idea is the description of the book, composed with the fields of the brief as the engine composes them.
        const brief = (await briefOfFiles(files)).brief;
        if (current) setState({ brief, chapters: snapshot.outline.chapters.length, lastChapter: bookChapters({ lastChapter: Math.max(0, ...snapshot.outline.chapters.map((entry) => entry.number)) }), readable: true, loaded: true });
      })
      .catch(() => {
        if (current) setState((previous) => ({ ...previous, readable: false, loaded: true }));
      });
    return () => {
      current = false;
    };
  }, [bookKey, branch, revision]);

  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  return { ...state, reload };
}
