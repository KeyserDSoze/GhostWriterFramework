import { captureImmediateMutation, commitImmediateMutation } from "@/assistant/immediateMutation";
import { localDeviceId } from "@/account/deviceIdentity";
import { RepositoryConflictError } from "@/repository/safeRepositoryMutation";
import { isRepositoryError } from "@/repository/repositoryError";
import type { BookEntry } from "@/types/settings";
import {
  ANNOTATION_TAGS_PATH,
  annotationsChapterPath,
  emptyBookTags,
  emptyChapterAnnotations,
  isWritableVersion,
  parseBookTags,
  parseChapterAnnotations,
  pruneTagTombstones,
  pruneTombstones,
  serializeBookTags,
  serializeChapterAnnotations,
  type BookTagsFile,
  type ChapterAnnotationsFile,
  type ParseResult,
} from "./format";

/**
 * The writes of the annotations: each one a local commit of the working copy through the immediate path of every book file (`commitImmediateMutation`),
 * published by the next sync, so it works for a book kept on this device, for a GitHub book without a credential and offline. The file is read again
 * right before each write and the change applied to what it holds then (another tab, or a sync, may have changed it); a write that finds the file
 * changed under it starts again. Writes of one file wait for each other.
 */

export type AnnotationsFileProblem = "unreadable" | "newer-version";

export class AnnotationsFileError extends Error {
  constructor(readonly problem: AnnotationsFileProblem, readonly path: string, detail = "") {
    super(problem === "unreadable" ? `The annotations file ${path} cannot be read${detail ? `: ${detail}` : ""}.` : `The annotations file ${path} was written by a newer version of Narrarium.`);
    this.name = "AnnotationsFileError";
  }
}

export interface AnnotationsWriteTarget {
  token: string;
  book: BookEntry;
  branch: string;
}

const queues = new Map<string, Promise<unknown>>();

/** One write of a file at a time, in the order they were asked for. */
function queued<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

const isChangedUnderIt = (error: unknown) => error instanceof RepositoryConflictError || isRepositoryError(error, "conflict");

async function writeFile<T extends { version: number }>(input: AnnotationsWriteTarget & {
  path: string;
  empty: () => T;
  parse: (text: string) => ParseResult<T>;
  prune: (file: T) => T;
  serialize: (file: T) => string;
  change: (file: T) => T;
  message: string;
}): Promise<{ text: string; file: T }> {
  return queued(`${input.book.id}@${input.branch}:${input.path}`, async () => {
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await captureImmediateMutation({ token: input.token, book: input.book, branch: input.branch, path: input.path });
      let current: T;
      if (snapshot.content === null) current = input.empty();
      else {
        const parsed = input.parse(snapshot.content);
        // A file that cannot be read is never replaced: what is in it would be lost.
        if (!parsed.ok) throw new AnnotationsFileError("unreadable", input.path, parsed.error);
        current = parsed.file;
      }
      if (!isWritableVersion(current.version)) throw new AnnotationsFileError("newer-version", input.path);
      const file = input.prune(input.change(current));
      const text = input.serialize(file);
      if (text === snapshot.content) return { text, file };
      try {
        await commitImmediateMutation({ token: input.token, book: input.book, branch: input.branch, snapshot, content: text, message: input.message });
        return { text, file };
      } catch (error) {
        if (attempt < 2 && isChangedUnderIt(error)) continue;
        throw error;
      }
    }
  });
}

export function changeChapterAnnotations(input: AnnotationsWriteTarget & { chapterSlug: string; change: (file: ChapterAnnotationsFile) => ChapterAnnotationsFile; message: string }) {
  return writeFile<ChapterAnnotationsFile>({
    ...input,
    path: annotationsChapterPath(input.chapterSlug),
    empty: () => emptyChapterAnnotations(input.chapterSlug),
    parse: (text) => parseChapterAnnotations(text, input.chapterSlug),
    prune: (file) => pruneTombstones(file, new Date()),
    serialize: serializeChapterAnnotations,
  });
}

export function changeBookTags(input: AnnotationsWriteTarget & { change: (file: BookTagsFile) => BookTagsFile; message: string }) {
  return writeFile<BookTagsFile>({
    ...input,
    path: ANNOTATION_TAGS_PATH,
    empty: emptyBookTags,
    parse: parseBookTags,
    prune: (file) => pruneTagTombstones(file, new Date()),
    serialize: serializeBookTags,
  });
}

let deviceTagPromise: Promise<string> | null = null;

/** A short opaque tag of this device for `createdOnDevice`: derived from its id, which itself never goes into a book. */
export function deviceTag(): Promise<string> {
  deviceTagPromise ??= (async () => {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`narrarium-annotations:${localDeviceId()}`));
      return `d-${Array.from(new Uint8Array(digest).slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      return "d-unknown";
    }
  })();
  return deviceTagPromise;
}
