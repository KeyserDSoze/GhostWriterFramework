import { useEffect, useRef, useState } from "react";
import { LocalWorkingCopyMissingError } from "@/autopilot/browserStore";
import { compareScenePaths, isSceneFile } from "@/autopilot/chapterReading";
import { getLocalRepository, listLocalFilesUnder } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import type { BookEntry } from "@/types/settings";

/** A scene of a chapter as the working copy has it: its file and its Markdown. */
export interface SceneFile {
  path: string;
  text: string;
}

/**
 * The scenes of one chapter, in order, read from the book's working copy in this browser with one range of keys (the folder of the chapter, nothing else of the book): no network, for a
 * book kept on this device, on a personal server or in the browser alike, since the work of each comes into the working copy. A book without a working copy here (not opened in this
 * browser yet) is `LocalWorkingCopyMissingError`. Only the chapter's scenes are given back (`isSceneFile`): never a file of the canon.
 */
export async function readChapterScenes(book: BookEntry, branch: string, slug: string): Promise<SceneFile[]> {
  const scope = captureRepositoryOperationScope();
  const meta = await getLocalRepository(book.owner, book.repo, branch, scope);
  if (!meta || meta.bookId !== book.id || meta.cloneComplete !== true) throw new LocalWorkingCopyMissingError();
  const files = await listLocalFilesUnder(meta.id, `chapters/${slug}/`, scope);
  return files
    .filter((file) => file.kind === "text" && file.text !== undefined && isSceneFile(file.path, slug))
    .map((file) => ({ path: file.path, text: file.text! }))
    .sort((left, right) => compareScenePaths(left.path, right.path));
}

export type ChapterText =
  /** The scenes are being read. */
  | { status: "loading" }
  | { status: "ready"; scenes: SceneFile[] }
  /** They could not be: `missing` says the book has no working copy in this browser yet. */
  | { status: "failed"; missing: boolean };

/**
 * The scenes of a chapter, read again when `refresh` changes. While another chapter is read there is nothing of the one before: the text on the screen is always the chapter's that is named
 * above it; a re-reading of the same chapter keeps what was read until the new text is there.
 */
export function useChapterScenes(book: BookEntry, branch: string, slug: string, refresh: unknown = null): ChapterText {
  const [read, setRead] = useState<{ slug: string; value: ChapterText } | null>(null);
  // The settings are replaced whenever they are read again: the book is the same one as long as these are.
  const bookKey = `${book.id}|${book.owner}/${book.repo}|${book.storageMode ?? ""}`;
  const bookRef = useRef(book);
  bookRef.current = book;
  useEffect(() => {
    let current = true;
    readChapterScenes(bookRef.current, branch, slug).then(
      (scenes) => {
        if (current) setRead({ slug, value: { status: "ready", scenes } });
      },
      (error: unknown) => {
        if (current) setRead({ slug, value: { status: "failed", missing: error instanceof LocalWorkingCopyMissingError } });
      },
    );
    return () => {
      current = false;
    };
  }, [bookKey, branch, slug, refresh]);
  return read && read.slug === slug ? read.value : { status: "loading" };
}
