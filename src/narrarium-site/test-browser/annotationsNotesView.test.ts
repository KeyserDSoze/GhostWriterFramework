import { describe, expect, it } from "vitest";
import {
  NO_FILTERS,
  filterNotes,
  filtersFromParams,
  groupNotes,
  matchesText,
  normalizeSearch,
  paramsFromFilters,
  sortNotes,
  statusCounts,
  tagsInUse,
  type NoteItem,
} from "@/annotations/notesView";
import type { Annotation } from "@/annotations/model";

function note(id: string, patch: Partial<Annotation> = {}, place: Partial<NoteItem> = {}): NoteItem {
  const annotation: Annotation = { id, chapter: "001-the-gate", paragraph: "001-opening", quote: "the color of old steel", prefix: "", suffix: "", offset: 10, tag: "rewrite", comment: "Too familiar an image.", status: "open", createdAt: "t", updatedAt: "t", createdOnDevice: "d", ...patch };
  return { annotation, tagName: "To rewrite", chapterTitle: "The Gate", chapterOrder: 0, sceneTitle: "Opening", sceneNumber: "001", sceneOrder: 0, ...place };
}

const ITEMS: NoteItem[] = [
  note("a-3", { chapter: "002-the-bell", paragraph: "001-ring", quote: "A bell that nobody rang", comment: "Già visto: è un cliché", tag: "dislike", status: "later" }, { chapterTitle: "The Bell", chapterOrder: 1, sceneTitle: "The ring", tagName: "Don't like it" }),
  note("a-1", { offset: 80 }),
  note("a-2", { quote: "counting the lanterns", comment: "", tag: "keep", status: "handled", offset: 20, resolution: { by: "ai", at: "t", summary: "Rewrote the count" } }, { tagName: "Keep it" }),
  note("a-4", { paragraph: "002-wall", status: "dismissed", offset: 0 }, { sceneOrder: 1, sceneTitle: "The wall" }),
  note("a-5", { chapter: "009-gone", paragraph: "001-x", status: "snoozed" }, { chapterTitle: "009-gone", chapterOrder: Number.MAX_SAFE_INTEGER, sceneOrder: Number.MAX_SAFE_INTEGER }),
];

describe("the notes of a book", () => {
  it("are in the order of the book: chapter, scene, then the place of the passage, then when they were made; what is no longer there comes last", () => {
    expect(sortNotes(ITEMS).map((item) => item.annotation.id)).toEqual(["a-2", "a-1", "a-4", "a-3", "a-5"]);
    expect(sortNotes([note("a-9", { offset: 5 }), note("a-8", { offset: 5 })]).map((item) => item.annotation.id)).toEqual(["a-8", "a-9"]);
  });

  it("are grouped by chapter, each with its title", () => {
    expect(groupNotes(ITEMS).map((group) => [group.chapter, group.title, group.items.map((item) => item.annotation.id)])).toEqual([
      ["001-the-gate", "The Gate", ["a-2", "a-1", "a-4"]],
      ["002-the-bell", "The Bell", ["a-3"]],
      ["009-gone", "009-gone", ["a-5"]],
    ]);
  });

  it("are counted by status, a status of a newer app as open, and «to review» is open and later", () => {
    expect(statusCounts(ITEMS)).toEqual({ open: 2, later: 1, handled: 1, dismissed: 1, pending: 3, all: 5 });
  });

  it("offer the tags in use, by name, with how many notes each has", () => {
    expect(tagsInUse(ITEMS)).toEqual([
      { id: "dislike", name: "Don't like it", count: 1 },
      { id: "keep", name: "Keep it", count: 1 },
      { id: "rewrite", name: "To rewrite", count: 3 },
    ]);
  });
});

describe("the filters of the notes", () => {
  const ids = (filters: Partial<typeof NO_FILTERS>) => filterNotes(ITEMS, { ...NO_FILTERS, ...filters }).map((item) => item.annotation.id).sort();

  it("show what waits (open and later) by default, and every status or one when asked", () => {
    expect(ids({})).toEqual(["a-1", "a-3", "a-5"]);
    expect(ids({ status: "all" })).toEqual(["a-1", "a-2", "a-3", "a-4", "a-5"]);
    expect(ids({ status: "handled" })).toEqual(["a-2"]);
    expect(ids({ status: "dismissed" })).toEqual(["a-4"]);
    expect(ids({ status: "later" })).toEqual(["a-3"]);
  });

  it("narrow by chapter and by tag, together", () => {
    expect(ids({ status: "all", chapter: "002-the-bell" })).toEqual(["a-3"]);
    expect(ids({ status: "all", tag: "rewrite" })).toEqual(["a-1", "a-4", "a-5"]);
    expect(ids({ status: "all", tag: "rewrite", chapter: "009-gone" })).toEqual(["a-5"]);
    expect(ids({ status: "all", tag: "keep", chapter: "002-the-bell" })).toEqual([]);
  });

  it("find words in the passage, the note, the tag, the scene and how it was handled, without caring for case or accents, in any order", () => {
    expect(ids({ status: "all", text: "BELL nobody" })).toEqual(["a-3"]);
    expect(ids({ status: "all", text: "cliche gia" })).toEqual(["a-3"]);
    expect(ids({ status: "all", text: "keep it" })).toEqual(["a-2"]);
    expect(ids({ status: "all", text: "the wall" })).toEqual(["a-4"]);
    expect(ids({ status: "all", text: "rewrote the count" })).toEqual(["a-2"]);
    expect(ids({ status: "all", text: "nowhere" })).toEqual([]);
    expect(matchesText(ITEMS[0], "   ")).toBe(true);
    expect(normalizeSearch("  Già   Visto — È ")).toBe("gia visto — e");
  });
});

describe("the filters in the address", () => {
  it("are read from it, with what is not valid left as the default", () => {
    expect(filtersFromParams(new URLSearchParams("chapter=001-the-gate&tag=keep&status=all&q=old steel"))).toEqual({ chapter: "001-the-gate", tag: "keep", status: "all", text: "old steel" });
    expect(filtersFromParams(new URLSearchParams("status=bogus"))).toEqual(NO_FILTERS);
    expect(filtersFromParams(new URLSearchParams(""))).toEqual(NO_FILTERS);
  });

  it("are written to it without the defaults, and the other parameters stay", () => {
    expect(paramsFromFilters(NO_FILTERS).toString()).toBe("");
    const params = paramsFromFilters({ chapter: "001-the-gate", tag: "", status: "later", text: " bell " }, new URLSearchParams("triage=1"));
    expect(Object.fromEntries(params)).toEqual({ triage: "1", chapter: "001-the-gate", status: "later", q: "bell" });
    expect(paramsFromFilters(NO_FILTERS, params).toString()).toBe("triage=1");
  });
});
