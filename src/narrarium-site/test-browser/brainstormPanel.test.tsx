import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BookConflictError, parseOutlineJournal, sha256Hex, type BookFileChange } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  chats: new Map<string, unknown>(),
  metas: [] as Array<Record<string, unknown>>,
  runAssistantPrompt: vi.fn(),
  runBrainstormPrompt: vi.fn(),
  saved: vi.fn(),
  files: new Map<string, string>(),
  state: null as unknown,
  commit: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: mocks.runAssistantPrompt }));
vi.mock("@/assistant/brainstorm/runner", () => ({ runBrainstormPrompt: mocks.runBrainstormPrompt }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({
  listLocalChatSessions: vi.fn(async () => mocks.metas),
  saveLocalChatSession: vi.fn(async (session: { id: string }) => { mocks.saved(session); mocks.chats.set(session.id, session); }),
  loadLocalChatSession: vi.fn(async (id: string) => { const chat = mocks.chats.get(id); if (!chat) throw new Error(`Local chat ${id} is unavailable.`); return chat; }),
  deleteLocalChatSession: vi.fn(async () => undefined),
}));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Synopsis", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "book-outline", bookId: "book" }, book: null, structure: null, branchReady: true })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));
// The book's working copy, where the Synopsis page saves: one local commit, checked against the files as they were read.
vi.mock("@/outline/outlineSource", async (original) => ({
  ...await original<typeof import("@/outline/outlineSource")>(),
  browserOutlineSource: () => ({
    files: async () => Promise.all([...mocks.files].map(async ([path, content]) => ({ path, content, hash: await sha256Hex(content) }))),
    commit: mocks.commit,
    readState: async () => mocks.state,
    readFiles: async () => [],
  }),
}));
vi.mock("@/assistant/mutationRefresh", async (original) => ({ ...await original<typeof import("@/assistant/mutationRefresh")>(), refreshBookAfterMutation: mocks.refresh }));

import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { AssistantLauncher } from "@/components/assistant/AssistantLauncher";
import { useBrainstormLauncher } from "@/components/assistant/brainstorm/BrainstormLauncher";
import { createEmptyAssistantSession, useAssistantStore, type BrainstormingTarget } from "@/assistant/store";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

const TARGET: BrainstormingTarget = { bookId: "book", title: "Brainstorming · The Glass Harbor" };

function panel() {
  return render(<MemoryRouter initialEntries={["/app/books/book/outline"]}><AssistantPanel /></MemoryRouter>);
}

function chat(title: string, text: string, brainstorm?: { bookId: string }) {
  const session = createEmptyAssistantSession(title, undefined, brainstorm);
  session.messages = [{ id: `${title}-m`.replace(/[^A-Za-z0-9-]/g, "-"), role: "user", text }];
  return session;
}

beforeEach(() => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  mocks.chats = new Map();
  mocks.metas = [];
  mocks.runAssistantPrompt.mockReset();
  mocks.runBrainstormPrompt.mockReset().mockImplementation(async () => ({ id: "idea", role: "assistant", text: "What if the harbor is the narrator?" }));
  mocks.saved.mockReset();
  mocks.files = new Map();
  mocks.state = null;
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.commit.mockReset().mockImplementation(async (changes: BookFileChange[]) => {
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
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ id: "book", owner: "", repo: "", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", localRepositoryId: "repo", activeBranch: "local:repo", addedAt: "2026-11-21T00:00:00.000Z" }] } });
  useUiStore.setState({ floatingHidden: false });
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: chat("Book", "What does chapter 2 say?"), brainstorming: null, copilotSession: null, pageLauncher: null });
});

afterEach(() => cleanup());

