import { isMap, parseDocument } from "yaml";
import { FrontmatterError, renderMarkdown } from "../markdown/frontmatter.js";
import { splitFrontmatter } from "../util/text.js";
import type { BookSnapshot, ChapterInfo } from "./snapshot.js";
import type { BookFileChange } from "./store.js";

/**
 * Frozen chapters. A chapter is frozen when the autopilot's director approves it, or when the author freezes it by hand: its
 * `chapter.md` then holds a record (`frozen`) of the chapter as it was. A change of its text after that (a scene edited, added,
 * removed, the body of chapter.md) is noticed from the snapshot alone, and the author is asked what to do with it.
 *
 *     frozen:
 *       at: 2026-01-01T00:00:00.000Z   # when
 *       by: autopilot                  # or author
 *       digest: 0f1e2d3c4b5a6978       # the body of chapter.md, its title heading excluded
 *       files:                         # every scene, by the name of its file in the chapter's folder
 *         001-the-arrival.md: 8a7b6c5d4e3f2a1b
 *
 * The digests are fingerprints of the TEXT of a file, never of its frontmatter: a new summary, an id rewritten by a rename, a new
 * title (and the heading of chapter.md that repeats it), line endings, spaces at the end of a line are no change of the chapter. The
 * scenes are named by their file in the folder, so a folder that is renamed or renumbered keeps its record. The fingerprint is not a
 * security hash: it tells a change, it does not protect against one.
 */

export type ChapterFreezeAuthor = "autopilot" | "author";

export const CHAPTER_FREEZE_AUTHORS: readonly ChapterFreezeAuthor[] = ["autopilot", "author"];

export interface ChapterFreeze {
  /** When it was frozen (ISO 8601, UTC). */
  at: string;
  by: ChapterFreezeAuthor;
  /** The fingerprint of the body of chapter.md, its title heading excluded (`chapterBodyDigest`). */
  digest: string;
  /** The fingerprint of the text of every scene (`sceneBodyDigest`), by the name of its file in the chapter's folder. */
  files: Record<string, string>;
}

/** What changed in a frozen chapter since it was frozen. Scene files by their name in the folder; a scene renamed with the same text is no change. */
export interface FrozenChapterChanges {
  added: string[];
  removed: string[];
  modified: string[];
  /** The body of chapter.md changed (its title heading excluded). */
  body: boolean;
}

export interface FrozenChapterChange {
  /** The chapter's number and folder. */
  number: number;
  slug: string;
  title: string;
  /** The path of its chapter.md. */
  path: string;
  by: ChapterFreezeAuthor;
  frozenAt: string;
  changed: FrozenChapterChanges;
  /**
   * The fingerprint of this change: the record and the text as it is now. The same edits give the same fingerprint (a change said once
   * is not said again), and any other edit another one.
   */
  fingerprint: string;
}

/** The codes of `FrozenChapterError`, which are also the codes of the personal server's answers to the routes of the frozen chapters. */
export const FROZEN_CHAPTER_ERROR_CODES = ["chapter_not_found", "not_changed", "invalid_action"] as const;

export type FrozenChapterErrorCode = (typeof FROZEN_CHAPTER_ERROR_CODES)[number];

/** A frozen chapter, or a change of one, that cannot be handled as asked: the chapter does not exist, nothing changed in it, or the action does not fit. */
export class FrozenChapterError extends Error {
  constructor(readonly code: FrozenChapterErrorCode, message: string) {
    super(message);
    this.name = "FrozenChapterError";
  }
}

/** Whether a code (of a `ServerRequestError`, say) is one the routes of the frozen chapters refuse with. Never throws. */
export function isFrozenChapterErrorCode(code: unknown): code is FrozenChapterErrorCode {
  return typeof code === "string" && (FROZEN_CHAPTER_ERROR_CODES as readonly string[]).includes(code);
}

// ─── Fingerprints ───────────────────────────────────────────────────────────

/** 64 bits of a fast, synchronous hash of a text (two 32-bit lanes, cyrb53's mixing), as sixteen hexadecimal characters. */
export function textFingerprint(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507);
  first ^= Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507);
  second ^= Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

/** The text as a change of it counts: one normalization of Unicode, one kind of line ending, no spaces at the end of a line or around the whole. */
function canonicalProse(text: string): string {
  return (text ?? "").normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").trim();
}

/** The fingerprint of the text of a scene (the body of its file, without the frontmatter). */
export function sceneBodyDigest(body: string): string {
  return textFingerprint(`scene\n${canonicalProse(body)}`);
}

