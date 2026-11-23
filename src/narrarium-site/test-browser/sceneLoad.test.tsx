import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, seedBookFiles } from "narrarium-engine/testing";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  read: vi.fn(),
  toast: vi.fn(),
  folder: null as unknown,
}));

vi.mock("@/frozen/chapterFolder", () => ({ readChapterFolder: async () => mocks.folder }));
vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ frozenStatus: async () => ({ mode: "ask", pending: [], warnings: [], changes: [] }) }) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: vi.fn() }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { useSaveStore } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import type { Chapter } from "@/types/book";

// The audit of the scene page (every width) showed «This paragraph is empty.» with Edit and Merge disabled: the book's structure was refreshed
// while the scene loaded, the load was cancelled, and the page never loaded it again.

const t = (key: string) => i18n.t(key) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SLUG = "001-the-key";
const SCENE_PATH = `chapters/${SLUG}/001-the-pier.md`;
const chapter = (): Chapter => ({ slug: SLUG, path: `chapters/${SLUG}`, title: "The key", paragraphs: [{ number: "001", title: "The pier", path: SCENE_PATH }], hasResume: false, hasEvaluation: false }) as Chapter;
const structure = () => ({ title: "The Glass Harbor", chapters: [chapter()], characters: [], locations: [], factions: [], items: [], timelines: [], secrets: [], researchFiles: [], ghostwriters: [] });
const TEXT = "Mira finds the key under the pier.";
const FILE = `---\ntype: paragraph\nid: paragraph:${SLUG}:001-the-pier\nchapter: chapter:${SLUG}\nnumber: 1\ntitle: The pier\n---\n\n${TEXT}\n`;

/** The reads of the scene, as the network does them: they wait until the test lets them through, and a cancelled one fails. */
let waiting: Array<() => void> = [];

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  waiting = [];
  mocks.book = BOOK;
  mocks.structure = structure();
  mocks.folder = { store: new MemoryBookStore({ ...seedBookFiles(), [`chapters/${SLUG}/chapter.md`]: `---\ntype: chapter\nid: chapter:${SLUG}\nnumber: 1\ntitle: The key\n---\n\n# The key\n`, [SCENE_PATH]: FILE }), hasAutopilot: false };
  mocks.toast.mockReset();
  mocks.read.mockReset().mockImplementation((_token: string, _owner: string, _repo: string, _branch: string, _path: string, signal?: AbortSignal) => new Promise((resolve, reject) => {
    const cancelled = () => reject(new DOMException("The read was cancelled.", "AbortError"));
    if (signal?.aborted) return cancelled();
    signal?.addEventListener("abort", cancelled);
    waiting.push(() => resolve({ content: FILE, sha: "sha-1" }));
  }));
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
});

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useSaveStore.setState({ current: null });
  await act(async () => { await i18n.changeLanguage("en"); });
});

describe("the scene page while the structure of the book is refreshed", () => {
  it("loads the scene again when its first load was cancelled, and shows its text", async () => {
    render(<MemoryRouter initialEntries={[`/app/books/${BOOK.id}/chapters/${SLUG}/paragraphs/001`]}><Routes><Route path="/app/books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<ParagraphPage />} /></Routes></MemoryRouter>);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    // The structure comes again from the disk while the scene is read: the same chapters, new objects.
    mocks.structure = structure();
    await act(async () => { useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings } }); });
    await act(async () => { for (const go of waiting.splice(0)) go(); await Promise.resolve(); });
    expect(await screen.findByText(TEXT, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(t("paragraph.empty"))).toBeNull();
    expect(screen.getAllByRole("button", { name: t("paragraph.edit") })[0]).toBeEnabled();
  });
});
