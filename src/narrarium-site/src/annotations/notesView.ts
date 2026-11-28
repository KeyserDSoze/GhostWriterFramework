import { ANNOTATION_STATUSES, annotationStatus, isPendingStatus, type Annotation, type AnnotationStatus } from "./model";

/**
 * What the page of the notes of a book shows, as pure steps: the notes of every chapter with where they are (chapter and scene, in the order of the book),
 * filtered by chapter, tag, status and a few words, grouped by chapter, and counted by status. The page reads nothing else than these notes and the
 * structure of the book, so a long book is as quick as a short one.
 */

/** «To review» is open and later (what the badges count); the others are one status each; `all` is every note. */
export const STATUS_FILTERS = ["pending", ...ANNOTATION_STATUSES, "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export function isStatusFilter(value: string | null | undefined): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value ?? "");
}

export interface NoteItem {
  annotation: Annotation;
  /** The name of the tag as the book shows it (a removed tag has the stand-in's). */
  tagName: string;
  chapterTitle: string;
  /** The place of the chapter and of the scene in the book (a chapter or scene no longer there come last). */
  chapterOrder: number;
  sceneTitle: string;
  sceneNumber: string;
  sceneOrder: number;
}

export interface NoteFilters {
  /** A chapter slug, or `""` for every chapter. */
  chapter: string;
  /** A tag id, or `""` for every tag. */
  tag: string;
  status: StatusFilter;
  /** A few words, found in the passage, the note, the name of the tag and the title of the scene (letters without their accents or case). */
  text: string;
}

export const NO_FILTERS: NoteFilters = { chapter: "", tag: "", status: "pending", text: "" };

/** Letters as a search compares them: lower case, no accents, one space between words. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function matchesStatus(annotation: Pick<Annotation, "status">, filter: StatusFilter): boolean {
  const status = annotationStatus(annotation.status);
  return filter === "all" || (filter === "pending" ? isPendingStatus(status) : status === filter);
}

/** Every word of the search is somewhere in the note (in any order). */
export function matchesText(item: NoteItem, text: string): boolean {
  const words = normalizeSearch(text).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = normalizeSearch([item.annotation.quote, item.annotation.comment, item.tagName, item.sceneTitle, item.chapterTitle, item.annotation.resolution?.summary ?? ""].join(" "));
  return words.every((word) => haystack.includes(word));
}

export function filterNotes(items: readonly NoteItem[], filters: NoteFilters): NoteItem[] {
  return items.filter((item) =>
    (!filters.chapter || item.annotation.chapter === filters.chapter)
    && (!filters.tag || item.annotation.tag === filters.tag)
    && matchesStatus(item.annotation, filters.status)
    && matchesText(item, filters.text));
}

/** In the order of the book: chapter, scene, then where the passage was marked (the id breaks a tie: the order they were made). */
export function sortNotes(items: readonly NoteItem[]): NoteItem[] {
  return [...items].sort((left, right) => left.chapterOrder - right.chapterOrder || left.sceneOrder - right.sceneOrder || left.annotation.offset - right.annotation.offset || (left.annotation.id < right.annotation.id ? -1 : 1));
}

export interface NoteGroup {
  chapter: string;
  title: string;
  items: NoteItem[];
}

/** The notes by chapter, in the order of the book. */
export function groupNotes(items: readonly NoteItem[]): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const item of sortNotes(items)) {
    const group = groups.get(item.annotation.chapter) ?? { chapter: item.annotation.chapter, title: item.chapterTitle, items: [] };
    group.items.push(item);
    groups.set(item.annotation.chapter, group);
  }
  return [...groups.values()];
}

export type StatusCounts = Record<AnnotationStatus, number> & { pending: number; all: number };

export function statusCounts(items: readonly Pick<NoteItem, "annotation">[]): StatusCounts {
  const counts: StatusCounts = { open: 0, later: 0, handled: 0, dismissed: 0, pending: 0, all: 0 };
  for (const { annotation } of items) {
    const status = annotationStatus(annotation.status);
    counts[status] += 1;
    counts.all += 1;
    if (isPendingStatus(status)) counts.pending += 1;
  }
  return counts;
}

/** The tags the notes use, with how many notes have each (the tags of the filter: only those in use are offered). */
export function tagsInUse(items: readonly Pick<NoteItem, "annotation" | "tagName">[]): Array<{ id: string; name: string; count: number }> {
  const found = new Map<string, { id: string; name: string; count: number }>();
  for (const { annotation, tagName } of items) {
    const entry = found.get(annotation.tag) ?? { id: annotation.tag, name: tagName, count: 0 };
    entry.count += 1;
    found.set(annotation.tag, entry);
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** The filters of an address (`?chapter=&tag=&status=&q=`), with what is not valid left out. */
export function filtersFromParams(params: URLSearchParams): NoteFilters {
  const status = params.get("status");
  return { chapter: params.get("chapter") ?? "", tag: params.get("tag") ?? "", status: isStatusFilter(status) ? status : NO_FILTERS.status, text: params.get("q") ?? "" };
}

/** The address' parameters for `filters`, with every default left out (the address of an unfiltered page is clean). */
export function paramsFromFilters(filters: NoteFilters, current: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string, empty: string) => { if (value === empty) next.delete(key); else next.set(key, value); };
  set("chapter", filters.chapter, "");
  set("tag", filters.tag, "");
  set("status", filters.status, NO_FILTERS.status);
  set("q", filters.text.trim(), "");
  return next;
}