/** The fingerprint of the body of a chapter.md: its first line, when it is the title heading (`# Title`), does not count. */
export function chapterBodyDigest(body: string): string {
  const text = canonicalProse(body);
  const lines = text.split("\n");
  const rest = /^#[ \t]/.test(lines[0] ?? "") ? lines.slice(1).join("\n").trim() : text;
  return textFingerprint(`chapter\n${rest}`);
}

// ─── Reading a record ───────────────────────────────────────────────────────

const DIGEST_SHAPE = /^[0-9a-f]{16}$/i;
/** The name of a scene's file in its chapter's folder, as the snapshot knows scenes: three digits, then anything. */
const SCENE_FILE_SHAPE = /^\d{3}(?:-[^/]*)?\.md$/;
/** A date, or a date and a time with its zone: the moments of ISO 8601 that read the same anywhere. */
const MOMENT_SHAPE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function readMoment(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== "string" || !MOMENT_SHAPE.test(value.trim())) return undefined;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function readDigest(value: unknown): string | undefined {
  return typeof value === "string" && DIGEST_SHAPE.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

/**
 * The record of a chapter.md's `frozen`, read tolerantly (any case of `by`, a moment in any zone, digests in capitals) and normalized.
 * No record (`frozen` absent, `null` or `false`) is `{}`; anything else that is not a valid record is a `problem` in plain words, and the
 * chapter then counts as not frozen: a record that cannot be read never blocks anything.
 */
export function parseChapterFreeze(value: unknown): { freeze?: ChapterFreeze; problem?: string } {
  if (value === undefined || value === null || value === false) return {};
  if (!isMapping(value)) return { problem: "frozen must be the record the app writes (at, by, digest and files), not a single value: the chapter counts as not frozen" };
  const at = readMoment(value.at);
  if (!at) return { problem: "frozen.at is not a date and time (ISO 8601): the chapter counts as not frozen" };
  const by = typeof value.by === "string" ? value.by.trim().toLowerCase() : "";
  if (!(CHAPTER_FREEZE_AUTHORS as readonly string[]).includes(by)) return { problem: "frozen.by must be autopilot or author: the chapter counts as not frozen" };
  const digest = readDigest(value.digest);
  if (!digest) return { problem: "frozen.digest is not the digest of chapter.md (sixteen hexadecimal characters): the chapter counts as not frozen" };
  if (!isMapping(value.files)) return { problem: "frozen.files must list the scenes of the chapter with their digests: the chapter counts as not frozen" };
  const files: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value.files)) {
    const fileDigest = readDigest(entry);
    if (!SCENE_FILE_SHAPE.test(name) || !fileDigest) return { problem: `frozen.files has an entry that is not a scene with its digest (${name.slice(0, 60)}): the chapter counts as not frozen` };
    files[name] = fileDigest;
  }
  return { freeze: { at, by: by as ChapterFreezeAuthor, digest, files } };
}

// ─── Making a record ────────────────────────────────────────────────────────

/** The record of a chapter from its texts: the body of chapter.md and every scene with the name of its file. What the autopilot builds from what it read. */
export function chapterFreezeRecord(input: { at: string; by: ChapterFreezeAuthor; chapterBody: string; scenes: ReadonlyArray<{ name: string; body: string }> }): ChapterFreeze {
  const files: Record<string, string> = {};
  for (const scene of [...input.scenes].sort((left, right) => left.name.localeCompare(right.name))) files[scene.name] = sceneBodyDigest(scene.body);
  return { at: readMoment(input.at) ?? input.at, by: input.by, digest: chapterBodyDigest(input.chapterBody), files };
}

/** The name of a scene's file in its chapter's folder. */
function sceneName(chapter: Pick<ChapterInfo, "slug">, path: string): string {
  const prefix = `chapters/${chapter.slug}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path.split("/").pop() ?? path;
}

function chapterOf(snapshot: BookSnapshot, slug: string): ChapterInfo {
  const chapter = snapshot.chapters.find((entry) => entry.slug === slug);
  if (!chapter) throw new FrozenChapterError("chapter_not_found", `There is no chapter in the folder chapters/${slug}.`);
  return chapter;
}

/** The record of a chapter as the snapshot read it (the digests the snapshot computed when it read the files). */
function snapshotRecord(chapter: ChapterInfo, by: ChapterFreezeAuthor, at: string): ChapterFreeze {
  const files: Record<string, string> = {};
  for (const paragraph of [...chapter.paragraphs].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!paragraph.bodyDigest) throw new Error(`The snapshot does not know the text of ${paragraph.path}: load it with loadBookSnapshot.`);
    files[sceneName(chapter, paragraph.path)] = paragraph.bodyDigest;
  }
  if (chapter.hash && !chapter.bodyDigest) throw new Error(`The snapshot does not know the text of ${chapter.path}: load it with loadBookSnapshot.`);
  return { at: readMoment(at) ?? at, by, digest: chapter.hash ? chapter.bodyDigest! : chapterBodyDigest(`# ${chapter.title}`), files };
}

