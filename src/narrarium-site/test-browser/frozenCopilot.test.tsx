import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { chapterFreezeRecord, createAutopilotState, sha256Hex, type FrozenEditsMode } from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({ store: null as unknown as InstanceType<typeof import("narrarium-engine/testing").MemoryBookStore> }));

vi.mock("@/assistant/service", () => ({ appendAssistantNote: vi.fn(), applyParagraphRewrite: vi.fn(), compactAssistantSession: vi.fn(async ({ session }) => session), runAssistantPrompt: vi.fn() }));
vi.mock("@/assistant/chatCloud", async (original) => ({ ...await original<typeof import("@/assistant/chatCloud")>(), listAssistantSessions: vi.fn(async () => []), saveAssistantSession: vi.fn(async () => ({ fileId: "f", revision: "r" })), loadAssistantSession: vi.fn(), deleteAssistantSession: vi.fn() }));
vi.mock("@/assistant/chatLocal", () => ({ listLocalChatSessions: vi.fn(async () => []), saveLocalChatSession: vi.fn(async () => undefined), loadLocalChatSession: vi.fn(), deleteLocalChatSession: vi.fn(async () => undefined) }));
vi.mock("@/assistant/context", async (original) => ({ ...await original<typeof import("@/assistant/context")>(), loadWriterContext: vi.fn(async () => ({ title: "Chapter", summary: "", loadedFilePaths: [], availableFiles: [], relevantFiles: [], route: { kind: "chapter", bookId: "book", chapterSlug: "001-the-key" }, book: null, structure: null, branchReady: true })) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false }) }));
// The book's working copy, where the notice reads the chapters a proposal touches and the autopilot's choice.
vi.mock("@/autopilot/browserStore", async (original) => ({ ...await original<typeof import("@/autopilot/browserStore")>(), createBrowserBookStore: () => mocks.store }));

import i18n from "@/i18n";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { frozenProposalNotices, type ProposedFile } from "@/frozen/proposal";
import { createEmptyAssistantSession, useAssistantStore, type AssistantMessage } from "@/assistant/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { resetAssistantSessionIndex } from "@/assistant/sessionIndex";
import { DEFAULT_SETTINGS } from "@/types/settings";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const KEY = "001-the-key";
const OTHER = "002-the-flood";
const CHAPTER = `chapters/${KEY}/chapter.md`;
const SCENE = `chapters/${KEY}/001-the-pier.md`;
const RECORD = chapterFreezeRecord({ at: "2026-11-21T10:00:00.000Z", by: "autopilot", chapterBody: "# The key\n\nWhere the key is found.", scenes: [{ name: "001-the-pier.md", body: "Mira finds the key under the pier." }] });
const recordYaml = `frozen:\n  at: ${RECORD.at}\n  by: autopilot\n  digest: ${RECORD.digest}\n  files:\n    001-the-pier.md: ${RECORD.files["001-the-pier.md"]}\n`;
const chapterMd = (options: { summary?: string; body?: string; frozen?: boolean } = {}) =>
  `---\ntype: chapter\nid: chapter:${KEY}\nnumber: 1\ntitle: The key\nsummary: ${options.summary ?? "Mira finds the key."}\n${options.frozen === false ? "" : recordYaml}---\n\n${options.body ?? "# The key\n\nWhere the key is found."}\n`;
const scene = (body: string, title = "The pier") => `---\ntype: paragraph\nid: paragraph:${KEY}:001-the-pier\nchapter: chapter:${KEY}\nnumber: 1\ntitle: ${title}\n---\n\n${body}\n`;
const CURRENT = [{ path: CHAPTER, content: chapterMd() }, { path: `chapters/${OTHER}/chapter.md`, content: chapterMd({ frozen: false }).split(KEY).join(OTHER) }];
const notices = (files: ProposedFile[]) => frozenProposalNotices(files, CURRENT);

describe("what a proposal does to a frozen chapter", () => {
  it("changes it when it changes the text of a scene, adds a scene or deletes one", () => {
    const changed = [{ slug: KEY, number: 1, kind: "changed" }];
    expect(notices([{ path: SCENE, content: scene("Mira hides the key in the lighthouse.") }])).toEqual(changed);
    expect(notices([{ path: `chapters/${KEY}/002-the-lighthouse.md`, content: scene("A new scene.") }])).toEqual(changed);
    expect(notices([{ path: SCENE, content: null }])).toEqual(changed);
    expect(notices([{ path: SCENE, body: "Mira hides the key in the lighthouse." }]), "a rewrite of the scene's text").toEqual(changed);
    expect(notices([{ path: CHAPTER, content: chapterMd({ body: "# The key\n\nWhere the key is lost." }) }])).toEqual(changed);
  });

  it("does not change it when only the frontmatter changes, or the text stays the same", () => {
    expect(notices([{ path: SCENE, content: scene("Mira finds the key under the pier.", "At the pier") }])).toEqual([]);
    expect(notices([{ path: CHAPTER, content: chapterMd({ summary: "The key, found at last." }) }])).toEqual([]);
    expect(notices([{ path: SCENE, body: "Mira finds the key under the pier." }])).toEqual([]);
  });

  it("unfreezes it when it writes chapter.md without the record", () => {
    expect(notices([{ path: CHAPTER, content: chapterMd({ frozen: false }) }, { path: SCENE, content: scene("Changed.") }])).toEqual([{ slug: KEY, number: 1, kind: "unfrozen" }]);
  });

  it("says nothing of a chapter that is not frozen, or of files that are not the text of a chapter", () => {
    expect(notices([{ path: `chapters/${OTHER}/001-the-rain.md`, content: scene("Rain.") }])).toEqual([]);
    expect(notices([{ path: "characters/mira.md", content: "---\ntype: character\n---\n\nMira." }, { path: `chapters/${KEY}/notes.txt`, content: "notes" }, { path: `chapters/${KEY}/draft.md`, content: "draft" }])).toEqual([]);
  });
});

