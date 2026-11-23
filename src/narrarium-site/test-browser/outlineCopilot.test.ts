import { beforeEach, describe, expect, it, vi } from "vitest";
import { outlineChapterPath, parseMarkdown, serializeOutlineChapter } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  complete: vi.fn(),
  read: vi.fn(),
}));

vi.mock("@/outline/outlineSource", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/outline/outlineSource")>();
  return { ...original, browserOutlineSource: () => original.storeOutlineSource(mocks.store) };
});
vi.mock("@/assistant/router", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/router")>()), completeTextRouted: mocks.complete }));
// No request leaves the test: the repository is the memory store, and every way to GitHub is closed.
vi.mock("@/github/githubClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/githubClient")>()),
  readFileWithSha: mocks.read,
  loadFileContent: vi.fn(async (_token: string, _owner: string, _repo: string, path: string) => {
    const content = mocks.store.files.get(path);
    if (content === undefined) throw new (await import("@/repository/repositoryError")).RepositoryError(`${path} was not found.`, "not-found", "read", 404);
    return content;
  }),
  listBranchCommits: vi.fn(async () => [{ sha: "head" }]),
  createFile: vi.fn(async () => { throw new Error("no writes in this test"); }),
  updateFile: vi.fn(async () => { throw new Error("no writes in this test"); }),
}));
vi.mock("@/repository/safeRepositoryMutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/safeRepositoryMutation")>()),
  resolveRepositoryHeadForMutation: vi.fn(async () => "head"),
  commitAndPushTextFileMutation: vi.fn(async () => { throw new Error("no writes in this test"); }),
}));
vi.mock("@octokit/rest", () => ({ Octokit: class { constructor() { throw new Error("no GitHub in this test"); } } }));

import { runAssistantPrompt } from "@/assistant/service";
import { isValidAssistantActionShape } from "@/assistant/actionValidation";
import { RepositoryError } from "@/repository/repositoryError";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantMessage } from "@/assistant/store";

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const chapter = { slug: "003-the-key", title: "The key", path: "chapters/003-the-key", paragraphs: [{ number: "001", title: "Scene", path: "chapters/003-the-key/001-scene.md" }] };
const settings = { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "copilot", "chat-resume"] }] }] } as AppSettings;

function contextFor(route: LoadedWriterContext["route"]): LoadedWriterContext {
  return {
    route, book, branchReady: true, branch: "main",
    structure: { title: "The Glass Harbor", language: "it", defaultBranch: "main", chapters: [chapter], ghostwriters: [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }], researchFiles: [], readerEvaluationFiles: [], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], readerPersonas: [], auditFiles: [], notesFiles: [], operationManifestFiles: [] },
    chapter: route.kind === "chapter" ? chapter : null, paragraph: null, title: "Page", summary: "", relevantFiles: [], availableFiles: [], loadedFilePaths: [], noteTargetPath: "notes.md",
  } as unknown as LoadedWriterContext;
}

const ON = {
  outline: { kind: "book-outline", bookId: "book" },
  autopilot: { kind: "book-autopilot", bookId: "book" },
  chapter: { kind: "chapter", bookId: "book", chapterId: chapter.slug },
  dashboard: { kind: "book-dashboard", bookId: "book" },
} as const;

function ask(prompt: string, route: LoadedWriterContext["route"]): Promise<AssistantMessage> {
  return runAssistantPrompt({ prompt, context: contextFor(route), settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

const outlinePaths = (message: AssistantMessage) => message.action && "updates" in message.action ? message.action.updates.map((update) => update.path) : [];

beforeEach(() => {
  const files: Record<string, string> = {};
  for (let number = 1; number <= 8; number += 1) files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title: `T${number}`, body: number === 3 ? "Mira trova la chiave." : `B${number}`, origin: number % 2 ? "autopilot" : "author", digest: number % 2 ? "0123456789abcdef" : undefined });
  files["chapters/003-the-key/chapter.md"] = "---\ntype: chapter\ntitle: The key\n---\n\nThe chapter as written.\n";
  files["chapters/003-the-key/001-scene.md"] = "---\ntype: paragraph\ntitle: Scene\n---\n\nMira holds the key.\n";
  mocks.store = new MemoryBookStore(files);
  mocks.complete.mockReset().mockResolvedValue(JSON.stringify({ summary: "Mira perde la chiave nel capitolo 3.", edits: [{ kind: "update", number: 3, body: "Mira trova la chiave, poi la perde nel porto." }] }));
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    const content = mocks.store.files.get(path);
    if (content === undefined) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
    return { content, sha: (await mocks.store.read(path))!.hash };
  });
});

