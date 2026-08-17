import { describe, expect, it } from "vitest";
import { findingSourceHref } from "@/narrarium/audit";
import type { BookStructure } from "@/types/book";

const structure = { chapters: [] } as unknown as BookStructure;
const target = { bookId: "book / id", sourceHref: "/wrong-target" } as Parameters<typeof findingSourceHref>[1];
const finding = (path: string) => ({ structuredSourceRef: { path }, position: {} }) as Parameters<typeof findingSourceHref>[2];

describe("findingSourceHref canon routing", () => {
  it.each([
    ["characters/ada-lovelace.md", "characters", "ada-lovelace"],
    ["locations/citta vecchia.md", "locations", "citta%20vecchia"],
    ["factions/the-circle.md", "factions", "the-circle"],
    ["items/chiave-d’oro.md", "items", "chiave-d%E2%80%99oro"],
    ["secrets/true-name.md", "secrets", "true-name"],
    ["timelines/events/first-contact.md", "timelines", "first-contact"],
  ])("routes %s to its canonical entity page", (path, section, slug) => {
    expect(findingSourceHref(structure, target, finding(path))).toBe(`/app/books/book%20%2F%20id/canon/${section}/${slug}`);
  });
});