describe("Brainstorming, the Copilot's mode on the Synopsis page", () => {
  it("has its own name, mark and accent, none of the Copilot's tools, and a way back that brings the Copilot's chat back as it was", async () => {
    useAssistantStore.getState().startBrainstorming(TARGET);
    panel();
    expect(await screen.findByText("brainstorm.name", { selector: "p" })).toBeInTheDocument();
    const root = document.querySelector<HTMLElement>('[data-assistant-mode="brainstorming"]');
    expect(root, "the panel says its mode").not.toBeNull();
    expect(root!.className).toContain("brainstorm-accent");
    await waitFor(() => expect(root!.querySelector("svg[data-brainstorm-mark]"), "Brainstorming's own mark").not.toBeNull());
    expect(await screen.findByText("brainstorm.empty"), "a new chat of the book, not the Copilot's").toBeInTheDocument();
    expect(screen.queryByText("What does chapter 2 say?", { selector: "div.bg-primary" })).toBeNull();
    // Only what Brainstorming is for: no quick actions of the Copilot, no attachments, no live voice, no autopilot tab.
    expect(screen.queryByRole("button", { name: /assistant\.quickActions/ })).toBeNull();
    expect(screen.queryByTitle("assistant.attachFiles")).toBeNull();
    expect(screen.queryByTitle("assistant.liveVoice")).toBeNull();
    expect(screen.queryByRole("tab", { name: /autopilot\.title/ })).toBeNull();
    expect(screen.getByPlaceholderText("brainstorm.placeholder")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "brainstorm.back" }));
    expect(await screen.findByText("assistant.title", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("What does chapter 2 say?", { selector: "div.bg-primary" })).toBeInTheDocument();
    expect(document.querySelector('[data-assistant-mode="copilot"]')!.className).not.toContain("brainstorm-accent");
    expect(screen.getByRole("tab", { name: /autopilot\.title/ })).toBeInTheDocument();
    expect(useAssistantStore.getState().brainstorming).toBeNull();
  });

  it("reopens the latest chat of its book, and lists only the chats of its book, while the Copilot lists none of them", async () => {
    const latest = chat(TARGET.title, "Tighten the middle", { bookId: "book" });
    const older = chat("Brainstorming · older", "An older idea", { bookId: "book" });
    const other = chat("Brainstorming · Another book", "Another book's idea", { bookId: "other" });
    const copilotChat = chat("Copilot chat", "A question for the Copilot");
    for (const session of [latest, older, other, copilotChat]) mocks.chats.set(session.id, session);
    mocks.metas = [latest, other, copilotChat, older].map((session) => ({ id: session.id, fileId: session.id, title: session.title, contextTitle: session.contextTitle, updatedAt: session.updatedAt, ...(session.mode ? { mode: session.mode, bookId: session.bookId } : {}) }));
    useAssistantStore.getState().startBrainstorming(TARGET);
    panel();
    expect(await screen.findByText("Tighten the middle", { selector: "div.bg-primary" })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("tab", { name: /assistant\.tabHistory/ }));
    fireEvent.click(screen.getByRole("tab", { name: /assistant\.tabHistory/ }));
    expect(await screen.findByText(TARGET.title)).toBeInTheDocument();
    expect(screen.getByText("Brainstorming · older")).toBeInTheDocument();
    expect(screen.queryByText("Brainstorming · Another book")).toBeNull();
    expect(screen.queryByText("Copilot chat")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "brainstorm.back" }));
    await screen.findByText("assistant.title", { selector: "p" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /assistant\.tabHistory/ }));
    fireEvent.click(screen.getByRole("tab", { name: /assistant\.tabHistory/ }));
    expect(await screen.findByText("Copilot chat")).toBeInTheDocument();
    expect(screen.queryByText(TARGET.title)).toBeNull();
    expect(screen.queryByText("Brainstorming · older")).toBeNull();
  });

  it("sends a request to Brainstorming's own runner and never to the Copilot's, and keeps the chat as one of its book", async () => {
    useAssistantStore.getState().startBrainstorming(TARGET);
    panel();
    await screen.findByText("brainstorm.empty");
    fireEvent.change(screen.getByPlaceholderText("brainstorm.placeholder"), { target: { value: "What if the harbor is the narrator?" } });
    fireEvent.click(screen.getByRole("button", { name: "assistant.send" }));
    expect(await screen.findByText(/the harbor is the narrator\?/, { selector: ".doc-prose *" })).toBeInTheDocument();
    expect(mocks.runAssistantPrompt).not.toHaveBeenCalled();
    expect(mocks.runBrainstormPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.runBrainstormPrompt.mock.calls[0][0]).toMatchObject({ prompt: "What if the harbor is the narrator?", book: { id: "book" }, branch: "main" });
    const session = useAssistantStore.getState().currentSession!;
    expect(session.mode).toBe("brainstorming");
    expect(session.bookId).toBe("book");
    const bubble = screen.getByText("What if the harbor is the narrator?", { selector: "div.bg-primary" });
    expect(bubble.closest(".brainstorm-accent"), "the author's bubble carries the accent").not.toBeNull();
  });
});