describe("«nel capitolo 3 aggiungi che Mira perde la chiave»", () => {
  it.each(["outline", "autopilot"] as const)("on the %s page proposes a change of the entry of the outline, and writes nothing", async (page) => {
    const message = await ask("nel capitolo 3 aggiungi che Mira perde la chiave", ON[page]);
    expect(message.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline", bookId: "book" });
    expect(outlinePaths(message)).toEqual(["outline/chapters/003.md"]);
    const update = (message.action as { updates: Array<{ content: string | null }> }).updates[0];
    expect(parseMarkdown(update.content!).frontmatter).toMatchObject({ origin: "author", number: 3 });
    expect(parseMarkdown(update.content!).frontmatter.digest).toBeUndefined();
    expect(parseMarkdown(update.content!).body.trim()).toBe("Mira trova la chiave, poi la perde nel porto.");
    expect((message.action as { sourceRevisions: Record<string, string | null> }).sourceRevisions).toEqual({ "outline/chapters/003.md": (await mocks.store.read("outline/chapters/003.md"))!.hash });
    expect(isValidAssistantActionShape(message.action!)).toBe(true);
    expect(mocks.store.commits, "nothing is written before the author confirms").toHaveLength(0);
    const request = (mocks.complete.mock.calls[0][1] as Array<{ content: string }>).map((entry) => entry.content).join("\n");
    expect(request).toContain("Mira trova la chiave.");
  });

  it("on the page of a chapter is about that chapter, not its entry of the outline", async () => {
    mocks.complete.mockResolvedValue("Answer about the chapter.");
    // Whatever the Copilot does with the chapter itself, it does not propose a change of the outline, and does not ask the model for one.
    const message = await ask("nel capitolo 3 aggiungi che Mira perde la chiave", ON.chapter).catch(() => null);
    expect(message ? outlinePaths(message).some((path) => path.startsWith("outline/")) : false).toBe(false);
    const systems = mocks.complete.mock.calls.map((call) => (call[1] as Array<{ role: string; content: string }>).find((entry) => entry.role === "system")?.content ?? "");
    expect(systems.some((system) => system.includes("You edit the outline"))).toBe(false);
    expect(mocks.store.commits).toHaveLength(0);
  });
});

describe("«nella scaletta sposta il capitolo 5 dopo il 7»", () => {
  it.each(["chapter", "dashboard", "outline"] as const)("moves the entry on the %s page, without asking a model, as a proposal to confirm", async (page) => {
    const message = await ask("nella scaletta sposta il capitolo 5 dopo il 7", ON[page]);
    expect(message.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline" });
    expect(outlinePaths(message)).toEqual(["outline/chapters/005.md", "outline/chapters/006.md", "outline/chapters/007.md"]);
    const contents = (message.action as { updates: Array<{ path: string; content: string }> }).updates.map((update) => parseMarkdown(update.content).frontmatter.title);
    expect(contents).toEqual(["T6", "T7", "T5"]);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.store.commits).toHaveLength(0);
  });
});

describe("other requests about the outline", () => {
  it("deletes an entry only as a proposal, which deletes the file once confirmed", async () => {
    const message = await ask("elimina il capitolo 4 dalla scaletta", ON.outline);
    expect((message.action as { updates: Array<{ path: string; content: string | null }> }).updates).toEqual([expect.objectContaining({ path: "outline/chapters/004.md", content: null })]);
    expect(isValidAssistantActionShape(message.action!)).toBe(true);
    expect(mocks.store.files.has("outline/chapters/004.md")).toBe(true);
  });

  it("asks which chapter is meant when a request on the Outline speaks of the written text", async () => {
    const message = await ask("riscrivi la scena 2 del capitolo 3", ON.outline);
    expect(message.action).toBeUndefined();
    expect(message.text).toMatch(/Scaletta/);
    expect(message.text).toMatch(/capitolo scritto|testo/i);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("tells the model which chapter is meant on the page, in its instructions", async () => {
    mocks.complete.mockResolvedValue("In chapter 3 Mira finds the key.");
    await ask("what happens in chapter 3?", ON.outline);
    const system = (mocks.complete.mock.calls[0][1] as Array<{ role: string; content: string }>).find((entry) => entry.role === "system")!.content;
    expect(system).toContain("entry N of the outline");
    mocks.complete.mockClear();
    await ask("what happens in chapter 3?", ON.chapter);
    const other = (mocks.complete.mock.calls[0][1] as Array<{ role: string; content: string }>).find((entry) => entry.role === "system")!.content;
    expect(other).toContain("the chapter of the book");
  });
});

describe("«Edit Multiple Files»", () => {
  it("never writes a file of the outline by hand: the outline changes only through the engine, as the author's", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({
      summary: "Tidy the plan and the notes.",
      updates: [
        { path: "outline/chapters/003.md", content: "---\norigin: autopilot\ndigest: 0123456789abcdef\n---\nWritten by hand.", reason: "plan" },
        { path: "notes.md", content: "Notes, tidied.", reason: "notes" },
      ],
    }));
    const message = await ask("update multiple files: tidy the plan of chapter 3 and the notes", ON.dashboard);
    expect(outlinePaths(message)).toEqual(["notes.md"]);
    expect(message.text).toContain("Edit the Outline");
    expect(mocks.store.commits).toHaveLength(0);
  });

  it("says how to change the outline when every file it proposes is one of it", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ summary: "Tidy the plan.", updates: [{ path: "outline/chapters/003.md", content: "---\n---\nBy hand.", reason: "plan" }] }));
    const message = await ask("update multiple files: tidy the plan of chapter 3", ON.dashboard);
    expect(message.action).toBeUndefined();
    expect(message.text).toContain("Edit the Outline");
  });
});

