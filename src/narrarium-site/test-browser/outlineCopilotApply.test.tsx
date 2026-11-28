import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BookConflictError, parseOutlineJournal, sha256Hex, type BookFileChange } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  read: vi.fn(),
  save: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: vi.fn() }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Outline", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "book-outline", bookId: "book" }, book: null, structure: null, branchReady: true })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));
vi.mock("@/github/githubClient", async (original) => ({
  ...await original<typeof import("@/github/githubClient")>(),
  readFileWithSha: mocks.read,
}));
// The book's working copy, where the Outline page saves: one local commit, checked against the files as they were read.
vi.mock("@/outline/outlineSource", async (original) => ({
  ...await original<typeof import("@/outline/outlineSource")>(),
  browserOutlineSource: () => ({
    files: async () => Promise.all([...mocks.files].map(async ([path, content]) => ({ path, content, hash: await sha256Hex(content) }))),
    commit: mocks.save,
    readState: async () => null,
    readFiles: async () => [],
  }),
}));
// The Outline page saves in the working copy and the proposal goes there too, not through the usual path (a book kept on this device has nowhere to publish).
vi.mock("@/repository/safeRepositoryMutation", async (original) => ({
  ...await original<typeof import("@/repository/safeRepositoryMutation")>(),
  resolveRepositoryHeadForMutation: vi.fn(async () => { throw new Error("Push or discard existing local commits before starting this operation."); }),
  commitAndPushTextFileMutation: mocks.push,
}));
vi.mock("@/assistant/mutationRefresh", async (original) => ({ ...await original<typeof import("@/assistant/mutationRefresh")>(), refreshBookAfterMutation: mocks.refresh }));
vi.mock("@/repository/repositoryError", async (original) => {
  const module = await original<typeof import("@/repository/repositoryError")>();
  return { ...module, isRepositoryNotFoundError: (error: unknown) => error instanceof Error && /not found/.test(error.message) || module.isRepositoryNotFoundError(error), optionalRepositoryRead: async <T,>(read: () => Promise<T>) => { try { return await read(); } catch (error) { if (error instanceof Error && /not found/.test(error.message)) return null; throw error; } } };
});

import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { createEmptyAssistantSession, useAssistantStore, type AssistantMessage } from "@/assistant/store";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { DEFAULT_SETTINGS } from "@/types/settings";

const FOUR = "---\ntype: outline-chapter\nnumber: 4\ntitle: Four\norigin: author\n---\n\nThe fourth.\n";
const FIVE = "---\ntype: outline-chapter\nnumber: 5\ntitle: Five\norigin: author\n---\n\nThe fifth.\n";
const FIVE_NEW = "---\ntype: outline-chapter\nnumber: 5\ntitle: Five, again\norigin: author\n---\n\nThe fifth, rewritten.\n";
/** Who made each series of the journal of the Synopsis, and what it says of each chapter. */
const journalLines = () => parseOutlineJournal(mocks.files.get("outline/changes.yml")).series.map((series) => [series.by, series.chapters.map((item) => [item.chapter, item.change, item.title])]);

async function proposal(): Promise<AssistantMessage> {
  return {
    id: "proposal", role: "assistant", text: "In the outline, chapter 4 leaves; chapter 5 changes.",
    action: {
      kind: "apply-file-updates", bookId: "book", toolId: "edit-outline", owner: "local", repo: "book", branch: "main",
      updates: [{ path: "outline/chapters/004.md", content: null, reason: "Chapter 4 of the outline: deleted" }, { path: "outline/chapters/005.md", content: FIVE_NEW, reason: "Chapter 5 of the outline" }],
      sourceRevisions: { "outline/chapters/004.md": await sha256Hex(FOUR), "outline/chapters/005.md": await sha256Hex(FIVE) },
      sourceRevision: "unused", generatedAt: new Date().toISOString(),
    },
  };
}

beforeEach(async () => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.files = new Map([["outline/chapters/004.md", FOUR], ["outline/chapters/005.md", FIVE]]);
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    const content = mocks.files.get(path);
    if (content === undefined) throw Object.assign(new Error(`${path} was not found.`), { status: 404, name: "RepositoryError", kind: "not-found" });
    return { content, sha: await sha256Hex(content) };
  });
  mocks.save.mockReset().mockImplementation(async (changes: BookFileChange[]) => {
    for (const change of changes) {
      const current = mocks.files.get(change.path);
      const hash = current === undefined ? null : await sha256Hex(current);
      if (change.expectedHash !== undefined && change.expectedHash !== hash) throw new BookConflictError(`File changed since it was read: ${change.path}`, change.path);
    }
    for (const change of changes) {
      if (change.content === null) mocks.files.delete(change.path);
      else mocks.files.set(change.path, change.content);
    }
  });
  mocks.push.mockReset();
  // Like the real refresh, which reloads the book's structure: the books store changes while the operation is still running.
  mocks.refresh.mockReset().mockImplementation(async () => {
    useBooksStore.getState().invalidateStructure("book");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ id: "book", owner: "local", repo: "book", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" }] } });
  const session = createEmptyAssistantSession("Outline");
  session.messages = [{ id: "ask", role: "user", text: "delete chapter 4 and rewrite 5" }, await proposal()];
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: session });
});

