import { describe, expect, it } from "vitest";
import {
  BUILTIN_TAGS,
  MARK_COLORS,
  MARK_ICONS,
  MARK_UNDERLINES,
  MISSING_TAG_MARK,
  annotationStatus,
  builtinTag,
  createAnnotationId,
  createTagId,
  isMarkStyle,
  isPendingStatus,
  normalizeMarkStyle,
  pendingCounts,
  resolveTag,
  tagCatalog,
  withStatus,
  type Annotation,
  type AnnotationTagDefinition,
} from "@/annotations/model";
import { MARK_ICON_SVG, markIconMarkup } from "@/annotations/icons";

const definition = (id: string, name: string, patch: Partial<AnnotationTagDefinition> = {}): AnnotationTagDefinition => ({
  id, name, description: `${name} described`, mark: { underline: "dotted", color: "teal", icon: "flag" }, createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z", ...patch,
});

describe("the built-in tags", () => {
  it("are the five of the spec, with a stable id, a name and an instruction in English and Italian, and a mark that is never colour alone", () => {
    expect(BUILTIN_TAGS.map((tag) => tag.id)).toEqual(["rewrite", "dislike", "inconsistency", "expand", "keep"]);
    for (const tag of BUILTIN_TAGS) {
      for (const language of ["en", "it"] as const) {
        expect(tag.text[language].name.trim(), `${tag.id} ${language}`).not.toBe("");
        expect(tag.text[language].description.length, `${tag.id} ${language}`).toBeGreaterThan(30);
      }
      expect(isMarkStyle(tag.mark)).toBe(true);
    }
    // Each built-in tag has its own underline and its own icon: the tags are told apart without their colours.
    expect(new Set(BUILTIN_TAGS.map((tag) => tag.mark.underline)).size).toBe(BUILTIN_TAGS.length);
    expect(new Set(BUILTIN_TAGS.map((tag) => tag.mark.icon)).size).toBe(BUILTIN_TAGS.length);
    expect(builtinTag("rewrite", "it")).toMatchObject({ name: "Da riscrivere", scope: "builtin" });
    expect(builtinTag("nope", "en")).toBeUndefined();
  });

  it("have an icon each, drawn as SVG without anything a screen reader would read", () => {
    for (const icon of MARK_ICONS) {
      expect(MARK_ICON_SVG[icon]).toMatch(/^<(path|circle|line|polyline)/);
      expect(markIconMarkup(icon)).toContain('aria-hidden="true"');
    }
  });
});

describe("the catalogue of the tags of a book", () => {
  it("lists the built-in tags, then the tags of every book in their order, then the book's by name; deleted ones are left out", () => {
    const catalog = tagCatalog({
      language: "en",
      global: [definition("zeta-1", "Zeta"), definition("alpha-2", "Alpha"), definition("gone-3", "Gone", { deletedAt: "2026-11-26T00:00:00.000Z" })],
      book: [definition("pace-4", "Pace"), definition("doubt-5", "Doubt"), definition("rewrite", "Shadowing a built-in")],
    });
    expect(catalog.map((tag) => `${tag.scope}:${tag.id}`)).toEqual([
      "builtin:rewrite", "builtin:dislike", "builtin:inconsistency", "builtin:expand", "builtin:keep",
      "global:zeta-1", "global:alpha-2",
      "book:doubt-5", "book:pace-4",
    ]);
  });

  it("names a tag that is gone and keeps the annotation's tag id: the passage and the note stay", () => {
    const catalog = tagCatalog({ language: "it" });
    expect(resolveTag(catalog, "keep", "Etichetta rimossa")).toMatchObject({ name: "Da tenere", scope: "builtin" });
    expect(resolveTag(catalog, "removed-1", "Etichetta rimossa")).toEqual({ id: "removed-1", scope: "missing", name: "Etichetta rimossa", description: "", mark: MISSING_TAG_MARK });
  });
});

