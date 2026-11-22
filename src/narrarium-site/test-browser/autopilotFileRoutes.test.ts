import { describe, expect, it } from "vitest";
import { FrontmatterError } from "narrarium-engine";
import { bookFileRoute, filesInError } from "@/autopilot/stopReason";
import { findingSourceHref } from "@/narrarium/audit";
import type { BookStructure } from "@/types/book";

const BOOK = "book-1";
const root = "/app/books/book-1";

describe("the page that opens a file of the book", () => {
  it.each([
    ["book.md", `${root}`],
    ["director.md", `${root}/director`],
    ["ghostwriters/night-owl.md", `${root}/ghostwriters`],
    ["personas/standard-general.md", `${root}/simulated-readers`],
    ["characters/ada-lovelace.md", `${root}/canon/characters/ada-lovelace`],
    ["locations/old-town.md", `${root}/canon/locations/old-town`],
    ["factions/the-circle.md", `${root}/canon/factions/the-circle`],
    ["items/golden-key.md", `${root}/canon/items/golden-key`],
    ["secrets/true-name.md", `${root}/canon/secrets/true-name`],
    ["timelines/events/first-contact.md", `${root}/canon/timelines/first-contact`],
    ["chapters/001-the-arrival/chapter.md", `${root}/chapters/001-the-arrival`],
    ["chapters/001-the-arrival/002-at-the-gate.md", `${root}/chapters/001-the-arrival/paragraphs/002`],
    ["chapters/001-the-arrival/003.md", `${root}/chapters/001-the-arrival/paragraphs/003`],
    ["resumes/chapters/001-the-arrival.md", `${root}/chapters/001-the-arrival/workspace/resume`],
    ["evaluations/chapters/001-the-arrival.md", `${root}/chapters/001-the-arrival/workspace/evaluation`],
    ["drafts/001-the-arrival/chapter.md", `${root}/chapters/001-the-arrival/workspace/draft`],
  ])("opens %s at %s", (path, route) => {
    expect(bookFileRoute(BOOK, path)).toBe(route);
  });

  it("agrees with the routes the audit uses for the same files", () => {
    const structure = { chapters: [] } as unknown as BookStructure;
    const target = { bookId: BOOK, sourceHref: "/elsewhere" } as Parameters<typeof findingSourceHref>[1];
    const finding = (path: string) => ({ structuredSourceRef: { path }, position: {} }) as Parameters<typeof findingSourceHref>[2];
    for (const path of ["characters/ada-lovelace.md", "locations/old-town.md", "factions/the-circle.md", "items/golden-key.md", "secrets/true-name.md", "timelines/events/first-contact.md", "book.md"]) {
      expect(bookFileRoute(BOOK, path), path).toBe(findingSourceHref(structure, target, finding(path)));
    }
  });

  it("writes the name of a book and of a file so that any script and any space survive in the address", () => {
    expect(bookFileRoute("book / id", "locations/citta vecchia.md")).toBe("/app/books/book%20%2F%20id/canon/locations/citta%20vecchia");
    expect(bookFileRoute(BOOK, "characters/ада-лавлейс.md")).toBe(`${root}/canon/characters/${encodeURIComponent("ада-лавлейс")}`);
    expect(bookFileRoute(BOOK, "chapters/001-глава-первая/chapter.md")).toBe(`${root}/chapters/${encodeURIComponent("001-глава-первая")}`);
    expect(bookFileRoute(BOOK, "chapters/002-第一章/001-黎明.md")).toBe(`${root}/chapters/${encodeURIComponent("002-第一章")}/paragraphs/001`);
  });

  it("has no page for what the site does not open, and invents none", () => {
    for (const path of ["plot.md", "resumes/total.md", "context.md", "story-design.md", "autopilot/state.json", "autopilot/plan.md", "evaluations/director/book.md", "assets/book/cover.png", "chapters/001-x/drafts/001.md", "chapters/001-x/notes.md", "characters/sub/dir.md", "characters/.md", ""]) {
      expect(bookFileRoute(BOOK, path), path).toBeNull();
    }
  });

  it("never builds an address from a path that leaves the book", () => {
    for (const path of ["../director.md", "chapters/../../director.md", "/etc/director.md", ".git/director.md", "chapters/..//chapter.md", "characters/../book.md", "C:\\books\\director.md"]) {
      expect(bookFileRoute(BOOK, path), path).toBeNull();
    }
  });
});

describe("the files a message names", () => {
  const refusal = (path: string, language?: string) => new FrontmatterError(path, "a mapping is not allowed here", 4, language).message;

  it("finds the file the engine refuses to rewrite, in English and in Italian", () => {
    expect(filesInError(refusal("chapters/001-the-arrival/chapter.md"))).toEqual([{ path: "chapters/001-the-arrival/chapter.md", frontmatter: true }]);
    expect(filesInError(refusal("chapters/001-the-arrival/chapter.md", "it"))).toEqual([{ path: "chapters/001-the-arrival/chapter.md", frontmatter: true }]);
  });

  it("finds the whole of a path that has a space or letters of another script in it", () => {
    expect(filesInError(refusal("locations/citta vecchia.md"))).toEqual([{ path: "locations/citta vecchia.md", frontmatter: true }]);
    expect(filesInError(refusal("characters/ада-лавлейс.md", "it"))).toEqual([{ path: "characters/ада-лавлейс.md", frontmatter: true }]);
  });

  it("finds a file named in any other message, without saying its front matter is the trouble", () => {
    expect(filesInError("File changed since it was read: chapters/001-x/001-scene.md")).toEqual([{ path: "chapters/001-x/001-scene.md", frontmatter: false }]);
    expect(filesInError("The files plot.md and resumes/total.md could not be saved (HTTP 500).")).toEqual([
      { path: "plot.md", frontmatter: false },
      { path: "resumes/total.md", frontmatter: false },
    ]);
  });

  it("lists a file once, and never takes a fragment of a path it already has for a file of its own", () => {
    expect(filesInError(`${refusal("locations/citta vecchia.md")} See locations/citta vecchia.md again.`)).toEqual([{ path: "locations/citta vecchia.md", frontmatter: true }]);
  });

  it("finds nothing in a message that names no file", () => {
    expect(filesInError("Too many steps in one run.")).toEqual([]);
    expect(filesInError("The model returned data instead of prose.")).toEqual([]);
    expect(filesInError("")).toEqual([]);
    expect(filesInError(null)).toEqual([]);
    expect(filesInError(undefined)).toEqual([]);
  });

  it("does not take the end of a sentence for part of the name", () => {
    expect(filesInError("Could not save plot.md.")).toEqual([{ path: "plot.md", frontmatter: false }]);
    expect(filesInError("Could not save (chapters/001-x/chapter.md), try again.")).toEqual([{ path: "chapters/001-x/chapter.md", frontmatter: false }]);
  });
});
