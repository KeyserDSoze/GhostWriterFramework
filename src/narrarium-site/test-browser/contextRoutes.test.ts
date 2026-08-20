import { expect, test } from "vitest";
import { buildAvailableFileManifest, buildContextSummary, buildContextTitle, loadWriterContext, parseAppRoute, resolveResearchDetailPath } from "@/assistant/context";
import { resolveResumeChapter } from "@/assistant/chapterSource";

const routeCases = [
  ["/app", "app-home"],
  ["/app/books", "app-home"],
  ["/app/books/add", "app-page"],
  ["/app/chats", "app-page"],
  ["/app/patch-notes", "app-page"],
  ["/app/settings", "app-page"],
  ["/app/settings/ai-router", "app-page"],
  ["/app/settings/deep-search", "app-page"],
  ["/app/settings/tools", "app-page"],
  ["/app/settings/github", "app-page"],
  ["/app/settings/speech", "app-page"],
  ["/app/settings/repository", "app-page"],
  ["/app/reader-settings", "app-page"],
  ["/app/custom-actions", "app-page"],
  ["/app/migrate", "app-page"],
  ["/app/costs", "app-page"],
  ["/app/docs/copilot", "app-page"],
  ["/app/docs", "app-page"],
  ["/app/books/book", "book"],
  ["/app/books/book/dashboard", "book-dashboard"],
  ["/app/books/book/assets", "book-assets"],
  ["/app/books/book/reader", "reader"],
  ["/app/books/book/export", "book-export"],
  ["/app/books/book/ghostwriters", "book-ghostwriters"],
  ["/app/books/book/evaluation-style", "book-evaluation-style"],
  ["/app/books/book/simulated-readers", "book-simulated-readers"],
  ["/app/books/book/settings", "book-settings"],
  ["/app/books/book/research", "research"],
  ["/app/books/book/research/rome", "research-detail"],
  ["/app/books/book/audit", "book-audit"],
  ["/app/books/book/canon/characters/lyra", "canon"],
  ["/app/books/book/chapters/001-start", "chapter"],
  ["/app/books/book/chapters/001-start/drafts", "chapter"],
  ["/app/books/book/chapters/001-start/scripts", "chapter"],
  ["/app/books/book/chapters/001-start/workspace/draft", "chapter-workspace"],
  ["/app/books/book/chapters/001-start/reader-evaluations", "chapter-reader-evaluations"],
  ["/app/books/book/chapters/001-start/audit", "chapter-audit"],
  ["/app/books/book/chapters/001-start/paragraphs/001", "paragraph"],
  ["/app/books/book/chapters/001-start/paragraphs/001/split", "paragraph"],
  ["/app/books/book/chapters/001-start/paragraphs/001/workspace/script", "paragraph-workspace"],
  ["/app/books/book/chapters/001-start/paragraphs/001/reader-evaluations", "paragraph-reader-evaluations"],
  ["/app/books/book/chapters/001-start/paragraphs/001/audit", "paragraph-audit"],
];

test("maps every application route family to an explicit context kind", () => {
  for (const [path, kind] of routeCases) expect(parseAppRoute(path).kind, path).toBe(kind);
});

test("book route titles and summaries describe the actual page", () => {
  const structure = { title: "My Book", chapters: [] } as any;
  const book = { name: "My Book" } as any;
  const cases = [
    ["/app/books/book/dashboard", "Book dashboard", "Dashboard"],
    ["/app/books/book/assets", "Book assets", "Assets"],
    ["/app/books/book/ghostwriters", "Ghostwriters", "Ghostwriters"],
    ["/app/books/book/evaluation-style", "Evaluation Style", "evaluation style"],
  ];
  for (const [path, title, summary] of cases) {
    const route = parseAppRoute(path);
    expect(buildContextTitle(route, structure, null, null)).toBe(title);
    expect(buildContextSummary(route, book, structure, null, null)).toMatch(new RegExp(summary, "i"));
  }
});

test("research detail resolves only the selected real research document", () => {
  const structure = { researchFiles: [{ slug: "rome", path: "research/rome.md" }, { slug: "paris", path: "research/paris.md" }] } as any;
  expect(resolveResearchDetailPath(structure, "rome")).toBe("research/rome.md");
  expect(resolveResearchDetailPath(structure, "missing")).toBeUndefined();
});

test("manifest distinguishes real files from conventional hypothetical paths", () => {
  const structure = {
    plotPath: "plot.md", ghostwriters: [{ slug: "default", path: "ghostwriters/default.md", name: "Default" }],
    firstClassFiles: [{ path: "notes.md" }], readerPersonas: [], readerEvaluationFiles: [], auditFiles: [], researchFiles: [{ path: "research/rome.md" }], notesFiles: [], operationManifestFiles: [],
    chapters: [], characters: [], locations: [], factions: [], items: [], secrets: [], timelines: [],
  } as any;
  const manifest = buildAvailableFileManifest(structure);
  expect(manifest.find((file) => file.path === "notes.md")?.exists).toBe(true);
  expect(manifest.find((file) => file.path === "context.md")?.exists).toBe(false);
  expect(manifest.find((file) => file.path === "research/rome.md")?.exists).toBe(true);
  expect(manifest.find((file) => file.path === "ghostwriters/default.md")?.role).toBe("ghostwriter");
});

test("removed writing and punctuation routes are no longer application contexts", () => {
  expect(parseAppRoute("/app/books/book/writing-style").kind).toBe("other");
  expect(parseAppRoute("/app/books/book/punctuation-style").kind).toBe("other");
  expect(parseAppRoute("/app/books/book/chapters/001-start/writing-style").kind).toBe("other");
});

test("chapter and paragraph routes resolve the same complete resume chapter", async () => {
  const chapter = { slug: "001-start", path: "chapters/001-start", title: "Start", paragraphs: [{ number: "001", title: "One", path: "chapters/001-start/001.md" }], hasResume: false, hasEvaluation: false };
  const structure = { title: "Book", owner: "owner", repo: "repo", defaultBranch: "main", loadedBranch: "main", chapters: [chapter], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], operationManifestFiles: [], auditFiles: [], researchFiles: [], notesFiles: [] } as any;
  const book = { id: "book", owner: "owner", repo: "repo", tokenIndex: null } as any;
  const settings = { books: [book], defaultGitHubToken: "" } as any;
  const chapterContext = await loadWriterContext("/app/books/book/chapters/001-start", settings, [book], { book: structure }, { book: "main" }, "main");
  const paragraphContext = await loadWriterContext("/app/books/book/chapters/001-start/paragraphs/001", settings, [book], { book: structure }, { book: "main" }, "main");
  expect(resolveResumeChapter(chapterContext)).toBe(chapter);
  expect(resolveResumeChapter(paragraphContext)).toBe(chapter);
});
