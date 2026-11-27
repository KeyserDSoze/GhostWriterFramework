import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeReaderPersonas, parseReaderPersona, serializeReaderPersona, emptyReaderPersona, type ReaderPersonaProfile } from "narrarium-engine";
import { parseAppRoute, type LoadedWriterContext } from "@/assistant/context";
import { loadPage, pageIdForPrompt, pageIdForRoute, pageIds, promptReadsItalian } from "@/assistant/pages/registry";
import { pageViewText, readPageView } from "@/assistant/pages/view";
import { readersStateText } from "@/assistant/pages/readers";
import { systemContextBundle } from "@/assistant/service";
import type { BookStructure } from "@/types/book";
import type { AppSettings, BookEntry } from "@/types/settings";

const panel = vi.hoisted(() => ({ readers: null as null | (() => Promise<ReaderPersonaProfile[]>) }));
vi.mock("@/narrarium/readerPanel", () => ({ loadReaderPersonas: () => panel.readers!() }));

const BOOK = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor" } as BookEntry;
const SETTINGS = { ui: { language: "en" } } as AppSettings;

function custom(name: string, patch: Partial<ReaderPersonaProfile> = {}): ReaderPersonaProfile {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  return parseReaderPersona(slug, serializeReaderPersona({ ...emptyReaderPersona("en"), id: `reader:custom:${slug}`, slug, name, description: `${name}.`, ...patch }));
}

/** The book's readers as the page shows them: the built-in ones (one turned off by its file), and one of the author's. */
function readers(): ReaderPersonaProfile[] {
  const critical = { ...parseReaderPersona("standard-critical", "---\nid: reader:standard.critical\nname: Critical Reader\nreader_type: standard\nseverity: 9\nbuiltin: true\nenabled: false\n---\n"), builtin: true };
  return mergeReaderPersonas("en", [critical, custom("Captain Ada", { preferredGenres: ["historical-fiction"], severity: 7 })]);
}

function context(pathname: string): LoadedWriterContext {
  const structure = { title: "The Glass Harbor", language: "en", readerPersonas: [], chapters: [], secrets: [] } as unknown as BookStructure;
  return { route: parseAppRoute(pathname), book: BOOK, structure, chapter: null, paragraph: null, title: "Simulated Readers", summary: "", availableFiles: [], relevantFiles: [], loadedFilePaths: [], noteTargetPath: null, branch: "main", branchReady: true };
}

afterEach(() => {
  document.body.innerHTML = "";
  panel.readers = null;
});

