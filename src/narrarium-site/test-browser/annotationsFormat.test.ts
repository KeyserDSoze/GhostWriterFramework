import { describe, expect, it } from "vitest";
import {
  ANNOTATION_TAGS_PATH,
  TOMBSTONE_RETENTION_DAYS,
  annotationsChapterPath,
  chapterSlugOfAnnotationsPath,
  deleteAnnotation,
  deleteTag,
  emptyBookTags,
  emptyChapterAnnotations,
  isAnnotationsPath,
  isWritableVersion,
  liveAnnotations,
  liveTags,
  mergeAnnotationTexts,
  mergeBookTags,
  mergeChapterAnnotations,
  paragraphRef,
  paragraphSlugOfRef,
  parseBookTags,
  parseChapterAnnotations,
  pruneTombstones,
  serializeBookTags,
  serializeChapterAnnotations,
  upsertAnnotation,
  upsertTag,
  type ChapterAnnotationsFile,
} from "@/annotations/format";
import { markToWrite, type Annotation, type AnnotationTagDefinition } from "@/annotations/model";

const CHAPTER = "001-the-gate";

function annotation(id: string, patch: Partial<Annotation> = {}): Annotation {
  return {
    id,
    chapter: CHAPTER,
    paragraph: "001-opening",
    quote: "the color of old steel",
    prefix: "The gate stood open beneath a sky ",
    suffix: ". Mara waited by the wall, countin",
    offset: 34,
    tag: "rewrite",
    comment: "",
    status: "open",
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
    createdOnDevice: "d-1a2b3c4d",
    ...patch,
  };
}

function fileOf(...annotations: Annotation[]): ChapterAnnotationsFile {
  return annotations.reduce(upsertAnnotation, emptyChapterAnnotations(CHAPTER));
}

