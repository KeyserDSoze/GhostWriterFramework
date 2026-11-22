import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";
import { SERVER_FEATURE_AUTOPILOT_CONTROLS, freezeChapterChanges, loadBookSnapshot, type FrozenAction, type FrozenStatus, type ServerInfo } from "narrarium-engine";

const mocks = vi.hoisted(() => ({
  folder: null as unknown,
  runtime: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
  book: null as unknown,
  structure: null as unknown,
  read: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/frozen/chapterFolder", () => ({ readChapterFolder: async () => mocks.folder }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => mocks.runtime }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { FrozenChangeNotice, FrozenChapterBar } from "@/components/frozen/FrozenChapter";
import { useFrozenChapter } from "@/components/frozen/useFrozenChapter";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { ChapterPage } from "@/pages/ChapterPage";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { Chapter } from "@/types/book";

type Language = "en" | "it";
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SLUG = "001-the-key";
const CHAPTER_PATH = `chapters/${SLUG}/chapter.md`;
const SCENE_PATH = `chapters/${SLUG}/001-the-pier.md`;
const CHAPTER: Chapter = { slug: SLUG, path: `chapters/${SLUG}`, title: "The key", paragraphs: [{ number: "001", title: "The pier", path: SCENE_PATH }], hasResume: false, hasEvaluation: false } as Chapter;
const FROZEN_AT = "2026-11-21T11:00:00.000Z";
const FROZEN_ACTIONS: FrozenAction[] = ["review-and-update", "review-only", "mark-reviewed"];

const scene = (text: string) => `---\ntype: paragraph\nid: paragraph:${SLUG}:001-the-pier\nchapter: chapter:${SLUG}\nnumber: 1\ntitle: The pier\n---\n\n${text}\n`;
const plain = { [CHAPTER_PATH]: `---\ntype: chapter\nid: chapter:${SLUG}\nnumber: 1\ntitle: The key\n---\n\n# The key\n`, [SCENE_PATH]: scene("Mira finds the key under the pier.") };

/** The chapter's folder as this browser has it: frozen (by the autopilot or the author) or not, and changed since or not. */
async function folder({ frozenBy, changed = false, autopilot = false }: { frozenBy?: "autopilot" | "author"; changed?: boolean; autopilot?: boolean } = {}) {
  const files: Record<string, string> = { ...seedBookFiles(), ...plain };
  if (frozenBy) files[CHAPTER_PATH] = freezeChapterChanges(await loadBookSnapshot(new MemoryBookStore(files)), SLUG, frozenBy, FROZEN_AT)[0].content!;
  if (changed) files[SCENE_PATH] = scene("Mira finds the key under the pier, and hides it.");
  return { store: new MemoryBookStore(files), hasAutopilot: autopilot };
}

function statusWith(entry: Partial<FrozenStatus["changes"][number]> | null): FrozenStatus {
  return { mode: "ask", pending: [], warnings: [], changes: entry ? [{ kind: "frozen", number: 1, slug: SLUG, title: "The key", fingerprint: "f1", actions: FROZEN_ACTIONS, ...entry } as FrozenStatus["changes"][number]] : [] };
}

function Frozen({ book }: { book: BookEntry }) {
  const frozen = useFrozenChapter({ book, branch: "main", chapter: CHAPTER });
  return <div><FrozenChapterBar frozen={frozen} /><textarea aria-label="The editor" /><FrozenChangeNotice frozen={frozen} /></div>;
}

function Probe({ book = BOOK }: { book?: BookEntry }) {
  return <MemoryRouter><Frozen book={book} /></MemoryRouter>;
}

const notice = () => screen.findByRole("region", { name: t("frozen.change.title") });
const action = (key: FrozenAction) => screen.getByRole("button", { name: t(`frozen.actions.${key}`) });
const dateOf = (language: string) => new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(FROZEN_AT));

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.runtime = {
    frozenStatus: vi.fn(async () => statusWith({})),
    resolveFrozenChange: vi.fn(async () => statusWith({ pending: { action: "review-and-update", at: "2026-11-22T10:00:00.000Z" } })),
    setChapterFrozen: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    describeError: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  };
  mocks.toast.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(async () => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("a chapter that is not frozen", () => {
  it("can be frozen by hand, as it is now", async () => {
    mocks.folder = await folder();
    render(<Probe />);
    fireEvent.click(await screen.findByRole("button", { name: t("frozen.toggle.freeze") }));
    await waitFor(() => expect(mocks.runtime.setChapterFrozen).toHaveBeenCalledWith(BOOK.id, SLUG, true));
    expect(screen.queryByRole("region", { name: t("frozen.change.title") })).not.toBeInTheDocument();
  });
});

describe.each<Language>(["en", "it"])("a frozen chapter (%s)", (language) => {
  beforeEach(async () => {
    await act(async () => { await i18n.changeLanguage(language); });
  });

  it("says when it was frozen and by whom, in words and with a lock, and can be unfrozen after a confirmation", async () => {
    mocks.folder = await folder({ frozenBy: "autopilot" });
    render(<Probe />);
    const badge = await screen.findByText(t("frozen.badge.autopilot", { date: dateOf(language) }));
    expect(badge.closest("[data-frozen-badge]")?.querySelector("svg")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("frozen.toggle.unfreeze") }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(t("frozen.unfreeze.description"));
    fireEvent.click(within(dialog).getByRole("button", { name: t("frozen.unfreeze.confirm") }));
    await waitFor(() => expect(mocks.runtime.setChapterFrozen).toHaveBeenCalledWith(BOOK.id, SLUG, false));
  });

  it("says when the author froze it", async () => {
    mocks.folder = await folder({ frozenBy: "author" });
    render(<Probe />);
    expect(await screen.findByText(t("frozen.badge.author", { date: dateOf(language) }))).toBeInTheDocument();
  });

  it("offers the three decisions under the editor once it changed, each with what it does", async () => {
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe />);
    const region = await notice();
    // Under the editor.
    expect(screen.getByLabelText("The editor").compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(within(region).getAllByRole("button").map((button) => button.textContent)).toEqual(FROZEN_ACTIONS.map((key) => t(`frozen.actions.${key}`))));
    for (const key of FROZEN_ACTIONS) expect(action(key)).toHaveAccessibleDescription(t(`frozen.actionHelp.${key}`));
    expect(region).toHaveTextContent(t("frozen.change.queuedAi"));
    expect(region).toHaveTextContent(t("frozen.change.modified", { list: "001-the-pier.md" }));
  });
});

describe("a decision about a change", () => {
  it("marks the chapter as reviewed at once", async () => {
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe />);
    await notice();
    await waitFor(() => expect(action("mark-reviewed")).toBeEnabled());
    fireEvent.click(action("mark-reviewed"));
    await waitFor(() => expect(mocks.runtime.resolveFrozenChange).toHaveBeenCalledWith(BOOK.id, 1, "mark-reviewed"));
  });

  it("queues a review for the next run, says so, and starts the autopilot on request", async () => {
    const queued = statusWith({ pending: { action: "review-and-update", at: "2026-11-22T10:00:00.000Z" } });
    mocks.runtime.resolveFrozenChange.mockImplementation(async () => {
      mocks.runtime.frozenStatus.mockResolvedValue(queued);
      return queued;
    });
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe />);
    await notice();
    await waitFor(() => expect(action("review-and-update")).toBeEnabled());
    fireEvent.click(action("review-and-update"));
    await waitFor(() => expect(mocks.runtime.resolveFrozenChange).toHaveBeenCalledWith(BOOK.id, 1, "review-and-update"));
    expect(await screen.findByText(t("frozen.queued.title", { action: t("frozen.actions.review-and-update") }))).toBeInTheDocument();
    expect(screen.getByText(t("frozen.queued.next"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("frozen.actions.review-only") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("frozen.queued.start") }));
    await waitFor(() => expect(mocks.runtime.start).toHaveBeenCalledWith(BOOK.id));
    expect(screen.getByRole("link", { name: t("frozen.queued.follow") })).toHaveAttribute("href", `/app/books/${BOOK.id}/autopilot`);
  });

  it("is shown as queued when it was taken before, and the running autopilot takes it at its next step", async () => {
    mocks.runtime.frozenStatus.mockResolvedValue(statusWith({ pending: { action: "review-only", at: "2026-11-22T10:00:00.000Z" } }));
    useAutopilotStore.setState({ summaries: { [BOOK.id]: { status: "running" } as never } });
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe />);
    expect(await screen.findByText(t("frozen.queued.title", { action: t("frozen.actions.review-only") }))).toBeInTheDocument();
    expect(screen.getByText(t("frozen.queued.running"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("frozen.queued.start") })).not.toBeInTheDocument();
  });

  it("can only mark the chapter as reviewed when the autopilot has no plan for it, and says why", async () => {
    mocks.runtime.frozenStatus.mockResolvedValue(statusWith({ actions: ["mark-reviewed"] }));
    mocks.folder = await folder({ frozenBy: "author", changed: true });
    render(<Probe />);
    const region = await notice();
    await waitFor(() => expect(within(region).getAllByRole("button").map((button) => button.textContent)).toEqual([t("frozen.actions.mark-reviewed")]));
    expect(region).toHaveTextContent(t("frozen.change.notInPlan"));
  });

  it("is not asked of the author while the autopilot works on the chapter itself", async () => {
    mocks.runtime.frozenStatus.mockResolvedValue(statusWith(null));
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe />);
    const region = await notice();
    await waitFor(() => expect(region).toHaveTextContent(t("frozen.change.inHands")));
    expect(within(region).queryAllByRole("button")).toEqual([]);
  });
});

