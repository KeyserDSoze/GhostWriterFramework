import { Document, parse } from "yaml";
import {
  isTombstone,
  markToWrite,
  normalizeMarkStyle,
  type Annotation,
  type AnnotationEntry,
  type AnnotationResolution,
  type AnnotationTagDefinition,
  type AnnotationTombstone,
} from "./model.js";
import { ANNOTATION_TAGS_PATH, chapterSlugOfAnnotationsPath } from "./paths.js";
import { newerTagDefinition } from "./accountTags.js";

export { ANNOTATIONS_CHAPTERS_DIRECTORY, ANNOTATIONS_DIRECTORY, ANNOTATION_TAGS_PATH, annotationsChapterPath, chapterSlugOfAnnotationsPath, isAnnotationsPath } from "./paths.js";

/**
 * The files of the annotations in a book (docs/repository-spec.md, «Annotations»):
 *
 *   annotations/chapters/<chapter-slug>.yml   one file per chapter: the annotations of its scenes, sorted by id
 *   annotations/tags.yml                      the tags of this book
 *
 * YAML without frontmatter, outside every folder the repository checks validate, never published by the online reader. Each entry carries its own
 * `updatedAt`, and a deleted entry leaves a tombstone (its id and dates, none of its text): two copies of a file changed on two devices merge entry by
 * entry, the newer one winning (`mergeAnnotationFiles`), with no conflict for the author. Fields this version does not know, at any level, are kept as
 * they are; a file of a newer version (`version` above `ANNOTATIONS_FORMAT_VERSION`) is read and not written.
 */

export const ANNOTATIONS_FORMAT_VERSION = 1;
/** A tombstone older than this is dropped when the app writes its file: a device that stayed away longer may bring that annotation back. */
export const TOMBSTONE_RETENTION_DAYS = 90;

const CHAPTER_HEADER = " Annotations of this chapter, written by Narrarium: one entry per marked passage, sorted by id. Do not rename this file by hand.";
const TAGS_HEADER = " The annotation tags of this book, written by Narrarium.";

/** The reference of a scene the way every file of a book writes it, so that renaming and reordering scenes keep it right (githubClient.ts). */
export function paragraphRef(chapterSlug: string, paragraphSlug: string): string {
  return `paragraph:${chapterSlug}:${paragraphSlug}`;
}

/** The scene of a reference (`paragraph:001-the-gate:002-arrival` → `002-arrival`); a bare slug is taken as it is. */
export function paragraphSlugOfRef(ref: string): string {
  const match = /^paragraph:[^:]+:(.+)$/.exec(ref.trim());
  return match ? match[1] : ref.trim();
}

export interface ChapterAnnotationsFile {
  version: number;
  chapter: string;
  entries: AnnotationEntry[];
  /** Entries without an id (a hand edit): kept as they are, never shown. */
  invalid: unknown[];
  extra: Record<string, unknown>;
}

export interface BookTagsFile {
  version: number;
  tags: AnnotationTagDefinition[];
  invalid: unknown[];
  extra: Record<string, unknown>;
}

// Each side names the other's field as absent, so that the error and the file can be read whether or not the compiler narrows the result.
export type ParseResult<T> = { ok: true; file: T; error?: undefined } | { ok: false; error: string; file?: undefined };

export function emptyChapterAnnotations(chapterSlug: string): ChapterAnnotationsFile {
  return { version: ANNOTATIONS_FORMAT_VERSION, chapter: chapterSlug, entries: [], invalid: [], extra: {} };
}

export function emptyBookTags(): BookTagsFile {
  return { version: ANNOTATIONS_FORMAT_VERSION, tags: [], invalid: [], extra: {} };
}

/** The annotations of a chapter file, without its tombstones. */
export function liveAnnotations(file: ChapterAnnotationsFile): Annotation[] {
  return file.entries.filter((entry): entry is Annotation => !isTombstone(entry));
}

export function liveTags(file: BookTagsFile): AnnotationTagDefinition[] {
  return file.tags.filter((tag) => !tag.deletedAt);
}

/** Whether this version may write the file: one of a newer version is only read. */
export function isWritableVersion(version: number): boolean {
  return version <= ANNOTATIONS_FORMAT_VERSION;
}

const text = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const pickExtra = (record: Record<string, unknown>, known: readonly string[]): Record<string, unknown> | undefined => {
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => !known.includes(key)));
  return Object.keys(extra).length ? extra : undefined;
};