describe("marks, ids and statuses", () => {
  it("a mark of a newer app is replaced, value by value, by a valid one", () => {
    expect(normalizeMarkStyle({ underline: "zigzag", color: "sky", icon: "rocket" })).toEqual({ underline: MISSING_TAG_MARK.underline, color: "sky", icon: MISSING_TAG_MARK.icon });
    expect(normalizeMarkStyle(null)).toEqual(MISSING_TAG_MARK);
    expect(MARK_UNDERLINES).toHaveLength(5);
    expect(MARK_COLORS.length).toBeGreaterThanOrEqual(8);
  });

  it("ids of annotations sort in the order they were made; ids of tags are readable and unique", () => {
    const first = createAnnotationId(Date.UTC(2026, 10, 25, 10), () => "abcdef12");
    const second = createAnnotationId(Date.UTC(2026, 10, 25, 11), () => "000000");
    expect(first).toMatch(/^a-[0-9a-z]+-abcdef$/);
    expect(first < second).toBe(true);
    expect(createTagId("Ritmo lento!", () => "x7k2zz")).toBe("ritmo-lento-x7k2");
    expect(createTagId("Più è più", () => "q1q1")).toBe("piu-e-piu-q1q1");
    expect(createTagId("日本語", () => "a1b2")).toBe("tag-a1b2");
    expect(createAnnotationId()).not.toBe(createAnnotationId());
  });

  it("a status of a newer app reads as open; open and later are what waits for the author", () => {
    expect(annotationStatus("handled")).toBe("handled");
    expect(annotationStatus("proposed")).toBe("open");
    expect(isPendingStatus("open") && isPendingStatus("later")).toBe(true);
    expect(isPendingStatus("handled") || isPendingStatus("dismissed")).toBe(false);
  });

  it("the badges count what waits, by chapter and by scene", () => {
    const base = { chapter: "001-x", quote: "q", prefix: "", suffix: "", offset: 0, tag: "rewrite", comment: "", createdAt: "", updatedAt: "", createdOnDevice: "" };
    const annotations: Annotation[] = [
      { ...base, id: "a-1", paragraph: "001-one", status: "open" },
      { ...base, id: "a-2", paragraph: "001-one", status: "later" },
      { ...base, id: "a-3", paragraph: "002-two", status: "handled" },
      { ...base, id: "a-4", paragraph: "002-two", status: "proposed" },
      { ...base, id: "a-5", paragraph: "003-three", status: "dismissed" },
    ];
    expect(pendingCounts(annotations)).toEqual({ total: 3, byParagraph: { "001-one": 2, "002-two": 1 } });
  });

  it("another status is a new copy at that moment; handled keeps how it was handled, any other takes it away, and no change is nothing", () => {
    const base: Annotation = { id: "a-1", chapter: "001-x", paragraph: "001-one", quote: "q", prefix: "", suffix: "", offset: 0, tag: "rewrite", comment: "", status: "open", createdAt: "t0", updatedAt: "t0", createdOnDevice: "d" };
    const handled = withStatus(base, "handled", "t1", { by: "ai", at: "t1", summary: "Rewrote the image." });
    expect(handled).toMatchObject({ status: "handled", updatedAt: "t1", resolution: { by: "ai", at: "t1", summary: "Rewrote the image." } });
    expect(base.status).toBe("open");
    expect(withStatus(handled!, "handled", "t2")).toBeNull();
    // Handled again with another resolution: the new one; with none: the one it has.
    expect(withStatus(handled!, "handled", "t2", { by: "author", at: "t2" })?.resolution).toEqual({ by: "author", at: "t2" });
    const later = withStatus(handled!, "later", "t3")!;
    expect(later).toMatchObject({ status: "later", updatedAt: "t3" });
    expect(later).not.toHaveProperty("resolution");
    expect(withStatus(withStatus(later, "dismissed", "t4")!, "handled", "t5")).not.toHaveProperty("resolution");
    // A status of a newer app that reads as open: setting open is a change (it is written as open).
    expect(withStatus({ ...base, status: "snoozed" }, "open", "t6")).toMatchObject({ status: "open" });
  });
});