describe("the lines of a proposal", () => {
  const lines = (message: AssistantMessage) => message.text.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- ⚠")).map((line) => line.slice(2));
  const SERIES = [
    { kind: "insert", at: 1, title: "Prologue" },
    { kind: "update", number: 2, body: "Mira reaches the harbor." },
    { kind: "move", from: 9, to: 3 },
    { kind: "append", title: "Epilogue" },
    { kind: "append", title: "Another epilogue" },
  ];

  it("name each chapter as the series leaves it, though an edit before made the numbers shift (Italian)", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ summary: "Un prologo, e il primo capitolo cambia.", edits: SERIES }));
    const message = await ask("nella scaletta aggiungi un prologo e riscrivi il capitolo 1", ON.outline);
    expect(lines(message)).toEqual([
      "Un nuovo capitolo 1 nella Scaletta: i successivi slittano di un posto.",
      "Nella Scaletta cambia il capitolo 2 «T1»: cosa succede.",
      "Nella Scaletta il capitolo 9 «T8» diventa il capitolo 3.",
      "Un nuovo capitolo 10 in fondo alla Scaletta.",
      "Un nuovo capitolo 11 in fondo alla Scaletta.",
    ]);
  });

  it("name each chapter as the series leaves it, though an edit before made the numbers shift (English)", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ summary: "A prologue, and the first chapter changes.", edits: SERIES }));
    const message = await ask("in the outline add a prologue and rewrite chapter 1", ON.outline);
    expect(lines(message)).toEqual([
      "A new chapter 1 in the outline: the following chapters move one number up.",
      "In the outline, chapter 2 «T1» changes: what happens.",
      "In the outline, chapter 9 «T8» becomes chapter 3.",
      "A new chapter 10 at the end of the outline.",
      "A new chapter 11 at the end of the outline.",
    ]);
  });

  it("name the chapter an edit deletes after another was moved over it", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ summary: "Il capitolo 2 passa in fondo, poi il primo si toglie.", edits: [{ kind: "move", from: 2, to: 8 }, { kind: "remove", number: 8, renumber: true }] }));
    const message = await ask("nella scaletta sposta in fondo il capitolo 2 e poi eliminalo", ON.outline);
    expect(lines(message)[1]).toBe("Il capitolo 8 «T2» esce dalla Scaletta: i successivi risalgono di un posto.");
  });

  it("do not refuse an edit of a chapter that has no entry: it changes nothing, a warning says so, and the other edits are made", async () => {
    mocks.complete.mockResolvedValue(JSON.stringify({ summary: "Via il 99, titolo nuovo al 2.", edits: [{ kind: "remove", number: 99 }, { kind: "update", number: 2, title: "Due" }] }));
    const message = await ask("nella scaletta elimina il capitolo 99 e rinomina il capitolo 2", ON.outline);
    expect(outlinePaths(message)).toEqual(["outline/chapters/002.md"]);
    expect(message.text).toMatch(/⚠/);
  });
});

describe("a change that touches more than 100 entries", () => {
  it("is not proposed: the Outline page makes it, where it can be undone", async () => {
    const files: Record<string, string> = {};
    for (let number = 1; number <= 150; number += 1) files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title: `T${number}`, body: `B${number}`, origin: "author" });
    mocks.store = new MemoryBookStore(files);
    const message = await ask("nella scaletta sposta il capitolo 150 prima del capitolo 1", ON.outline);
    expect(message.text).toContain("Questa modifica tocca 150 voci della Scaletta");
    expect(message.action).toMatchObject({ kind: "navigate", to: "/app/books/book/outline" });
    expect(mocks.store.commits).toHaveLength(0);
  });

  it("is proposed when it touches exactly 100", async () => {
    const files: Record<string, string> = {};
    for (let number = 1; number <= 100; number += 1) files[outlineChapterPath(number)] = serializeOutlineChapter({ number, title: `T${number}`, body: `B${number}`, origin: "author" });
    mocks.store = new MemoryBookStore(files);
    const message = await ask("nella scaletta sposta il capitolo 100 prima del capitolo 1", ON.outline);
    expect(message.action).toMatchObject({ kind: "apply-file-updates", toolId: "edit-outline" });
    expect(outlinePaths(message)).toHaveLength(100);
  });
});
