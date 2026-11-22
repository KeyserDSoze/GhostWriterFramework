import { beforeEach, describe, expect, it, vi } from "vitest";
import { chapterFreezeRecord, parseMarkdown, renderMarkdown } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore>,
  complete: vi.fn(),
  read: vi.fn(),
}));

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
import { frozenProposalNotices } from "@/frozen/proposal";
import { RepositoryError } from "@/repository/repositoryError";
import { DEFAULT_SETTINGS, type AppSettings, type BookEntry } from "@/types/settings";
import type { LoadedWriterContext } from "@/assistant/context";
import type { AssistantFileUpdate, AssistantMessage } from "@/assistant/store";

// A proposal of the Copilot that writes a whole chapter.md never freezes a chapter or takes its freeze away: the record stays the one the file
// holds, so that a change of a frozen chapter is noticed, and the author is asked about it, whatever the model wrote.

const KEY = "001-the-key";
const FREE = "002-the-flood";
const CHAPTER = `chapters/${KEY}/chapter.md`;
const FREE_CHAPTER = `chapters/${FREE}/chapter.md`;
const RECORD = chapterFreezeRecord({ at: "2026-11-21T10:00:00.000Z", by: "autopilot", chapterBody: "# The key\n\nWhere the key is found.", scenes: [{ name: "001-the-pier.md", body: "Mira finds the key under the pier." }] });
const chapterMd = (slug: string, number: number, title: string, body: string, frozen?: unknown) =>
  renderMarkdown({ type: "chapter", id: `chapter:${slug}`, number, title, summary: `The summary of ${title}.`, ...(frozen ? { frozen } : {}) }, body);

const book = { id: "book", name: "Book", owner: "owner", repo: "repo", tokenIndex: null, addedAt: "now" } satisfies BookEntry;
const chapter = { slug: KEY, title: "The key", path: `chapters/${KEY}`, paragraphs: [{ number: "001", title: "The pier", path: `chapters/${KEY}/001-the-pier.md` }] };
const settings = { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "model", name: "model", capabilities: ["default", "copilot", "chat-resume"] }] }] } as AppSettings;
const context = {
  route: { kind: "book-dashboard", bookId: "book" }, book, branchReady: true, branch: "main",
  structure: { title: "The Glass Harbor", language: "en", defaultBranch: "main", chapters: [chapter], researchFiles: [], readerEvaluationFiles: [] },
  chapter: null, paragraph: null, title: "Page", summary: "", relevantFiles: [], availableFiles: [], loadedFilePaths: [], noteTargetPath: "notes.md",
} as unknown as LoadedWriterContext;

function ask(prompt: string): Promise<AssistantMessage> {
  return runAssistantPrompt({ prompt, context, settings, book, branch: "main", token: "token", history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: null });
}

/** The model's answer: these files, whole. */
function modelProposes(updates: Array<{ path: string; content: string }>) {
  mocks.complete.mockReset().mockResolvedValue(JSON.stringify({ summary: "Mira loses the key.", updates: updates.map((update) => ({ ...update, reason: "The key is lost." })) }));
}

const proposed = (message: AssistantMessage, path: string) => {
  expect(message.action, message.text).toMatchObject({ kind: "apply-file-updates", toolId: "multi-file-edit" });
  return (message.action as { updates: AssistantFileUpdate[] }).updates.find((update) => update.path === path)!.content!;
};

beforeEach(() => {
  mocks.store = new MemoryBookStore({
    [CHAPTER]: chapterMd(KEY, 1, "The key", "# The key\n\nWhere the key is found.", RECORD),
    [`chapters/${KEY}/001-the-pier.md`]: "---\ntype: paragraph\ntitle: The pier\n---\n\nMira finds the key under the pier.\n",
    [FREE_CHAPTER]: chapterMd(FREE, 2, "The flood", "# The flood\n\nThe harbor floods."),
    "notes.md": "# Notes\n",
  });
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    const content = mocks.store.files.get(path);
    if (content === undefined) throw new RepositoryError(`${path} was not found.`, "not-found", "read", 404);
    return { content, sha: (await mocks.store.read(path))!.hash };
  });
});

describe("a proposal of the Copilot that writes chapter.md", () => {
  it("keeps the freeze the model left out, so that the change of the frozen chapter is noticed instead of unfreezing it", async () => {
    const rewritten = chapterMd(KEY, 1, "The key", "# The key\n\nWhere the key is lost.");
    modelProposes([{ path: CHAPTER, content: rewritten }, { path: "notes.md", content: "# Notes\n\nThe key is lost.\n" }]);
    const message = await ask("update multiple files: in chapter 1 Mira loses the key, and note it");
    const content = proposed(message, CHAPTER);
    expect(parseMarkdown(content).frontmatter).toEqual({ ...parseMarkdown(rewritten).frontmatter, frozen: RECORD });
    expect(parseMarkdown(content).body).toBe("# The key\n\nWhere the key is lost.");
    expect(proposed(message, "notes.md").trim(), "any other file is the model's, as written").toBe("# Notes\n\nThe key is lost.");
    expect(frozenProposalNotices([{ path: CHAPTER, content }], [{ path: CHAPTER, content: mocks.store.files.get(CHAPTER)! }]), "the panel says the frozen chapter changes, not that it is unfrozen")
      .toEqual([{ slug: KEY, number: 1, kind: "changed" }]);
  });

  it("takes out a freeze the model made up for a chapter that is not frozen", async () => {
    const forged = chapterMd(FREE, 2, "The flood", "# The flood\n\nThe harbor floods twice.", RECORD);
    modelProposes([{ path: FREE_CHAPTER, content: forged }]);
    const content = proposed(await ask("update multiple files: in chapter 2 the harbor floods twice"), FREE_CHAPTER);
    expect(parseMarkdown(content).frontmatter).toEqual(parseMarkdown(chapterMd(FREE, 2, "The flood", "")).frontmatter);
    expect(parseMarkdown(content).body).toBe("# The flood\n\nThe harbor floods twice.");
  });
});
