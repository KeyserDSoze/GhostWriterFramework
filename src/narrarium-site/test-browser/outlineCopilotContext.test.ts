import { afterEach, describe, expect, it } from "vitest";
import { buildContextSummary, buildContextTitle, loadWriterContext } from "@/assistant/context";
import { useOutlineFocusStore } from "@/store/outlineFocusStore";
import { RepositoryError } from "@/repository/repositoryError";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, storageMode: "local-only", addedAt: "now" } satisfies BookEntry;
const settings = { ...DEFAULT_SETTINGS, books: [book], githubTokens: [] } as unknown as AppSettings;
const structure = { title: "The Glass Harbor", owner: "owner", repo: "repo", defaultBranch: "main", loadedBranch: "main", chapters: [], ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [] };

const files = new Map<string, string>([["outline/book.md", "---\ntype: outline\n---\nA harbor of glass."]]);
for (let number = 1; number <= 60; number += 1) files.set(`outline/chapters/${String(number).padStart(3, "0")}.md`, `---\nnumber: ${number}\n---\nEntry ${number}. ${"x".repeat(number === 30 ? 5000 : 10)}`);

async function read(_token: string, _owner: string, _repo: string, path: string): Promise<string> {
  const content = files.get(path);
  if (content === undefined) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
  return content;
}

afterEach(() => useOutlineFocusStore.setState({ bookId: null, number: null }));

describe("the Copilot on the Outline page", () => {
  it("is told where it is", () => {
    const route = { kind: "book-outline", bookId: "book" } as const;
    expect(buildContextTitle(route, structure as never, null, null)).toBe("Outline");
    expect(buildContextSummary(route, book, structure as never, null, null)).toMatch(/outline\/chapters/);
  });

  it("reads the description and the entries around the one the author is working on, each cut to a few lines", async () => {
    useOutlineFocusStore.getState().focus("book", 30);
    const context = await loadWriterContext("/app/books/book/outline", settings, [book], { book: structure as never }, { book: "main" }, "main", read as never);
    const paths = context.relevantFiles.map((file) => file.path).filter((path) => path.startsWith("outline/"));
    expect(paths).toEqual(["outline/book.md", ...Array.from({ length: 11 }, (_, index) => `outline/chapters/0${25 + index}.md`)]);
    const thirty = context.relevantFiles.find((file) => file.path === "outline/chapters/030.md")!;
    expect(thirty.content.length).toBeLessThan(1_600);
    expect(thirty.content).toContain("[…]");
  });

  it("starts from the first entries when the author is on none, and reads the outline on the autopilot's page too", async () => {
    const context = await loadWriterContext("/app/books/book/autopilot", settings, [book], { book: structure as never }, { book: "main" }, "main", read as never);
    const paths = context.relevantFiles.map((file) => file.path).filter((path) => path.startsWith("outline/"));
    expect(paths[0]).toBe("outline/book.md");
    expect(paths.slice(1)).toEqual(Array.from({ length: 11 }, (_, index) => `outline/chapters/${String(index + 1).padStart(3, "0")}.md`));
  });

  it("reads the outline on the Configuration of the autopilot, where «chapter» is its entry as on the live page", async () => {
    const context = await loadWriterContext("/app/books/book/autopilot/settings", settings, [book], { book: structure as never }, { book: "main" }, "main", read as never);
    expect(context.route).toEqual({ kind: "book-autopilot-settings", bookId: "book" });
    const paths = context.relevantFiles.map((file) => file.path).filter((path) => path.startsWith("outline/"));
    expect(paths).toEqual(["outline/book.md", ...Array.from({ length: 11 }, (_, index) => `outline/chapters/${String(index + 1).padStart(3, "0")}.md`)]);
  });
});