/** The chapter.md of a chapter with its frontmatter patched, or the one made for a folder of scenes that has none. Refused when its frontmatter cannot be read. */
function rewriteChapterFile(chapter: ChapterInfo, patch: (frontmatter: Record<string, unknown>) => Record<string, unknown>): string {
  const document = chapter.document;
  if (chapter.hash && document?.error) throw new FrontmatterError(chapter.path, document.error, document.errorLine);
  if (chapter.hash && !document) throw new Error(`The snapshot does not know the text of ${chapter.path}: load it with loadBookSnapshot.`);
  const body = chapter.hash ? document!.body : `# ${chapter.title}`;
  const base = chapter.hash && document!.hasFrontmatter ? document!.frontmatter : { type: "chapter", id: `chapter:${chapter.slug}`, number: chapter.number, title: chapter.title };
  return renderMarkdown(patch({ ...base }), body);
}

/**
 * Freeze a chapter as it is in the snapshot: its chapter.md with the record (every other key and the body as they are; the file is
 * made for a folder of scenes that has none). One change, a compare-and-swap on the file as the snapshot read it. Pure: it reads nothing.
 * A chapter that does not exist is a `FrozenChapterError` (`chapter_not_found`), a chapter.md whose frontmatter cannot be read a
 * `FrontmatterError`: its keys would be lost.
 */
export function freezeChapterChanges(snapshot: BookSnapshot, slug: string, by: ChapterFreezeAuthor, at: string): BookFileChange[] {
  const chapter = chapterOf(snapshot, slug);
  const record = snapshotRecord(chapter, by, at);
  // A record already there keeps its place among the keys; a new one is the last key.
  const content = rewriteChapterFile(chapter, (frontmatter) => ({ ...frontmatter, frozen: record }));
  return [{ path: chapter.path, content, expectedHash: chapter.hash ?? null }];
}

/** Freeze it again as it is now, keeping who froze it: the author has seen the change, and it becomes part of the frozen text. */
export function markReviewedChanges(snapshot: BookSnapshot, slug: string, at: string): BookFileChange[] {
  const chapter = chapterOf(snapshot, slug);
  return freezeChapterChanges(snapshot, slug, chapter.frozen?.by ?? "author", at);
}

/** Take the record away (a record that cannot be read too): nothing else of the file changes. Nothing to do for a chapter that has none. */
export function unfreezeChapterChanges(snapshot: BookSnapshot, slug: string): BookFileChange[] {
  const chapter = chapterOf(snapshot, slug);
  if (!chapter.hash || !chapter.document || !Object.prototype.hasOwnProperty.call(chapter.document.frontmatter, "frozen")) return [];
  const content = rewriteChapterFile(chapter, ({ frozen: _frozen, ...rest }) => rest);
  return [{ path: chapter.path, content, expectedHash: chapter.hash }];
}

// ─── Keeping a record ───────────────────────────────────────────────────────

/** The `frozen` of a frontmatter as `parseChapterFreeze` reads it, `undefined` for no record (absent, `null`, `false`); or no reading at all. */
function frozenValueOf(yaml: string): { readable: true; value: unknown } | { readable: false } {
  try {
    const document = parseDocument(yaml);
    if (document.errors.length) return { readable: false };
    const data = document.toJSON() as unknown;
    if (data === null || data === undefined) return { readable: true, value: undefined };
    if (typeof data !== "object" || Array.isArray(data)) return { readable: false };
    const value = (data as Record<string, unknown>).frozen;
    return { readable: true, value: value === null || value === false ? undefined : value };
  } catch {
    // An alias bomb and the like: the library refuses to expand it.
    return { readable: false };
  }
}

/** A value as text whatever the order of its keys. */
function canonicalValue(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : entry,
  );
}

