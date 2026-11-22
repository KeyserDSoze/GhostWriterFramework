import { describe, expect, it } from "vitest";
import { buildContextSummary, buildContextTitle, loadWriterContext, parseAppRoute } from "@/assistant/context";
import { autopilotLiveHref, autopilotSettingsHref, isAutopilotLivePage, isAutopilotPage } from "@/autopilot/pageRoute";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { BookStructure } from "@/types/book";

const SETTINGS_PATH = "/app/books/book/autopilot/settings";

describe("the address of the configuration of the autopilot", () => {
  it("is a page of its own for the Copilot, with the book it belongs to", () => {
    expect(parseAppRoute(SETTINGS_PATH)).toEqual({ kind: "book-autopilot-settings", bookId: "book" });
    expect(parseAppRoute(`${SETTINGS_PATH}/`)).toEqual({ kind: "book-autopilot-settings", bookId: "book" });
    expect(parseAppRoute("/app/books/libro%20%C3%A8/autopilot/settings")).toEqual({ kind: "book-autopilot-settings", bookId: "libro è" });
    // The live page keeps its address and its kind.
    expect(parseAppRoute("/app/books/book/autopilot")).toEqual({ kind: "book-autopilot", bookId: "book" });
  });

  it("is described to the model and in the titles as the configuration of the autopilot of the book", () => {
    const structure = { title: "My Book", chapters: [] } as unknown as BookStructure;
    const book = { name: "My Book" } as BookEntry;
    const route = parseAppRoute(SETTINGS_PATH);
    expect(buildContextTitle(route, structure, null, null)).toBe("Autopilot configuration");
    expect(buildContextSummary(route, book, structure, null, null)).toMatch(/^Autopilot configuration for My Book/);
    // The two pages are told apart.
    expect(buildContextSummary(parseAppRoute("/app/books/book/autopilot"), book, structure, null, null)).not.toBe(buildContextSummary(route, book, structure, null, null));
  });

  it("gives the Copilot the same files as the live page of the autopilot, and the notes of the book", async () => {
    const book: BookEntry = { id: "book", owner: "local", repo: "book", name: "My Book", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
    const structure = { title: "My Book", owner: "local", repo: "book", defaultBranch: "main", loadedBranch: "main", chapters: [], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], plotPath: "plot.md", ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [] } as unknown as BookStructure;
    const settings = { ...DEFAULT_SETTINGS, books: [book], defaultGitHubToken: "ghp_token" };
    const read = async (_token: string, _owner: string, _repo: string, path: string) => `content of ${path}`;
    const live = await loadWriterContext("/app/books/book/autopilot", settings, [book], { book: structure }, {}, "main", read as never);
    const config = await loadWriterContext(SETTINGS_PATH, settings, [book], { book: structure }, {}, "main", read as never);
    expect(config.loadedFilePaths).toEqual(live.loadedFilePaths);
    expect(config.loadedFilePaths).toEqual(expect.arrayContaining(["book.md", "plot.md"]));
    expect(config.noteTargetPath).toBe("notes.md");
    expect(config.title).toBe("Autopilot configuration");
  });
});

describe("the pages of the autopilot, for the live panel", () => {
  it("count the configuration as a page of the autopilot, where the panel keeps out of the way", () => {
    expect(isAutopilotPage(SETTINGS_PATH)).toBe(true);
    expect(isAutopilotPage("/app/books/book/autopilot")).toBe(true);
    expect(isAutopilotPage("/app/autopilot")).toBe(true);
    expect(isAutopilotPage("/app/books/book/director")).toBe(false);
  });

  it("tell the pages that show the run live from the configuration, which does not", () => {
    expect(isAutopilotLivePage("/app/books/book/autopilot")).toBe(true);
    expect(isAutopilotLivePage("/app/autopilot")).toBe(true);
    expect(isAutopilotLivePage(SETTINGS_PATH)).toBe(false);
  });

  it("have one way to write their addresses", () => {
    expect(autopilotLiveHref("book-1")).toBe("/app/books/book-1/autopilot");
    expect(autopilotSettingsHref("book-1")).toBe("/app/books/book-1/autopilot/settings");
    expect(autopilotSettingsHref("libro è")).toBe("/app/books/libro%20%C3%A8/autopilot/settings");
  });
});
