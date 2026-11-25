import { describe, expect, it } from "vitest";
import {
  liveAccountTags,
  mergeAccountAnnotations,
  newerTagDefinition,
  publicNoticeKey,
  publicNoticesSeen,
  pruneAccountTagTombstones,
  storedAccountTags,
} from "@/annotations/accountTags";
import { MISSING_TAG_MARK, tagCatalog, type AnnotationTagDefinition } from "@/annotations/model";

function tag(id: string, patch: Partial<AnnotationTagDefinition> = {}): AnnotationTagDefinition {
  return {
    id,
    name: `Tag ${id}`,
    description: "What the AI should do.",
    mark: { underline: "dotted", color: "teal", icon: "clock" },
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...patch,
  };
}

describe("the tags for every book, in the account data", () => {
  it("show the live ones with a name, as they are stored; the catalogue draws a mark a newer app wrote as the stand-in's", () => {
    const stored = [
      tag("doubt-1a2b"),
      tag("gone-3c4d", { deletedAt: "2026-11-20T00:00:00.000Z" }),
      tag("future-5e6f", { mark: { underline: "zigzag", color: "plum", icon: "clock" } as unknown as AnnotationTagDefinition["mark"], instructions: { model: "x" } } as Partial<AnnotationTagDefinition>),
      { id: "nameless", name: "  " },
      null,
      "not a tag",
    ] as unknown[];
    const live = liveAccountTags(stored);
    expect(live.map((entry) => entry.id)).toEqual(["doubt-1a2b", "future-5e6f"]);
    // What it does not know of a tag stays on it, its mark too.
    expect(live[1]).toBe(stored[2]);
    expect(liveAccountTags(undefined)).toEqual([]);
    expect(liveAccountTags("broken" as unknown as unknown[])).toEqual([]);
    // The catalogue of a book has them after the built-in ones, in the order of Settings, with a mark it can draw.
    const catalog = tagCatalog({ language: "en", global: live });
    expect(catalog.slice(-2).map((entry) => [entry.id, entry.scope])).toEqual([["doubt-1a2b", "global"], ["future-5e6f", "global"]]);
    expect(catalog[catalog.length - 1].mark).toEqual({ underline: MISSING_TAG_MARK.underline, color: MISSING_TAG_MARK.color, icon: "clock" });
  });

  it("are read as they are stored for a change, whatever is in them, and the notices only as text", () => {
    const stored = [tag("doubt-1a2b"), { strange: true }];
    expect(storedAccountTags({ tags: stored as AnnotationTagDefinition[] })).toBe(stored);
    expect(storedAccountTags({ tags: "broken" as unknown as AnnotationTagDefinition[] })).toEqual([]);
    expect(storedAccountTags(undefined)).toEqual([]);
    expect(publicNoticesSeen({ publicNoticeSeen: ["me/book", 7 as unknown as string] })).toEqual(["me/book"]);
    expect(publicNoticesSeen({ publicNoticeSeen: "me/book" as unknown as string[] })).toEqual([]);
    expect(publicNoticeKey({ owner: "Writer", repo: "The-Novel" })).toBe("writer/the-novel");
  });

  it("of one tag in two copies keep the newest; at the same moment a deletion wins, then a fixed order", () => {
    const older = tag("doubt-1a2b", { name: "Doubt" });
    const newer = tag("doubt-1a2b", { name: "Doubts", updatedAt: "2026-11-02T10:00:00.000Z" });
    expect(newerTagDefinition(older, newer)).toBe(newer);
    expect(newerTagDefinition(newer, older)).toBe(newer);
    const deleted = tag("doubt-1a2b", { deletedAt: "2026-11-01T10:00:00.000Z" });
    expect(newerTagDefinition(older, deleted)).toBe(deleted);
    expect(newerTagDefinition(deleted, older)).toBe(deleted);
    const left = tag("doubt-1a2b", { name: "A" });
    const right = tag("doubt-1a2b", { name: "B" });
    expect(newerTagDefinition(left, right)).toEqual(newerTagDefinition(right, left));
    // A date that cannot be read is older than any.
    expect(newerTagDefinition(tag("x", { updatedAt: "yesterday" }), older)).toBe(older);
  });

  it("from copies that diverged: the chosen copy's order, every tag of any copy, of each the newest, the notices of all", () => {
    const chosen = { tags: [tag("b-2"), tag("a-1", { name: "Old name" })], publicNoticeSeen: ["me/one"], futureField: 1 };
    const other = { tags: [tag("a-1", { name: "New name", updatedAt: "2026-11-05T00:00:00.000Z" }), tag("c-3"), tag("b-2", { deletedAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z" })], publicNoticeSeen: ["me/two", "me/one"] };
    const merged = mergeAccountAnnotations(chosen, other, undefined, { tags: "broken" } as never);
    expect(merged?.tags?.map((entry) => [entry.id, entry.name, Boolean(entry.deletedAt)])).toEqual([["b-2", "Tag b-2", true], ["a-1", "New name", false], ["c-3", "Tag c-3", false]]);
    expect(merged?.publicNoticeSeen).toEqual(["me/one", "me/two"]);
    expect((merged as { futureField?: number }).futureField).toBe(1);
    expect(mergeAccountAnnotations(undefined, undefined)).toBeUndefined();
  });

  it("drop the tombstones older than 90 days when saved, and leave what they cannot read", () => {
    const now = new Date("2026-11-25T00:00:00.000Z");
    const stored = [tag("live"), tag("recent", { deletedAt: "2026-10-01T00:00:00.000Z" }), tag("old", { deletedAt: "2026-08-01T00:00:00.000Z" }), null, "x"] as unknown as AnnotationTagDefinition[];
    expect(pruneAccountTagTombstones(stored, now).map((entry) => (entry && typeof entry === "object" ? entry.id : entry))).toEqual(["live", "recent", null, "x"]);
  });
});