const ANNOTATION_KEYS = ["id", "paragraph", "quote", "prefix", "suffix", "offset", "tag", "comment", "status", "resolution", "createdAt", "updatedAt", "createdOnDevice"] as const;
const RESOLUTION_KEYS = ["by", "at", "summary"] as const;
const TOMBSTONE_KEYS = ["id", "deletedAt", "updatedAt"] as const;
const FILE_KEYS = ["version", "chapter", "annotations"] as const;
const TAG_KEYS = ["id", "name", "description", "mark", "createdAt", "updatedAt", "deletedAt"] as const;
const TAGS_FILE_KEYS = ["version", "tags"] as const;

function readVersion(record: Record<string, unknown>): number {
  const version = record.version;
  return typeof version === "number" && Number.isFinite(version) && version >= 1 ? Math.floor(version) : ANNOTATIONS_FORMAT_VERSION;
}

function readEntry(raw: unknown, chapterSlug: string): AnnotationEntry | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  if (!id) return null;
  if (typeof raw.deletedAt === "string" && raw.deletedAt) {
    const tombstone: AnnotationTombstone = { id, deletedAt: raw.deletedAt, updatedAt: text(raw.updatedAt, raw.deletedAt) };
    const extra = pickExtra(raw, TOMBSTONE_KEYS);
    return extra ? { ...tombstone, extra } : tombstone;
  }
  const offset = typeof raw.offset === "number" && Number.isFinite(raw.offset) && raw.offset >= 0 ? Math.floor(raw.offset) : 0;
  const annotation: Annotation = {
    id,
    chapter: chapterSlug,
    paragraph: paragraphSlugOfRef(text(raw.paragraph)),
    quote: text(raw.quote),
    prefix: text(raw.prefix),
    suffix: text(raw.suffix),
    offset,
    tag: text(raw.tag),
    comment: text(raw.comment),
    status: text(raw.status, "open") || "open",
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
    createdOnDevice: text(raw.createdOnDevice),
  };
  const resolution = readResolution(raw.resolution);
  if (resolution) annotation.resolution = resolution;
  const extra = pickExtra(raw, ANNOTATION_KEYS);
  return extra ? { ...annotation, extra } : annotation;
}

function readResolution(raw: unknown): AnnotationResolution | undefined {
  if (!isRecord(raw)) return undefined;
  const by = text(raw.by).trim();
  if (!by) return undefined;
  const summary = text(raw.summary).trim();
  const extra = pickExtra(raw, RESOLUTION_KEYS);
  return { by, at: text(raw.at), ...(summary ? { summary } : {}), ...(extra ? { extra } : {}) };
}