describe("a book that runs on a personal server that predates the frozen chapters", () => {
  it("explains why nothing can be decided from here, asks nothing of the server, and does not freeze", async () => {
    const book = { ...BOOK, autopilotHost: "server" as const };
    useAutopilotStore.setState({ server: { status: "online", info: { serverVersion: "0.1.8", features: [SERVER_FEATURE_AUTOPILOT_CONTROLS] } as ServerInfo, message: null, books: [], updates: null, connection: null } });
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
    render(<Probe book={book} />);
    const region = await notice();
    expect(region).toHaveTextContent(t("frozen.server.unsupported", { version: "0.1.9" }));
    expect(within(region).queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("button", { name: t("frozen.toggle.unfreeze") })).toBeDisabled();
    expect(mocks.runtime.frozenStatus).not.toHaveBeenCalled();
  });
});

describe("the pages of a chapter and of a scene", () => {
  beforeEach(async () => {
    mocks.book = { ...BOOK };
    mocks.structure = { title: "The Glass Harbor", language: "en", ghostwriters: [], readerEvaluationFiles: [], researchFiles: [], searchableFiles: [], loadedBranch: "main", chapters: [CHAPTER] };
    mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
      const files = (mocks.folder as { store: MemoryBookStore }).store.files;
      const content = files.get(path);
      if (content === undefined) throw new Error(`unexpected read of ${path}`);
      return { content, sha: `sha-${path}` };
    });
    mocks.folder = await folder({ frozenBy: "autopilot", changed: true, autopilot: true });
  });

  it("show the frozen chapter above the scene's editor and the decision under it", async () => {
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK.id}/chapters/${SLUG}/paragraphs/001`]}><Routes><Route path="/app/books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<ParagraphPage />} /></Routes></MemoryRouter>);
    const region = await notice();
    fireEvent.click(await screen.findByRole("button", { name: t("paragraph.edit") }));
    const editor = await screen.findByLabelText(t("paragraph.writePlaceholder"));
    const badge = screen.getByText(t("frozen.badge.autopilot", { date: dateOf("en") }));
    expect(badge.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("show the frozen chapter in the chapter's header and the decision under its scenes", async () => {
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK.id}/chapters/${SLUG}`]}><Routes><Route path="/app/books/:bookId/chapters/:chapterId" element={<ChapterPage />} /></Routes></MemoryRouter>);
    const region = await notice();
    const sceneLink = screen.getByRole("link", { name: "The pier" });
    expect(screen.getByText(t("frozen.badge.autopilot", { date: dateOf("en") }))).toBeInTheDocument();
    expect(sceneLink.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