function SynopsisPage({ target }: { target: BrainstormingTarget | null }) {
  useBrainstormLauncher("book", target);
  return null;
}

describe("Brainstorming's launcher", () => {
  it("is in the launcher of the shell while the Synopsis page is open, starts the mode, and leaving the page ends the mode", async () => {
    useAssistantStore.setState({ open: false });
    const page = render(<MemoryRouter><AssistantLauncher /><SynopsisPage target={TARGET} /></MemoryRouter>);
    const launcher = await screen.findByRole("button", { name: "brainstorm.open" });
    expect(launcher.className).toContain("brainstorm-accent");
    expect(within(launcher).queryByText("brainstorm.open")).toBeInTheDocument();
    // The Copilot's own button keeps its name, and shows only its icon on a narrow screen.
    expect(screen.getByRole("button", { name: "assistant.floatingButton" })).toBeInTheDocument();
    fireEvent.click(launcher);
    expect(useAssistantStore.getState().brainstorming).toEqual(TARGET);
    expect(useAssistantStore.getState().open).toBe(true);
    // The book read again after a change: its target is gone for a moment, its button with it, and the mode stays on.
    page.rerender(<MemoryRouter><AssistantLauncher /><SynopsisPage target={null} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "brainstorm.open" })).toBeNull());
    expect(useAssistantStore.getState().brainstorming).toEqual(TARGET);
    page.rerender(<MemoryRouter><AssistantLauncher /><SynopsisPage target={TARGET} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "brainstorm.open" })).toBeInTheDocument();
    page.rerender(<MemoryRouter><AssistantLauncher /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "brainstorm.open" })).toBeNull());
    expect(useAssistantStore.getState().brainstorming, "the Copilot is the Copilot again everywhere else").toBeNull();
  });
});

const entry = (number: number, title: string, body: string) => `---\ntype: outline-chapter\nnumber: ${number}\ntitle: ${title}\norigin: author\n---\n\n${body}\n`;
const KEY = entry(2, "The key", "Mira finds the key.");
const VAULT = entry(3, "The vault", "Mira opens the vault.");
const scene = { number: 1, title: "A scene", goal: "", beats: [], characters: [], status: "reviewed", revisions: 0 };

async function proposalChat() {
  const session = createEmptyAssistantSession(TARGET.title, undefined, { bookId: "book" });
  session.messages = [
    { id: "ask", role: "user", text: "Open with the vault" },
    {
      id: "proposal", role: "assistant", text: "In the synopsis, chapter 3 «The vault» becomes chapter 2.",
      action: {
        kind: "apply-file-updates", bookId: "book", toolId: "edit-outline", owner: "", repo: "", branch: "main",
        updates: [{ path: "outline/chapters/002.md", content: entry(2, "The vault", "Mira opens the vault."), reason: "Chapter 2 of the synopsis" }, { path: "outline/chapters/003.md", content: entry(3, "The key", "Mira finds the key."), reason: "Chapter 3 of the synopsis" }],
        sourceRevisions: { "outline/chapters/002.md": await sha256Hex(KEY), "outline/chapters/003.md": await sha256Hex(VAULT) },
        sourceRevision: "unused", generatedAt: new Date().toISOString(),
      },
    },
  ];
  return session;
}