async function fileProposal(updates: Array<{ path: string; content: string | null }>): Promise<AssistantMessage> {
  return {
    id: "proposal", role: "assistant", text: "I changed the scene.",
    action: {
      kind: "apply-file-updates", bookId: "book", toolId: "multi-file-edit", owner: "local", repo: "book", branch: "main",
      updates: updates.map((update) => ({ ...update, reason: "The pier" })),
      sourceRevisions: Object.fromEntries(await Promise.all(updates.map(async (update) => [update.path, await sha256Hex(mocks.store.files.get(update.path) ?? "")]))),
      sourceRevision: "unused", generatedAt: new Date().toISOString(),
    },
  };
}

function rewriteProposal(): AssistantMessage {
  return {
    id: "rewrite", role: "assistant", text: "I prepared a revised version of the current paragraph.",
    action: { kind: "apply-paragraph-rewrite", bookId: "book", toolId: "rewrite-current-paragraph", owner: "local", repo: "book", branch: "main", sourceRevision: "unused", sourceRevisions: {}, generatedAt: new Date().toISOString(), chapterSlug: KEY, paragraphPath: SCENE, proposedBody: "Mira hides the key in the lighthouse." },
  };
}

function bookWith(mode?: FrozenEditsMode) {
  const files: Record<string, string> = { [CHAPTER]: chapterMd(), [SCENE]: scene("Mira finds the key under the pier."), "characters/mira.md": "---\ntype: character\n---\n\nMira.\n" };
  if (mode) {
    const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "Glass" });
    state.options = { ...state.options, frozenEdits: mode };
    files["autopilot/state.json"] = JSON.stringify(state);
  }
  mocks.store = new MemoryBookStore(files);
  return vi.spyOn(mocks.store, "readMany");
}

async function openPanel(message: AssistantMessage) {
  const session = createEmptyAssistantSession("Chapter");
  session.messages = [{ id: "ask", role: "user", text: "change the scene" }, message];
  useAssistantStore.setState({ open: true, busy: false, sessions: [], sessionAccountIdentity: null, sessionsLoading: false, currentSession: session });
  render(<MemoryRouter initialEntries={[`/app/books/book/chapters/${KEY}`]}><AssistantPanel /></MemoryRouter>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  resetAssistantSessionIndex(null);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
  useAuthStore.setState({ user: { provider: "google", providerAccountId: "writer-id", email: "writer@example.com", name: "Writer", picture: "" }, accessToken: "token", accessTokenExpiry: Date.now() + 60_000 });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ id: "book", owner: "local", repo: "book", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" }] } });
});

afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe.each<Language>(["en", "it"])("a proposal of the Copilot that changes a frozen chapter (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("says that the chapter is frozen and that the author will be asked whether to review it", async () => {
    bookWith();
    await openPanel(await fileProposal([{ path: SCENE, content: scene("Mira hides the key in the lighthouse.") }]));
    const notice = await screen.findByText(t("frozen.copilot.ask", { number: 1 }));
    expect(notice.closest("[data-frozen-proposal]")).not.toBeNull();
    expect(t("frozen.copilot.ask", { number: 1 })).toBe(language === "en"
      ? "Chapter 1 is frozen: after the change you will be asked whether to review it."
      : "Il capitolo 1 è congelato: dopo la modifica ti verrà chiesto se rivederlo.");
  });

  it("says it of a rewrite of one of its scenes too", async () => {
    bookWith();
    await openPanel(rewriteProposal());
    expect(await screen.findByText(t("frozen.copilot.ask", { number: 1 }))).toBeInTheDocument();
  });
});

describe("the notice of a proposal for a frozen chapter", () => {
  it("follows what the autopilot does with a changed frozen chapter", async () => {
    bookWith("auto");
    await openPanel(await fileProposal([{ path: SCENE, content: scene("Mira hides the key in the lighthouse.") }]));
    expect(await screen.findByText(t("frozen.copilot.auto", { number: 1 }))).toBeInTheDocument();
    expect(screen.queryByText(t("frozen.copilot.ask", { number: 1 }))).not.toBeInTheDocument();
  });

  it("says when the proposal takes the freeze away", async () => {
    bookWith("notify");
    await openPanel(await fileProposal([{ path: CHAPTER, content: chapterMd({ frozen: false, body: "# The key\n\nWhere the key is lost." }) }]));
    expect(await screen.findByText(t("frozen.copilot.unfrozen", { number: 1 }))).toBeInTheDocument();
  });

  it("is not there, and reads nothing, for a proposal that does not touch the text of a chapter", async () => {
    const readMany = bookWith();
    await openPanel(await fileProposal([{ path: "characters/mira.md", content: "---\ntype: character\n---\n\nMira, older.\n" }]));
    const block = await screen.findByText(t("assistant.proposedChanges"));
    await waitFor(() => expect(within(block.parentElement!).getByText(/characters\/mira\.md/)).toBeInTheDocument());
    expect(document.querySelector("[data-frozen-proposal]")).toBeNull();
    expect(readMany).not.toHaveBeenCalled();
  });

  it("is not there for a frozen chapter whose text the proposal leaves as it is", async () => {
    bookWith();
    await openPanel(await fileProposal([{ path: CHAPTER, content: chapterMd({ summary: "The key, found at last." }) }]));
    await waitFor(() => expect(mocks.store.readMany).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("[data-frozen-proposal]")).toBeNull();
  });
});