/** The chapter of the file is its name: what the file says inside is only a check. */
export function parseChapterAnnotations(source: string, chapterSlug: string): ParseResult<ChapterAnnotationsFile> {
  let data: unknown;
  try {
    data = source.trim() ? parse(source) : {};
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (data === null || data === undefined) data = {};
  if (!isRecord(data)) return { ok: false, error: "The file is not a map of version, chapter and annotations." };
  if (data.annotations !== undefined && data.annotations !== null && !Array.isArray(data.annotations)) return { ok: false, error: "annotations is not a list." };
  const entries: AnnotationEntry[] = [];
  const invalid: unknown[] = [];
  const seen = new Set<string>();
  for (const raw of (data.annotations as unknown[] | undefined | null) ?? []) {
    const entry = readEntry(raw, chapterSlug);
    if (!entry) { invalid.push(raw); continue; }
    if (seen.has(entry.id)) {
      // The same id twice (a hand merge): the newer one stays, as when two copies merge.
      const index = entries.findIndex((other) => other.id === entry.id);
      entries[index] = newerEntry(entries[index], entry);
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  entries.sort(byId);
  return { ok: true, file: { version: readVersion(data), chapter: chapterSlug, entries, invalid, extra: pickExtra(data, FILE_KEYS) ?? {} } };
}

function writeEntry(entry: AnnotationEntry, chapterSlug: string): Record<string, unknown> {
  if (isTombstone(entry)) return { id: entry.id, deletedAt: entry.deletedAt, updatedAt: entry.updatedAt, ...sortedRecord(entry.extra) };
  return {
    id: entry.id,
    paragraph: paragraphRef(chapterSlug, entry.paragraph),
    quote: entry.quote,
    prefix: entry.prefix,
    suffix: entry.suffix,
    offset: entry.offset,
    tag: entry.tag,
    comment: entry.comment,
    status: entry.status,
    ...(entry.resolution ? { resolution: writeResolution(entry.resolution) } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    createdOnDevice: entry.createdOnDevice,
    ...sortedRecord(entry.extra),
  };
}

function writeResolution(resolution: AnnotationResolution): Record<string, unknown> {
  return { by: resolution.by, at: resolution.at, ...(resolution.summary ? { summary: resolution.summary } : {}), ...sortedRecord(resolution.extra) };
}

function sortedRecord(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!record) return {};
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function render(value: Record<string, unknown>, header: string): string {
  const document = new Document(value);
  document.commentBefore = header;
  return document.toString({ lineWidth: 0, minContentWidth: 0 });
}

/** The text of a chapter file: always the same for the same annotations (entries sorted by id, keys in a fixed order), so diffs stay small. */
export function serializeChapterAnnotations(file: ChapterAnnotationsFile): string {
  const entries = [...file.entries].sort(byId);
  return render({
    version: file.version,
    chapter: `chapter:${file.chapter}`,
    ...sortedRecord(file.extra),
    annotations: [...entries.map((entry) => writeEntry(entry, file.chapter)), ...file.invalid],
  }, CHAPTER_HEADER);
}

function readTag(raw: unknown): AnnotationTagDefinition | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id).trim();
  if (!id) return null;
  const tag: AnnotationTagDefinition = {
    id,
    name: text(raw.name).trim(),
    description: text(raw.description),
    mark: normalizeMarkStyle(raw.mark),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  };
  if (typeof raw.deletedAt === "string" && raw.deletedAt) tag.deletedAt = raw.deletedAt;
  const markExtra = isRecord(raw.mark) ? pickExtra(raw.mark, ["underline", "color", "icon"]) : undefined;
  // The values of a newer app are shown as the stand-in's and written back as they were (markToWrite).
  const markStored = isRecord(raw.mark) && (["underline", "color", "icon"] as const).some((key) => typeof (raw.mark as Record<string, unknown>)[key] === "string" && (raw.mark as Record<string, unknown>)[key] !== tag.mark[key])
    ? { underline: (raw.mark as Record<string, unknown>).underline, color: (raw.mark as Record<string, unknown>).color, icon: (raw.mark as Record<string, unknown>).icon }
    : undefined;
  const extra = { ...(pickExtra(raw, TAG_KEYS) ?? {}), ...(markExtra ? { markExtra } : {}), ...(markStored ? { markStored } : {}) };
  return Object.keys(extra).length ? { ...tag, extra } : tag;
}

export function parseBookTags(source: string): ParseResult<BookTagsFile> {
  let data: unknown;
  try {
    data = source.trim() ? parse(source) : {};
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (data === null || data === undefined) data = {};
  if (!isRecord(data)) return { ok: false, error: "The file is not a map of version and tags." };
  if (data.tags !== undefined && data.tags !== null && !Array.isArray(data.tags)) return { ok: false, error: "tags is not a list." };
  const tags: AnnotationTagDefinition[] = [];
  const invalid: unknown[] = [];
  for (const raw of (data.tags as unknown[] | undefined | null) ?? []) {
    const tag = readTag(raw);
    if (!tag) { invalid.push(raw); continue; }
    const index = tags.findIndex((other) => other.id === tag.id);
    if (index >= 0) tags[index] = newerTag(tags[index], tag);
    else tags.push(tag);
  }
  tags.sort(byId);
  return { ok: true, file: { version: readVersion(data), tags, invalid, extra: pickExtra(data, TAGS_FILE_KEYS) ?? {} } };
}

function writeTag(tag: AnnotationTagDefinition): Record<string, unknown> {
  const { markExtra, markStored, ...extra } = (tag.extra ?? {}) as Record<string, unknown> & { markExtra?: Record<string, unknown>; markStored?: unknown };
  const mark = markToWrite(markStored, tag.mark);
  return {
    id: tag.id,
    name: tag.name,
    description: tag.description,
    mark: { underline: mark.underline, color: mark.color, icon: mark.icon, ...sortedRecord(isRecord(markExtra) ? markExtra : undefined) },
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
    ...(tag.deletedAt ? { deletedAt: tag.deletedAt } : {}),
    ...sortedRecord(extra),
  };
}

export function serializeBookTags(file: BookTagsFile): string {
  return render({ version: file.version, ...sortedRecord(file.extra), tags: [...[...file.tags].sort(byId).map(writeTag), ...file.invalid] }, TAGS_HEADER);
}

// ─── Merging two copies ────────────────────────────────────────────────────────────────────────────────────────────────

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => isRecord(inner) ? sortedRecord(inner) : inner);
}

/** The newer of two versions of one entry: the later `updatedAt`; at the same moment a deletion wins, then a fixed order of their content. */
export function newerEntry(left: AnnotationEntry, right: AnnotationEntry): AnnotationEntry {
  const leftTime = timeOf(left.updatedAt);
  const rightTime = timeOf(right.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (isTombstone(left) !== isTombstone(right)) return isTombstone(left) ? left : right;
  return canonical(left) >= canonical(right) ? left : right;
}

const newerTag = newerTagDefinition;

function unionOf(left: unknown[], right: unknown[]): unknown[] {
  const seen = new Set(left.map(canonical));
  return [...left, ...right.filter((entry) => !seen.has(canonical(entry)))];
}

/**
 * Two copies of a chapter file as one: every entry of either, and of an entry in both the newer version (`newerEntry`). The same result whichever copy
 * comes first, and merging a copy into itself changes nothing, so two devices that merge each other's copies end with the same file.
 */
export function mergeChapterAnnotations(left: ChapterAnnotationsFile, right: ChapterAnnotationsFile): ChapterAnnotationsFile {
  const byEntryId = new Map<string, AnnotationEntry>();
  for (const entry of [...left.entries, ...right.entries]) {
    const current = byEntryId.get(entry.id);
    byEntryId.set(entry.id, current ? newerEntry(current, entry) : entry);
  }
  const [first, second] = canonical(left.extra) <= canonical(right.extra) ? [left, right] : [right, left];
  return {
    version: Math.max(left.version, right.version),
    chapter: left.chapter,
    entries: [...byEntryId.values()].sort(byId),
    invalid: unionOf(first.invalid, second.invalid),
    extra: { ...second.extra, ...first.extra },
  };
}

export function mergeBookTags(left: BookTagsFile, right: BookTagsFile): BookTagsFile {
  const byTagId = new Map<string, AnnotationTagDefinition>();
  for (const tag of [...left.tags, ...right.tags]) {
    const current = byTagId.get(tag.id);
    byTagId.set(tag.id, current ? newerTag(current, tag) : tag);
  }
  const [first, second] = canonical(left.extra) <= canonical(right.extra) ? [left, right] : [right, left];
  return { version: Math.max(left.version, right.version), tags: [...byTagId.values()].sort(byId), invalid: unionOf(first.invalid, second.invalid), extra: { ...second.extra, ...first.extra } };
}

/**
 * The merged text of two copies of a file of annotations that both changed (this device's and GitHub's), or null when the path is not one or either
 * copy cannot be read: then the usual choice between the two is offered.
 */
export function mergeAnnotationTexts(path: string, local: string, remote: string): string | null {
  const chapterSlug = chapterSlugOfAnnotationsPath(path);
  if (chapterSlug) {
    const mine = parseChapterAnnotations(local, chapterSlug);
    const theirs = parseChapterAnnotations(remote, chapterSlug);
    if (!mine.ok || !theirs.ok) return null;
    return serializeChapterAnnotations(mergeChapterAnnotations(mine.file, theirs.file));
  }
  if (path === ANNOTATION_TAGS_PATH) {
    const mine = parseBookTags(local);
    const theirs = parseBookTags(remote);
    if (!mine.ok || !theirs.ok) return null;
    return serializeBookTags(mergeBookTags(mine.file, theirs.file));
  }
  return null;
}

/** The file without the tombstones older than `TOMBSTONE_RETENTION_DAYS`: what the app writes. */
export function pruneTombstones(file: ChapterAnnotationsFile, now: Date): ChapterAnnotationsFile {
  const limit = now.getTime() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return { ...file, entries: file.entries.filter((entry) => !isTombstone(entry) || timeOf(entry.deletedAt) >= limit) };
}

export function pruneTagTombstones(file: BookTagsFile, now: Date): BookTagsFile {
  const limit = now.getTime() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return { ...file, tags: file.tags.filter((tag) => !tag.deletedAt || timeOf(tag.deletedAt) >= limit) };
}

// ─── Changes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The file with `annotation` added or replacing the entry with its id. */
export function upsertAnnotation(file: ChapterAnnotationsFile, annotation: Annotation): ChapterAnnotationsFile {
  return { ...file, entries: [...file.entries.filter((entry) => entry.id !== annotation.id), annotation].sort(byId) };
}

/** The file with the annotation replaced by its tombstone. */
export function deleteAnnotation(file: ChapterAnnotationsFile, id: string, now: string): ChapterAnnotationsFile {
  if (!file.entries.some((entry) => entry.id === id)) return file;
  return { ...file, entries: file.entries.map((entry) => (entry.id === id ? { id, deletedAt: now, updatedAt: now } : entry)) };
}

export function upsertTag(file: BookTagsFile, tag: AnnotationTagDefinition): BookTagsFile {
  return { ...file, tags: [...file.tags.filter((entry) => entry.id !== tag.id), tag].sort(byId) };
}

export function deleteTag(file: BookTagsFile, id: string, now: string): BookTagsFile {
  return { ...file, tags: file.tags.map((tag) => (tag.id === id ? { ...tag, deletedAt: now, updatedAt: now } : tag)) };
}
