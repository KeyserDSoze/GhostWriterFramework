import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BookConflictError, captureDecision, parseOutlineJournal, setDecisionStatus, sha256Hex, type BookFileChange } from "narrarium-engine";

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
    readFiles: async (paths: string[]) => paths.filter((path) => mocks.files.has(path)).map((path) => ({ path, content: mocks.files.get(path)! })),
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


// A locked decision of the book holds back a change of the Synopsis that goes against it: nothing is applied, and the author decides.

const NOW = new Date("2026-11-28T08:00:00.000Z");
const lockedLog = (chapters: number[]) => setDecisionStatus((captureDecision(null, { decision: "Chapter 5 stays as it is.", reason: "The reveal depends on it.", chapters, by: "author" }, NOW) as { content: string }).content, "d-001", "locked")!;
// The texts of the interface are the keys here (the app's i18n is not started); the sentence that says what is held is the engine's.
const t = (key: string) => key;

describe("a proposal of the Copilot held by a locked decision", () => {
  it("is not applied when it touches the entry of a locked chapter: the author is told which decision, applies it anyway or leaves it", async () => {
    mocks.files.set("bible/decisions.md", lockedLog([5]));
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    const hold = await screen.findByRole("group", { name: t("bibleStudio.hold.region") });
    expect(hold).toHaveTextContent("This change touches the entry of chapter 5, which the locked decision d-001 covers: «Chapter 5 stays as it is.».");
    expect(hold).toHaveTextContent(t("bibleStudio.hold.title"));
    expect(mocks.save, "nothing is applied").not.toHaveBeenCalled();
    expect(mocks.files.get("outline/chapters/005.md")).toBe(FIVE);

    fireEvent.click(within(hold).getByRole("button", { name: t("bibleStudio.hold.apply") }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.files.get("outline/chapters/005.md")).toBe(FIVE_NEW);
    await waitFor(() => expect(screen.queryByRole("group", { name: t("bibleStudio.hold.region") })).toBeNull());
  });

  it("is left as it was when the author leaves it: nothing is changed, and the proposal can be applied later", async () => {
    mocks.files.set("bible/decisions.md", lockedLog([5]));
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    const hold = await screen.findByRole("group", { name: t("bibleStudio.hold.region") });
    fireEvent.click(within(hold).getByRole("button", { name: t("bibleStudio.hold.leave") }));
    await waitFor(() => expect(screen.queryByRole("group", { name: t("bibleStudio.hold.region") })).toBeNull());
    expect(screen.getAllByText(t("bibleStudio.hold.left")).length).toBeGreaterThan(0);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.files.get("outline/chapters/005.md")).toBe(FIVE);
  });

  it("is applied at once when no locked decision covers what it touches, and when the decision is only open", async () => {
    mocks.files.set("bible/decisions.md", lockedLog([9]));
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("group", { name: t("bibleStudio.hold.region") })).toBeNull();
    cleanup();
    mocks.save.mockClear();
    mocks.files.set("outline/chapters/005.md", FIVE);
    mocks.files.set("outline/chapters/004.md", FOUR);
    mocks.files.set("bible/decisions.md", setDecisionStatus(lockedLog([5]), "d-001", "open")!);
    const session = createEmptyAssistantSession("Outline");
    session.messages = [{ id: "ask", role: "user", text: "again" }, await proposal()];
    useAssistantStore.setState({ currentSession: session });
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  });

  it("says what is held in Italian when the interface is in Italian", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, ui: { ...useSettingsStore.getState().settings.ui, language: "it" } } });
    mocks.files.set("bible/decisions.md", lockedLog([5]));
    render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "assistant.applyAllFiles" }));
    const hold = await screen.findByRole("group", { name: t("bibleStudio.hold.region") });
    expect(hold).toHaveTextContent("Questa modifica tocca la voce del capitolo 5, coperto dalla decisione bloccata d-001");
    expect(within(hold).getByRole("button", { name: t("bibleStudio.hold.apply") })).toBeInTheDocument();
  });
});