describe("the contract of a page with the Copilot", () => {
  it("is found from the address of the page: the simulated readers have one, a chapter or the settings do not", () => {
    expect(pageIds()).toContain("readers");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/simulated-readers"))).toBe("readers");
    expect(pageIdForRoute(parseAppRoute("/app/books/book-1/chapters/001-dawn"))).toBeNull();
    expect(pageIdForRoute(parseAppRoute("/app/settings"))).toBeNull();
  });

  it("reads what the page shows besides its files from its root element: texts, numbers, switches and lists, nothing else", () => {
    document.body.innerHTML = `<div data-copilot-page="readers" data-copilot-view='{"filter":"genre","selected":"reader:standard.critical","count":3,"open":true,"tags":["a","b"],"nested":{"x":1},"bad":[1,2]}'></div>`;
    const view = readPageView("readers");
    expect(view).toEqual({ filter: "genre", selected: "reader:standard.critical", count: 3, open: true, tags: ["a", "b"] });
    expect(pageViewText(view)).toBe("filter: genre; selected: reader:standard.critical; count: 3; open: true; tags: a, b");
    document.body.innerHTML = `<div data-copilot-page="readers" data-copilot-view="not json"></div>`;
    expect(readPageView("readers")).toBeNull();
    document.body.innerHTML = `<div data-copilot-page="readers" data-copilot-view='${JSON.stringify({ long: "x".repeat(3_000) })}'></div>`;
    expect(readPageView("readers")).toBeNull();
    expect(readPageView("director")).toBeNull();
  });

  it("lets the Copilot see every reader, the built-in ones included, with whether each is on, its origin and what is selected", () => {
    const text = readersStateText(readers(), { filter: "standard", selected: "Critical Reader (reader:standard.critical)" });
    expect(text).toContain("Simulated readers: 29 (28 built-in, 1 custom); 8 on:");
    expect(text).toContain("On the page now: filter: standard; selected: Critical Reader (reader:standard.critical).");
    expect(text).toContain("- on · General Reader · reader:standard.general · standard · built-in · severity 5/10");
    expect(text).toContain("- off · Critical Reader · reader:standard.critical · standard · built-in · severity 9/10");
    expect(text).toContain("- off · Fantasy Reader · reader:genre.fantasy · genre · built-in · severity 6/10 · likes fantasy");
    expect(text).toContain("- on · Captain Ada · reader:custom:captain-ada · custom · custom (personas/captain-ada.md) · severity 7/10 · likes historical-fiction");
  });

  it("gives every request made on the page its state, as data of the book, and the page's own instructions", async () => {
    panel.readers = async () => readers();
    document.body.innerHTML = `<div data-copilot-page="readers" data-copilot-view='{"filter":"all","selected":"reader:custom:captain-ada"}'></div>`;
    const page = await loadPage({ context: context("/app/books/book-1/simulated-readers"), settings: SETTINGS, book: BOOK, branch: "main", token: "local", prompt: "turn off every default reader", accountScope: null });
    expect(page?.id).toBe("readers");
    expect(page?.env.italian).toBe(false);
    expect(page?.state).toContain("selected: Captain Ada (reader:custom:captain-ada)");
    expect(page!.instruction).toMatch(/^CURRENT PAGE\. The author is on the Simulated readers page/);
    const bundle = systemContextBundle({ context: context("/app/books/book-1/simulated-readers"), page } as never);
    expect(bundle).toContain('<page_state trust="untrusted-data">');
    expect(bundle).toContain("- on · General Reader · reader:standard.general");
  });

  it("goes on without the state when it cannot be read, and gives nothing on a page without a contract or without a book", async () => {
    panel.readers = async () => { throw new Error("offline"); };
    const page = await loadPage({ context: context("/app/books/book-1/simulated-readers"), settings: SETTINGS, book: BOOK, branch: "main", token: "local", prompt: "x", accountScope: null });
    expect(page?.state).toBe("");
    expect(systemContextBundle({ context: context("/app/books/book-1/simulated-readers"), page } as never)).not.toContain("page_state");
    expect(await loadPage({ context: context("/app/books/book-1/chapters/001-dawn"), settings: SETTINGS, book: BOOK, branch: "main", token: "local", prompt: "x", accountScope: null })).toBeNull();
    expect(await loadPage({ context: context("/app/books/book-1/simulated-readers"), settings: SETTINGS, book: null, branch: "main", token: "", prompt: "x", accountScope: null })).toBeNull();
  });

  it("tells an Italian request from an English one by its words, and falls back on the language of the app", () => {
    expect(promptReadsItalian("creami solo lettori storici, di diverso tipo, e leva tutti i lettori di default", SETTINGS)).toBe(true);
    expect(promptReadsItalian("create only historical readers and turn off all the default ones", { ui: { language: "it" } } as AppSettings)).toBe(false);
    expect(promptReadsItalian("ok", { ui: { language: "it" } } as AppSettings)).toBe(true);
  });

  it("knows the page a request names by its subject, the page the author is on first", () => {
    expect(pageIdForPrompt("creami solo lettori storici e leva quelli di default")).toBe("readers");
    expect(pageIdForPrompt("turn off the critical reader", "readers")).toBe("readers");
    expect(pageIdForPrompt("create a chapter about the harbor")).toBeNull();
    // «Lettura» and «readership» are not the readers.
    expect(pageIdForPrompt("migliora la lettura del capitolo")).toBeNull();
    expect(pageIdForPrompt("think about the readership")).toBeNull();
  });
});
