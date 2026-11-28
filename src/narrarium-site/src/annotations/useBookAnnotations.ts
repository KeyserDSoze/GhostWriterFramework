import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useSettingsStore } from "@/store/settingsStore";
import { loadFileContent } from "@/github/githubClient";
import { isRepositoryNotFoundError } from "@/repository/repositoryError";
import { resolveWorkingCopyToken, type BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";
import {
  ANNOTATION_TAGS_PATH,
  annotationsChapterPath,
  chapterSlugOfAnnotationsPath,
  deleteAnnotation,
  deleteTag,
  liveAnnotations,
  liveTags,
  parseBookTags,
  parseChapterAnnotations,
  upsertAnnotation,
  upsertTag,
  type BookTagsFile,
  type ChapterAnnotationsFile,
} from "./format";
import { appLanguage, tagCatalog, type Annotation, type AnnotationTagDefinition, type AppLanguage, type ResolvedTag } from "./model";
import { liveAccountTags } from "./accountTags";
import { changeBookTags, changeChapterAnnotations } from "./repository";

/**
 * The annotations of a book on the screen: the files the structure of the book read from the working copy, and over them what this tab wrote since (or
 * read again after the structure changed), so that a write shows at once without reading the whole book again. When the structure is read again (a
 * sync, a reload, another branch), a file that it holds as this tab last saw it needs nothing more; one that differs is read again from the working copy,
 * which is the truth.
 */

interface BookOverrides {
  /** By path: the text this tab last wrote or read; null for a file that is not there. */
  texts: Record<string, string | null>;
  /** By path: how many times it changed, so that a read that started before a write cannot undo it. */
  versions: Record<string, number>;
}

interface AnnotationOverridesState {
  books: Record<string, BookOverrides>;
  set: (key: string, path: string, text: string | null) => void;
  drop: (key: string, paths: string[]) => void;
}

const useAnnotationOverrides = create<AnnotationOverridesState>()((set) => ({
  books: {},
  set: (key, path, text) => set((state) => {
    const book = state.books[key] ?? { texts: {}, versions: {} };
    return { books: { ...state.books, [key]: { texts: { ...book.texts, [path]: text }, versions: { ...book.versions, [path]: (book.versions[path] ?? 0) + 1 } } } };
  }),
  drop: (key, paths) => set((state) => {
    const book = state.books[key];
    if (!book || !paths.length) return {};
    const texts = { ...book.texts };
    for (const path of paths) delete texts[path];
    return { books: { ...state.books, [key]: { ...book, texts } } };
  }),
}));

/** Forget what this tab wrote (the tests start each from nothing). */
export function resetAnnotationOverridesForTests(): void {
  useAnnotationOverrides.setState({ books: {} });
}

const parsedChapters = new Map<string, ReturnType<typeof parseChapterAnnotations>>();
const parsedTags = new Map<string, ReturnType<typeof parseBookTags>>();

function cachedParse<T>(cache: Map<string, T>, key: string, parse: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = parse();
  if (cache.size > 400) cache.clear();
  cache.set(key, value);
  return value;
}

export interface ChapterAnnotationsState {
  chapter: string;
  path: string;
  /** The file as read, when it could be read. */
  file?: ChapterAnnotationsFile;
  /** Why it could not be read: its annotations are not shown and it is not written. */
  error?: string;
  annotations: Annotation[];
}

export interface BookAnnotations {
  /** The structure was read: the counts and the lists are known. */
  ready: boolean;
  book?: BookEntry;
  branch: string;
  token: string;
  chapters: Map<string, ChapterAnnotationsState>;
  /** The file of the tags of the book, when it could be read. */
  tagsError?: string;
  bookTags: AnnotationTagDefinition[];
  catalog: ResolvedTag[];
  language: AppLanguage;
  saveAnnotation: (annotation: Annotation) => Promise<void>;
  saveAnnotations: (annotations: readonly Annotation[]) => Promise<void>;
  deleteAnnotation: (annotation: Pick<Annotation, "id" | "chapter">) => Promise<void>;
  deleteAnnotations: (annotations: ReadonlyArray<Pick<Annotation, "id" | "chapter">>) => Promise<void>;
  saveBookTag: (tag: AnnotationTagDefinition) => Promise<void>;
  deleteBookTag: (id: string) => Promise<void>;
}

function structureTexts(structure: BookStructure | undefined): Map<string, string> {
  return new Map((structure?.annotationFiles ?? []).map((file) => [file.path, file.content ?? ""]));
}

export function useBookAnnotations(bookId: string | undefined): BookAnnotations {
  const { i18n } = useTranslation();
  const language = appLanguage(i18n.resolvedLanguage ?? i18n.language);
  const { book, structure } = useBookStructure(bookId);
  const settings = useSettingsStore((state) => state.settings);
  const branch = structure?.loadedBranch ?? "";
  const key = `${bookId ?? ""}@${branch}`;
  const overrides = useAnnotationOverrides((state) => state.books[key]);
  const token = book ? resolveWorkingCopyToken(book, settings) : "";

  // When the structure is read again, what it holds as this tab last saw it needs no override; any other file is read again from the working copy.
  useEffect(() => {
    if (!structure || !book || !branch) return;
    const state = useAnnotationOverrides.getState().books[key];
    if (!state) return;
    const fromStructure = structureTexts(structure);
    const same: string[] = [];
    for (const [path, text] of Object.entries(state.texts)) {
      if ((fromStructure.get(path) ?? null) === text) {
        same.push(path);
        continue;
      }
      const version = state.versions[path] ?? 0;
      void loadFileContent(token, book.owner, book.repo, path, branch)
        .then((content) => content, (error: unknown) => (isRepositoryNotFoundError(error) ? null : undefined))
        .then((content) => {
          if (content === undefined) return;
          if ((useAnnotationOverrides.getState().books[key]?.versions[path] ?? 0) !== version) return;
          useAnnotationOverrides.getState().set(key, path, content);
        });
    }
    useAnnotationOverrides.getState().drop(key, same);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  const texts = useMemo(() => {
    const merged = structureTexts(structure);
    for (const [path, text] of Object.entries(overrides?.texts ?? {})) {
      if (text === null) merged.delete(path);
      else merged.set(path, text);
    }
    return merged;
  }, [structure, overrides]);

  const chapters = useMemo(() => {
    const result = new Map<string, ChapterAnnotationsState>();
    for (const [path, text] of texts) {
      const chapter = chapterSlugOfAnnotationsPath(path);
      if (!chapter) continue;
      const parsed = cachedParse(parsedChapters, `${chapter}\u0000${text}`, () => parseChapterAnnotations(text, chapter));
      result.set(chapter, parsed.ok
        ? { chapter, path, file: parsed.file, annotations: liveAnnotations(parsed.file) }
        : { chapter, path, error: parsed.error, annotations: [] });
    }
    return result;
  }, [texts]);

  const tags = useMemo(() => {
    const text = texts.get(ANNOTATION_TAGS_PATH);
    if (text === undefined) return { file: null as BookTagsFile | null, error: undefined as string | undefined };
    const parsed = cachedParse(parsedTags, text, () => parseBookTags(text));
    return parsed.ok ? { file: parsed.file, error: undefined } : { file: null, error: parsed.error };
  }, [texts]);

  const bookTags = useMemo(() => (tags.file ? liveTags(tags.file) : []), [tags.file]);
  const globalTags = settings.annotations?.tags;
  const catalog = useMemo(() => tagCatalog({ language, global: liveAccountTags(globalTags), book: bookTags }), [language, globalTags, bookTags]);

  const write = useCallback(async (path: string, run: () => Promise<{ text: string }>) => {
    const { text } = await run();
    useAnnotationOverrides.getState().set(key, path, text);
  }, [key]);

  const target = useMemo(() => (book && branch ? { token, book, branch } : null), [book, branch, token]);

  const saveAnnotation = useCallback(async (annotation: Annotation) => {
    if (!target) throw new Error("The book is not open.");
    await write(annotationsChapterPath(annotation.chapter), () => changeChapterAnnotations({
      ...target,
      chapterSlug: annotation.chapter,
      change: (file) => upsertAnnotation(file, annotation),
      message: `Annotate ${annotation.chapter}`,
    }));
  }, [target, write]);

  const removeAnnotation = useCallback(async (annotation: Pick<Annotation, "id" | "chapter">) => {
    if (!target) throw new Error("The book is not open.");
    await write(annotationsChapterPath(annotation.chapter), () => changeChapterAnnotations({
      ...target,
      chapterSlug: annotation.chapter,
      change: (file) => deleteAnnotation(file, annotation.id, new Date().toISOString()),
      message: `Delete an annotation of ${annotation.chapter}`,
    }));
  }, [target, write]);

  /** Several changes at once: one write for each chapter they are in (one local commit each), the changes of a chapter together. Throws what the first failed write threw. */
  const saveAnnotations = useCallback(async (annotations: readonly Annotation[]) => {
    if (!target) throw new Error("The book is not open.");
    const byChapter = new Map<string, Annotation[]>();
    for (const annotation of annotations) byChapter.set(annotation.chapter, [...(byChapter.get(annotation.chapter) ?? []), annotation]);
    for (const [chapter, list] of byChapter) {
      await write(annotationsChapterPath(chapter), () => changeChapterAnnotations({
        ...target,
        chapterSlug: chapter,
        change: (file) => list.reduce(upsertAnnotation, file),
        message: list.length === 1 ? `Annotate ${chapter}` : `Change ${list.length} annotations of ${chapter}`,
      }));
    }
  }, [target, write]);

  const removeAnnotations = useCallback(async (annotations: ReadonlyArray<Pick<Annotation, "id" | "chapter">>) => {
    if (!target) throw new Error("The book is not open.");
    const byChapter = new Map<string, string[]>();
    for (const annotation of annotations) byChapter.set(annotation.chapter, [...(byChapter.get(annotation.chapter) ?? []), annotation.id]);
    for (const [chapter, ids] of byChapter) {
      await write(annotationsChapterPath(chapter), () => changeChapterAnnotations({
        ...target,
        chapterSlug: chapter,
        change: (file) => ids.reduce((current, id) => deleteAnnotation(current, id, new Date().toISOString()), file),
        message: ids.length === 1 ? `Delete an annotation of ${chapter}` : `Delete ${ids.length} annotations of ${chapter}`,
      }));
    }
  }, [target, write]);

  const saveBookTag = useCallback(async (tag: AnnotationTagDefinition) => {
    if (!target) throw new Error("The book is not open.");
    await write(ANNOTATION_TAGS_PATH, () => changeBookTags({ ...target, change: (file) => upsertTag(file, tag), message: `Tag ${tag.name}` }));
  }, [target, write]);

  const removeBookTag = useCallback(async (id: string) => {
    if (!target) throw new Error("The book is not open.");
    await write(ANNOTATION_TAGS_PATH, () => changeBookTags({ ...target, change: (file) => deleteTag(file, id, new Date().toISOString()), message: "Delete a tag" }));
  }, [target, write]);

  return {
    ready: Boolean(structure),
    book,
    branch,
    token,
    chapters,
    tagsError: tags.error,
    bookTags,
    catalog,
    language,
    saveAnnotation,
    saveAnnotations,
    deleteAnnotation: removeAnnotation,
    deleteAnnotations: removeAnnotations,
    saveBookTag,
    deleteBookTag: removeBookTag,
  };
}