afterEach(() => cleanup());

describe("a proposal of the Copilot for the outline", () => {
  it("is applied whole where the Outline page saves, even while the page's saves wait to be published, and undone whole", async () => {
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    await screen.findByText("outline.copilot.applyTogether");
    expect(screen.queryByRole("button", { name: "assistant.applyThisFile" }), "one file of a move would leave two entries with one text").toBeNull();
    expect(screen.getByText("outline.copilot.deletes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "assistant.applyAllFiles" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0].slice(0, 2)).toEqual([
      { path: "outline/chapters/004.md", content: null, expectedHash: await sha256Hex(FOUR) },
      { path: "outline/chapters/005.md", content: FIVE_NEW, expectedHash: await sha256Hex(FIVE) },
    ]);
    // In the same commit, the series of the journal of the Synopsis: the author's (the Copilot only proposed it).
    const applied = mocks.save.mock.calls[0][0][2];
    expect([applied.path, applied.expectedHash]).toEqual(["outline/changes.yml", null]);
    expect(journalLines()).toEqual([["author", [[4, "removed", "Four"], [5, "modified", "Five, again"]]]]);
    expect(mocks.files.has("outline/chapters/004.md")).toBe(false);
    expect(mocks.files.get("outline/chapters/005.md")).toBe(FIVE_NEW);
    expect(mocks.push, "the outline is published with the book, like the page's saves").not.toHaveBeenCalled();
    expect(await screen.findAllByText(/assistant\.appliedFileChanges/), "the panel says it is done, even though reloading the book changes its structure").not.toHaveLength(0);

    fireEvent.click(await screen.findByRole("button", { name: "assistant.undoChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][0].slice(0, 2)).toEqual([
      { path: "outline/chapters/004.md", content: FOUR, expectedHash: null },
      { path: "outline/chapters/005.md", content: FIVE, expectedHash: await sha256Hex(FIVE_NEW) },
    ]);
    // Taking it back is a series of its own: the history keeps both.
    expect(mocks.save.mock.calls[1][0][2]).toMatchObject({ path: "outline/changes.yml", expectedHash: await sha256Hex(applied.content) });
    expect(journalLines()).toEqual([["author", [[4, "removed", "Four"], [5, "modified", "Five, again"]]], ["author", [[4, "created", "Four"], [5, "modified", "Five"]]]]);
    expect(mocks.files.get("outline/chapters/004.md")).toBe(FOUR);
    expect(mocks.files.get("outline/chapters/005.md")).toBe(FIVE);
    expect(await screen.findAllByText(/assistant\.undoApplied/)).not.toHaveLength(0);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("is not applied over an entry that changed after the proposal", async () => {
    const elsewhere = FIVE.replace("The fifth.", "The fifth, changed on the Outline page.");
    mocks.files.set("outline/chapters/005.md", elsewhere);
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    await screen.findByText(/005\.md · failed/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.files.get("outline/chapters/004.md")).toBe(FOUR);
    expect(mocks.files.get("outline/chapters/005.md")).toBe(elsewhere);
  });

  it("shows the difference of a new entry from the book's working copy, without asking the network", async () => {
    const SIX = "---\ntype: outline-chapter\nnumber: 6\ntitle: Six\norigin: author\n---\n\nThe sixth.\n";
    // Offline, or a book kept on this device: a file the working copy does not have cannot be asked of GitHub.
    mocks.read.mockRejectedValue(new TypeError("Failed to fetch"));
    const session = createEmptyAssistantSession("Outline");
    session.messages = [{ id: "ask", role: "user", text: "add a chapter 6" }, {
      id: "append", role: "assistant", text: "A new chapter 6 at the end of the outline.",
      action: { kind: "apply-file-updates", bookId: "book", toolId: "edit-outline", owner: "local", repo: "book", branch: "main", updates: [{ path: "outline/chapters/006.md", content: SIX, reason: "Chapter 6 of the outline" }], sourceRevisions: { "outline/chapters/006.md": null }, sourceRevision: "unused", generatedAt: new Date().toISOString() },
    }];
    useAssistantStore.setState({ currentSession: session });
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.showDiff" }));
    expect(await screen.findByRole("button", { name: "assistant.hideDiff" })).toBeInTheDocument();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

describe("the Copilot on a phone", () => {
  it("still names its icon buttons when their labels are hidden", async () => {
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    await screen.findByText("outline.copilot.applyTogether");
    // Below 640 px these labels are not shown (`hidden sm:inline`) and the icons are hidden from assistive technology.
    for (const label of document.querySelectorAll<HTMLElement>(".sm\\:inline")) label.style.display = "none";
    expect(screen.getByRole("button", { name: "assistant.send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "assistant.read" })).toBeInTheDocument();
  });
});