/**
 * chapter.md as a host writes it from a whole text it did not make itself (a proposal of a model, a tool that writes any file of the book):
 * with the `frozen` record the file holds now, exactly, and with none when it holds none. The record is the app's and the engine's to write:
 * one left out would unfreeze the chapter, and its change would go unnoticed; one made up would claim a freeze nobody gave. Everything else
 * in the text stays as written. `current` is the file as it is now (`null`: there is none). The text comes back as it is when the frontmatter
 * of either cannot be read, or when it already holds the same record. Pure; for the paths `parseChapterFilePath` reads.
 */
export function keepChapterFreeze(proposed: string, current: string | null): string {
  let kept: unknown;
  const now = current === null ? null : splitFrontmatter(current);
  if (now) {
    const reading = frozenValueOf(now.yaml);
    if (!reading.readable) return proposed;
    kept = reading.value;
  }
  const split = splitFrontmatter(proposed);
  if (!split) return kept === undefined ? proposed : renderMarkdown({ frozen: kept }, proposed);
  const reading = frozenValueOf(split.yaml);
  if (!reading.readable || canonicalValue(reading.value) === canonicalValue(kept)) return proposed;
  const document = parseDocument(split.yaml);
  if (kept === undefined) document.delete("frozen");
  else document.set("frozen", document.createNode(kept));
  const yaml = isMap(document.contents) && document.contents.items.length ? `${String(document).trimEnd()}\n` : "";
  return `---\n${yaml}---\n${split.body}`;
}

// ─── Telling a change ───────────────────────────────────────────────────────

/** What changed in one frozen chapter, or `null` when its text is what was frozen. */
function changesOf(chapter: ChapterInfo, record: ChapterFreeze): FrozenChapterChanges | null {
  const current = new Map<string, string>();
  for (const paragraph of chapter.paragraphs) if (paragraph.bodyDigest) current.set(sceneName(chapter, paragraph.path), paragraph.bodyDigest);
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [name, digest] of Object.entries(record.files)) {
    const now = current.get(name);
    if (now === undefined) removed.push(name);
    else if (now !== digest) modified.push(name);
  }
  let added = [...current.keys()].filter((name) => !(name in record.files));
  // A scene whose file was renamed with the same text is the same scene.
  if (added.length && removed.length) {
    const byDigest = new Map<string, string[]>();
    for (const name of added) byDigest.set(current.get(name)!, [...(byDigest.get(current.get(name)!) ?? []), name]);
    const renamed = new Set<string>();
    for (const name of [...removed]) {
      const twin = byDigest.get(record.files[name])?.find((candidate) => !renamed.has(candidate));
      if (!twin) continue;
      renamed.add(twin);
      removed.splice(removed.indexOf(name), 1);
    }
    added = added.filter((name) => !renamed.has(name));
  }
  const body = Boolean(chapter.bodyDigest) && chapter.bodyDigest !== record.digest;
  if (!body && !added.length && !removed.length && !modified.length) return null;
  const sort = (names: string[]) => names.sort((left, right) => left.localeCompare(right));
  return { added: sort(added), removed: sort(removed), modified: sort(modified), body };
}

/** The fingerprint of a change: the record and the text as it is now. */
function fingerprintOf(chapter: ChapterInfo, record: ChapterFreeze): string {
  const now = chapter.paragraphs.map((paragraph) => [sceneName(chapter, paragraph.path), paragraph.bodyDigest ?? ""]).sort(([left], [right]) => left.localeCompare(right));
  return textFingerprint(JSON.stringify([record.digest, Object.entries(record.files).sort(([left], [right]) => left.localeCompare(right)), chapter.bodyDigest ?? "", now]));
}

/**
 * Every frozen chapter whose text changed since it was frozen, in the order of the book. From the digests the snapshot computed when it
 * read the files (a snapshot loaded again reads only the files whose hash changed): it reads nothing, and checks thousands of chapters in
 * a few milliseconds. A chapter whose record cannot be read is not frozen, and never a change.
 */
export function frozenChanges(snapshot: BookSnapshot): FrozenChapterChange[] {
  const result: FrozenChapterChange[] = [];
  for (const chapter of snapshot.chapters) {
    const record = chapter.frozen;
    if (!record) continue;
    const changed = changesOf(chapter, record);
    if (!changed) continue;
    result.push({ number: chapter.number, slug: chapter.slug, title: chapter.title, path: chapter.path, by: record.by, frozenAt: record.at, changed, fingerprint: fingerprintOf(chapter, record) });
  }
  return result;
}