function parsed(text: string, chapter = CHAPTER): ChapterAnnotationsFile {
  const result = parseChapterAnnotations(text, chapter);
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

describe("the paths of the annotations", () => {
  it("are one file per chapter under annotations/chapters and one for the tags of the book", () => {
    expect(annotationsChapterPath(CHAPTER)).toBe("annotations/chapters/001-the-gate.yml");
    expect(chapterSlugOfAnnotationsPath("annotations/chapters/001-the-gate.yml")).toBe(CHAPTER);
    expect(chapterSlugOfAnnotationsPath("annotations/chapters/x/001.yml")).toBeNull();
    expect(chapterSlugOfAnnotationsPath("chapters/001-the-gate/chapter.md")).toBeNull();
    expect(isAnnotationsPath(ANNOTATION_TAGS_PATH)).toBe(true);
    expect(isAnnotationsPath("annotations/chapters/002-x.yml")).toBe(true);
    expect(isAnnotationsPath("annotations/readme.md")).toBe(false);
  });

  it("name a scene the way every file of a book does, so that renaming and reordering scenes rewrite it", () => {
    expect(paragraphRef(CHAPTER, "002-the-bell")).toBe("paragraph:001-the-gate:002-the-bell");
    expect(paragraphSlugOfRef("paragraph:001-the-gate:002-the-bell")).toBe("002-the-bell");
    expect(paragraphSlugOfRef("002-the-bell")).toBe("002-the-bell");
  });
});

describe("a chapter file", () => {
  it("is YAML without frontmatter, entries sorted by id and keys in a fixed order", () => {
    const text = serializeChapterAnnotations(fileOf(
      annotation("a-mi4k3000-zzzzzz", { comment: "Second" }),
      annotation("a-mi4k2000-aaaaaa", { comment: "First" }),
    ));
    expect(text.startsWith("---")).toBe(false);
    expect(text).toBe([
      "# Annotations of this chapter, written by Narrarium: one entry per marked passage, sorted by id. Do not rename this file by hand.",
      "",
      "version: 1",
      "chapter: chapter:001-the-gate",
      "annotations:",
      "  - id: a-mi4k2000-aaaaaa",
      "    paragraph: paragraph:001-the-gate:001-opening",
      "    quote: the color of old steel",
      "    prefix: \"The gate stood open beneath a sky \"",
      "    suffix: . Mara waited by the wall, countin",
      "    offset: 34",
      "    tag: rewrite",
      "    comment: First",
      "    status: open",
      "    createdAt: 2026-11-25T10:00:00.000Z",
      "    updatedAt: 2026-11-25T10:00:00.000Z",
      "    createdOnDevice: d-1a2b3c4d",
      "  - id: a-mi4k3000-zzzzzz",
      "    paragraph: paragraph:001-the-gate:001-opening",
      "    quote: the color of old steel",
      "    prefix: \"The gate stood open beneath a sky \"",
      "    suffix: . Mara waited by the wall, countin",
      "    offset: 34",
      "    tag: rewrite",
      "    comment: Second",
      "    status: open",
      "    createdAt: 2026-11-25T10:00:00.000Z",
      "    updatedAt: 2026-11-25T10:00:00.000Z",
      "    createdOnDevice: d-1a2b3c4d",
      "",
    ].join("\n"));
  });

  it("reads back what it wrote, and writes the same text again", () => {
    const file = fileOf(annotation("a-1", { paragraph: "002-the-bell", comment: "Too familiar.", status: "later", offset: 0 }), annotation("a-2"));
    const text = serializeChapterAnnotations(file);
    const back = parsed(text);
    expect(back).toEqual(file);
    expect(liveAnnotations(back).map((entry) => entry.chapter)).toEqual([CHAPTER, CHAPTER]);
    expect(serializeChapterAnnotations(back)).toBe(text);
  });

  it("writes how an annotation was handled after its status, and keeps what a newer app added to it", () => {
    const handled = annotation("a-1", { status: "handled", resolution: { by: "autopilot", at: "2026-11-26T08:00:00.000Z", summary: "Rewrote the image: «the color of old steel» is gone." } });
    const text = serializeChapterAnnotations(fileOf(handled));
    expect(text).toContain("    status: handled\n    resolution:\n      by: autopilot\n      at: 2026-11-26T08:00:00.000Z\n      summary: \"Rewrote the image");
    expect(parsed(text)).toEqual(fileOf(handled));
    const future = text.replace("      by: autopilot\n", "      by: autopilot\n      model: slow\n");
    const back = parsed(future);
    expect(liveAnnotations(back)[0].resolution).toMatchObject({ by: "autopilot", extra: { model: "slow" } });
    expect(serializeChapterAnnotations(back)).toContain("      model: slow\n");
    // A resolution without who is not one; an open note has none.
    expect(liveAnnotations(parsed(text.replace("by: autopilot", "by: ''")))[0].resolution).toBeUndefined();
    expect(serializeChapterAnnotations(fileOf(annotation("a-2")))).not.toContain("resolution");
  });

  it("keeps any text exactly: colons, hashes, quotes, new lines, leading and trailing spaces, emoji, words YAML would read as values", () => {
    const awkward = [
      "x: y # not a comment", " leading space", "trailing space ", "\"quoted\" and 'single'", "line one\nline two\n", "1984", "no", "yes", "null", "~",
      "- a list?", "😀 emoji", "tab\tinside", "{ not: a map }", "[not, a, list]", "", "@at", "`tick`", "%percent", "*star", "&amp",
    ];
    for (const value of awkward) {
      const file = fileOf(annotation("a-1", { quote: value, prefix: value, suffix: value, comment: value }));
      const back = liveAnnotations(parsed(serializeChapterAnnotations(file)))[0];
      expect(back.quote, JSON.stringify(value)).toBe(value);
      expect(back.comment, JSON.stringify(value)).toBe(value);
    }
  });

  it("keeps what a newer app wrote: fields of an annotation, fields of the file, a status it does not know, entries without an id", () => {
    const text = [
      "version: 1",
      "chapter: chapter:001-the-gate",
      "reviewedBy: director",
      "annotations:",
      "  - id: a-1",
      "    paragraph: paragraph:001-the-gate:001-opening",
      "    quote: the gate",
      "    prefix: ''",
      "    suffix: ' stood'",
      "    offset: 0",
      "    tag: rewrite",
      "    comment: ''",
      "    status: proposed",
      "    createdAt: 2026-11-25T10:00:00.000Z",
      "    updatedAt: 2026-11-25T10:00:00.000Z",
      "    createdOnDevice: d-1",
      "    aiProposal:",
      "      text: The gate was open.",
      "      model: some-model",
      "  - note: an entry someone wrote by hand",
    ].join("\n");
    const file = parsed(text);
    const [entry] = liveAnnotations(file);
    expect(entry.status).toBe("proposed");
    expect(entry.extra).toEqual({ aiProposal: { text: "The gate was open.", model: "some-model" } });
    expect(file.extra).toEqual({ reviewedBy: "director" });
    expect(file.invalid).toEqual([{ note: "an entry someone wrote by hand" }]);
    const again = parsed(serializeChapterAnnotations(upsertAnnotation(file, { ...entry, comment: "Edited here" })));
    expect(liveAnnotations(again)[0]).toMatchObject({ status: "proposed", comment: "Edited here", extra: { aiProposal: { text: "The gate was open.", model: "some-model" } } });
    expect(again.extra).toEqual({ reviewedBy: "director" });
    expect(again.invalid).toEqual([{ note: "an entry someone wrote by hand" }]);
  });

  it("is read with care when it was edited by hand: values coerced to text, a bare scene slug, a missing status", () => {
    const file = parsed([
      "annotations:",
      "  - id: 42",
      "    paragraph: 002-the-bell",
      "    quote: 1984",
      "    offset: -3",
    ].join("\n"));
    expect(liveAnnotations(file)[0]).toMatchObject({ id: "42", paragraph: "002-the-bell", quote: "1984", offset: 0, status: "open", comment: "", chapter: CHAPTER });
    expect(file.version).toBe(1);
  });

  it("an empty file is an empty chapter; YAML that cannot be read, or is not a map, is an error and never an empty list", () => {
    expect(parsed("")).toEqual(emptyChapterAnnotations(CHAPTER));
    expect(parsed("# only a comment\n")).toEqual(emptyChapterAnnotations(CHAPTER));
    expect(parseChapterAnnotations("annotations: [unclosed", CHAPTER).ok).toBe(false);
    expect(parseChapterAnnotations("- a list", CHAPTER).ok).toBe(false);
    expect(parseChapterAnnotations("annotations: not a list", CHAPTER).ok).toBe(false);
  });

  it("the chapter is the name of the file: a file moved with its chapter is read as the new chapter's", () => {
    const text = serializeChapterAnnotations(fileOf(annotation("a-1")));
    const moved = parsed(text, "002-the-gate");
    expect(liveAnnotations(moved)[0].chapter).toBe("002-the-gate");
  });

  it("follows a reorder of chapters and scenes done by rewriting references, as the app does in every text file of a book", () => {
    const text = serializeChapterAnnotations(fileOf(annotation("a-1", { paragraph: "001-opening" })));
    // githubClient.ts: reorderChaptersInBook replaces chapter:<old> and paragraph:<old>:, reorderParagraphsInChapter replaces paragraph:<chapter>:<old>.
    const rewritten = text.split("chapter:001-the-gate").join("chapter:002-the-gate").split("paragraph:001-the-gate:").join("paragraph:002-the-gate:")
      .split("paragraph:002-the-gate:001-opening").join("paragraph:002-the-gate:003-opening");
    const file = parsed(rewritten, "002-the-gate");
    expect(liveAnnotations(file)[0]).toMatchObject({ chapter: "002-the-gate", paragraph: "003-opening" });
  });

  it("a file of a newer version is read, not written", () => {
    expect(parsed("version: 2\nannotations: []\n").version).toBe(2);
    expect(isWritableVersion(1)).toBe(true);
    expect(isWritableVersion(2)).toBe(false);
  });
});

describe("deleting", () => {
  it("leaves a tombstone with the id and the dates and none of the text", () => {
    const file = deleteAnnotation(fileOf(annotation("a-1", { comment: "private thought" }), annotation("a-2")), "a-1", "2026-11-26T09:00:00.000Z");
    expect(liveAnnotations(file).map((entry) => entry.id)).toEqual(["a-2"]);
    const text = serializeChapterAnnotations(file);
    expect(text).toContain("  - id: a-1\n    deletedAt: 2026-11-26T09:00:00.000Z\n    updatedAt: 2026-11-26T09:00:00.000Z\n");
    expect(text).not.toContain("private thought");
    expect(liveAnnotations(parsed(text)).map((entry) => entry.id)).toEqual(["a-2"]);
    expect(deleteAnnotation(file, "missing", "2026-11-26T09:00:00.000Z")).toBe(file);
  });

  it(`drops the tombstones older than ${TOMBSTONE_RETENTION_DAYS} days when the app writes the file`, () => {
    const file = deleteAnnotation(deleteAnnotation(fileOf(annotation("a-1"), annotation("a-2"), annotation("a-3")), "a-1", "2026-01-01T00:00:00.000Z"), "a-2", "2026-11-20T00:00:00.000Z");
    const pruned = pruneTombstones(file, new Date("2026-11-25T00:00:00.000Z"));
    expect(pruned.entries.map((entry) => entry.id)).toEqual(["a-2", "a-3"]);
  });
});

describe("merging two copies changed on two devices", () => {
  const base = fileOf(annotation("a-1"), annotation("a-2"));

  it("keeps the annotations added on each side", () => {
    const mine = upsertAnnotation(base, annotation("a-3", { comment: "mine" }));
    const theirs = upsertAnnotation(base, annotation("a-4", { comment: "theirs" }));
    expect(liveAnnotations(mergeChapterAnnotations(mine, theirs)).map((entry) => entry.id)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
  });

  it("keeps, of one annotation changed on both sides, the version changed last", () => {
    const mine = upsertAnnotation(base, annotation("a-1", { status: "handled", updatedAt: "2026-11-25T12:00:00.000Z" }));
    const theirs = upsertAnnotation(base, annotation("a-1", { comment: "older edit", updatedAt: "2026-11-25T11:00:00.000Z" }));
    expect(liveAnnotations(mergeChapterAnnotations(mine, theirs))[0]).toMatchObject({ status: "handled", comment: "" });
    expect(liveAnnotations(mergeChapterAnnotations(theirs, mine))[0]).toMatchObject({ status: "handled", comment: "" });
  });

  it("does not bring back an annotation deleted on one side, unless the other side changed it after the deletion", () => {
    const deleted = deleteAnnotation(base, "a-2", "2026-11-25T12:00:00.000Z");
    expect(liveAnnotations(mergeChapterAnnotations(deleted, base)).map((entry) => entry.id)).toEqual(["a-1"]);
    const editedLater = upsertAnnotation(base, annotation("a-2", { comment: "edited after", updatedAt: "2026-11-25T13:00:00.000Z" }));
    expect(liveAnnotations(mergeChapterAnnotations(deleted, editedLater)).map((entry) => entry.id)).toEqual(["a-1", "a-2"]);
    // A deletion and an edit at the same moment: the deletion wins, on both devices.
    const sameMoment = upsertAnnotation(base, annotation("a-2", { comment: "same moment", updatedAt: "2026-11-25T12:00:00.000Z" }));
    expect(liveAnnotations(mergeChapterAnnotations(deleted, sameMoment)).map((entry) => entry.id)).toEqual(["a-1"]);
    expect(liveAnnotations(mergeChapterAnnotations(sameMoment, deleted)).map((entry) => entry.id)).toEqual(["a-1"]);
  });

  it("gives the same file whichever copy comes first, and merging a copy into itself changes nothing", () => {
    const mine = deleteAnnotation(upsertAnnotation(base, annotation("a-3", { updatedAt: "2026-11-25T12:00:00.000Z" })), "a-1", "2026-11-25T12:30:00.000Z");
    const theirs = upsertAnnotation(upsertAnnotation(base, annotation("a-1", { comment: "x", updatedAt: "2026-11-25T12:10:00.000Z" })), annotation("a-2", { comment: "same time A", updatedAt: "2026-11-25T12:00:00.000Z" }));
    const mineTie = upsertAnnotation(mine, annotation("a-2", { comment: "same time B", updatedAt: "2026-11-25T12:00:00.000Z" }));
    const left = serializeChapterAnnotations(mergeChapterAnnotations(mineTie, theirs));
    const right = serializeChapterAnnotations(mergeChapterAnnotations(theirs, mineTie));
    expect(left).toBe(right);
    expect(serializeChapterAnnotations(mergeChapterAnnotations(mineTie, mineTie))).toBe(serializeChapterAnnotations(mineTie));
    const merged = parsed(left);
    expect(serializeChapterAnnotations(mergeChapterAnnotations(merged, theirs))).toBe(left);
  });

  it("merges the texts of a file of annotations, and leaves any other file, or one it cannot read, to the author", () => {
    const mine = serializeChapterAnnotations(upsertAnnotation(base, annotation("a-3")));
    const theirs = serializeChapterAnnotations(upsertAnnotation(base, annotation("a-4")));
    const merged = mergeAnnotationTexts(annotationsChapterPath(CHAPTER), mine, theirs)!;
    expect(liveAnnotations(parsed(merged)).map((entry) => entry.id)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(mergeAnnotationTexts("chapters/001-the-gate/001-opening.md", mine, theirs)).toBeNull();
    expect(mergeAnnotationTexts(annotationsChapterPath(CHAPTER), "annotations: [broken", theirs)).toBeNull();
    const tagsMine = serializeBookTags(upsertTag(emptyBookTags(), tag("pace-1")));
    const tagsTheirs = serializeBookTags(upsertTag(emptyBookTags(), tag("doubt-2")));
    const tags = parseBookTags(mergeAnnotationTexts(ANNOTATION_TAGS_PATH, tagsMine, tagsTheirs)!);
    expect(tags.ok && liveTags(tags.file).map((entry) => entry.id)).toEqual(["doubt-2", "pace-1"]);
  });
});

function tag(id: string, patch: Partial<AnnotationTagDefinition> = {}): AnnotationTagDefinition {
  return {
    id,
    name: `Tag ${id}`,
    description: "Look at the pace of the scene: cut what slows it.",
    mark: { underline: "dotted", color: "sky", icon: "clock" },
    createdAt: "2026-11-25T10:00:00.000Z",
    updatedAt: "2026-11-25T10:00:00.000Z",
    ...patch,
  };
}

describe("the tags of a book", () => {
  it("are written and read back, with their mark", () => {
    const file = upsertTag(upsertTag(emptyBookTags(), tag("pace-1", { name: "Ritmo lento" })), tag("doubt-2", { name: "Dubbio", description: "line one\nline two" }));
    const text = serializeBookTags(file);
    expect(text).toContain("tags:\n  - id: doubt-2\n    name: Dubbio\n");
    expect(text).toContain("    mark:\n      underline: dotted\n      color: sky\n      icon: clock\n");
    const back = parseBookTags(text);
    expect(back.ok && back.file).toEqual(file);
  });

  it("keep a mark of a newer app as a stand-in that is still a valid mark, and what they do not know", () => {
    const back = parseBookTags("tags:\n  - id: x-1\n    name: X\n    mark:\n      underline: zigzag\n      color: sky\n      icon: clock\n      weight: bold\n    sticky: true\n");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.file.tags[0].mark).toEqual({ underline: "solid", color: "sky", icon: "clock" });
    expect(serializeBookTags(back.file)).toContain("      weight: bold\n");
    expect(serializeBookTags(back.file)).toContain("    sticky: true\n");
    // The value of the newer app goes back as it was while the tag shows the stand-in, even when something else of the tag changes...
    const renamed = upsertTag(back.file, { ...back.file.tags[0], name: "Renamed", updatedAt: "2026-11-26T00:00:00.000Z" });
    expect(serializeBookTags(renamed)).toContain("    mark:\n      underline: zigzag\n      color: sky\n      icon: clock\n      weight: bold\n");
    // ...and the one the author chooses is written once the mark is changed.
    const changed = upsertTag(back.file, { ...back.file.tags[0], mark: { underline: "wavy", color: "sky", icon: "clock" } });
    expect(serializeBookTags(changed)).toContain("    mark:\n      underline: wavy\n      color: sky\n      icon: clock\n");
    expect(markToWrite({ underline: "zigzag", color: "plum", icon: "clock" }, { underline: "solid", color: "teal", icon: "clock" })).toEqual({ underline: "zigzag", color: "teal", icon: "clock" });
    expect(markToWrite(undefined, { underline: "solid", color: "teal", icon: "clock" })).toEqual({ underline: "solid", color: "teal", icon: "clock" });
  });

  it("deleted, stay in the file as tombstones, out of the list, and merge like annotations", () => {
    const file = deleteTag(upsertTag(emptyBookTags(), tag("pace-1")), "pace-1", "2026-11-26T00:00:00.000Z");
    expect(liveTags(file)).toEqual([]);
    const other = upsertTag(emptyBookTags(), tag("pace-1", { name: "Renamed earlier", updatedAt: "2026-11-25T12:00:00.000Z" }));
    expect(liveTags(mergeBookTags(file, other))).toEqual([]);
    expect(liveTags(mergeBookTags(other, file))).toEqual([]);
  });

  it("a tags file that cannot be read is an error", () => {
    expect(parseBookTags("tags: [").ok).toBe(false);
    expect(parseBookTags("tags: nope").ok).toBe(false);
    expect(parseBookTags("").ok).toBe(true);
  });
});