describe("a proposal of Brainstorming", () => {
  beforeEach(() => {
    mocks.files = new Map([["outline/chapters/002.md", KEY], ["outline/chapters/003.md", VAULT]]);
    // Chapter 2 is written and closed: the autopilot will ask the author whether to rewrite it. Chapter 3 is not written: it is planned again.
    mocks.state = { options: { frozenEdits: "ask" }, plan: { approved: true, chapters: [
      { number: 2, title: "The key", slug: "002-the-key", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [scene], outlineDigest: "0123456789abcdef" },
      { number: 3, title: "The vault", slug: "003-the-vault", summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [], outlineDigest: "0123456789abcdef" },
    ] } };
  });

  it("says what the autopilot will do and shows every difference before anything is applied, asks once more, then applies where the Synopsis page saves, and undoes", async () => {
    useAssistantStore.getState().startBrainstorming(TARGET);
    useAssistantStore.setState({ currentSession: await proposalChat() });
    panel();
    const card = await screen.findByRole("region", { name: "brainstorm.proposal.title" });
    await waitFor(() => expect(card.querySelector('[data-outcome="ask"]')).not.toBeNull());
    expect(card.querySelector('[data-outcome="ask"]')!.textContent).toBe("outline.written.ask");
    expect(card.querySelector('[data-outcome="replan"]')!.textContent).toBe("brainstorm.proposal.outcome.replan");
    expect(within(card).getAllByText(/Mira opens the vault\./).length, "the difference of each file").toBeGreaterThan(0);
    expect(mocks.commit).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: /brainstorm\.proposal\.apply/ }));
    const dialog = await screen.findByRole("dialog", { name: "brainstorm.proposal.confirmTitle" });
    expect(dialog.className).toContain("brainstorm-accent");
    expect(within(dialog).getByText("outline.written.ask")).toBeInTheDocument();
    expect(mocks.commit, "nothing is applied before the author confirms").not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "brainstorm.proposal.confirm" }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    expect(mocks.commit.mock.calls[0][0].slice(0, 2)).toEqual([
      { path: "outline/chapters/002.md", content: entry(2, "The vault", "Mira opens the vault."), expectedHash: await sha256Hex(KEY) },
      { path: "outline/chapters/003.md", content: entry(3, "The key", "Mira finds the key."), expectedHash: await sha256Hex(VAULT) },
    ]);
    // The same commit adds a series to the journal of the Synopsis: Brainstorming's, the two entries moved.
    const journal = parseOutlineJournal(mocks.commit.mock.calls[0][0][2].content);
    expect(journal.series.map((series) => [series.by, series.chapters.map((item) => [item.chapter, item.change, item.from])])).toEqual([["brainstorming", [[2, "moved", 3], [3, "moved", 2]]]]);
    expect(mocks.files.get("outline/chapters/002.md")).toContain("The vault");
    expect(await within(card).findByText("brainstorm.proposal.applied")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /brainstorm\.proposal\.undo/ }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2));
    expect(mocks.files.get("outline/chapters/002.md")).toBe(KEY);
    expect(mocks.files.get("outline/chapters/003.md")).toBe(VAULT);
  });

  it("starts from a suggestion: it fills in the request, which the author sends or changes", async () => {
    useAssistantStore.getState().startBrainstorming(TARGET);
    panel();
    const starters = await screen.findByRole("region", { name: "brainstorm.starters.label" });
    expect(starters.querySelectorAll("[data-brainstorm-starter^='start.']")).toHaveLength(4);
    expect(starters.querySelectorAll("[data-brainstorm-starter^='change.']")).toHaveLength(6);
    fireEvent.click(within(starters).getByRole("button", { name: "brainstorm.starters.change.middle.label" }));
    const composer = screen.getByPlaceholderText("brainstorm.placeholder") as HTMLTextAreaElement;
    expect(composer.value).toBe("brainstorm.starters.change.middle.prompt");
    expect(document.activeElement).toBe(composer);
    expect(mocks.runBrainstormPrompt, "nothing is sent until the author sends it").not.toHaveBeenCalled();
  });
});
