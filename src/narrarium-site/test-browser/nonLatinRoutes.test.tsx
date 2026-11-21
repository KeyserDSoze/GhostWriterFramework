import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  read: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: "main", ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { parseAppRoute } from "@/assistant/context";
import { resolveContextualNavigation } from "@/lib/contextualNavigation";
import { CanonEntityPage } from "@/pages/CanonEntityPage";
import { ChapterPage } from "@/pages/ChapterPage";
import { ParagraphPage } from "@/pages/ParagraphPage";
import { useBooksStore } from "@/store/booksStore";
import { useSaveStore } from "@/store/saveStore";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "Book", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };

const RUSSIAN = "001-глава-первая";
const CHINESE = "002-海辺の朝";
const GENERATED = "003-chapter";

const scene = (chapter: string, number: string, title: string, file: string) => ({ number, title, path: `chapters/${chapter}/${file}.md` });
const chapter = (slug: string, title: string, paragraphs: ReturnType<typeof scene>[]) => ({ slug, path: `chapters/${slug}`, title, hasResume: false, hasEvaluation: false, paragraphs });

const structure = () => ({
  title: "Три книги", language: "ru", ghostwriters: [], ghostwriter: undefined, readerEvaluationFiles: [], researchFiles: [], searchableFiles: [], loadedBranch: "main",
  chapters: [
    chapter(RUSSIAN, "Глава первая", [scene(RUSSIAN, "001", "Тихая гавань", "001-тихая-гавань"), scene(RUSSIAN, "002", "Ночной порт", "002-ночной-порт")]),
    chapter(CHINESE, "海辺の朝", [scene(CHINESE, "001", "朝の港", "001-朝の港")]),
    chapter(GENERATED, "夜の港", [scene(GENERATED, "001", "灯台", "001-scene"), scene(GENERATED, "002", "漁師の家", "002-scene")]),
  ],
}) as unknown as BookStructure;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.structure = structure();
  mocks.read.mockReset().mockImplementation(async (_token: string, _owner: string, _repo: string, _branch: string, path: string) => {
    const title = /chapters\/\d{3}-[^/]+\/chapter\.md$/.test(path) ? mocks.structure && (mocks.structure as BookStructure).chapters.find((entry) => path === `${entry.path}/chapter.md`)?.title : undefined;
    if (title) return { content: `---\ntype: chapter\ntitle: ${title}\n---\n`, sha: `sha-${path}` };
    const sceneOf = (mocks.structure as BookStructure).chapters.flatMap((entry) => entry.paragraphs).find((entry) => entry.path === path);
    if (sceneOf) return { content: `---\ntype: paragraph\ntitle: ${sceneOf.title}\n---\n\nText of ${sceneOf.title}.\n`, sha: `sha-${path}` };
    if (path.startsWith("characters/")) return { content: `---\ntype: character\nname: ${decodeURIComponent(path.slice("characters/".length, -3))}\n---\n\nBody.\n`, sha: `sha-${path}` };
    throw new Error(`unexpected read of ${path}`);
  });
  mocks.toast.mockReset();
  mocks.reload.mockReset();
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  useBooksStore.setState({ structures: {} });
  vi.restoreAllMocks();
});

const encoded = (slug: string) => encodeURIComponent(slug);

describe("the paths of the app read from a page address, for names in any script", () => {
  const BOOK_ID = "5f9c1b2e-0000-4000-8000-000000000001";

  it.each([
    [RUSSIAN], [CHINESE], [GENERATED], ["001-the-gate"],
  ])("finds the chapter %s whether the address is encoded as a browser does or written as it is", (slug) => {
    for (const chapterId of [encoded(slug), slug]) {
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}`)).toEqual({ kind: "chapter", bookId: BOOK_ID, chapterId: slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/`)).toEqual({ kind: "chapter", bookId: BOOK_ID, chapterId: slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/drafts`)).toEqual({ kind: "chapter", bookId: BOOK_ID, chapterId: slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/paragraphs/002`)).toEqual({ kind: "paragraph", bookId: BOOK_ID, chapterId: slug, paragraphNum: "002" });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/paragraphs/002/split`)).toEqual({ kind: "paragraph", bookId: BOOK_ID, chapterId: slug, paragraphNum: "002" });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/paragraphs/002/workspace/script`)).toEqual({ kind: "paragraph-workspace", bookId: BOOK_ID, chapterId: slug, paragraphNum: "002", workspaceKind: "script" });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/workspace/resume`)).toEqual({ kind: "chapter-workspace", bookId: BOOK_ID, chapterId: slug, workspaceKind: "resume" });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/reader-evaluations`)).toEqual({ kind: "chapter-reader-evaluations", bookId: BOOK_ID, chapterId: slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/paragraphs/002/reader-evaluations`)).toEqual({ kind: "paragraph-reader-evaluations", bookId: BOOK_ID, chapterId: slug, paragraphNum: "002" });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/audit`)).toEqual({ kind: "chapter-audit", bookId: BOOK_ID, chapterId: slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/chapters/${chapterId}/paragraphs/002/audit`)).toEqual({ kind: "paragraph-audit", bookId: BOOK_ID, chapterId: slug, paragraphNum: "002" });
    }
  });

  it.each([["李明"], ["иван"], ["character-0crj2m"], ["lyra-vale"]])("finds the canon file %s and the research file named like it", (slug) => {
    for (const part of [encoded(slug), slug]) {
      expect(parseAppRoute(`/app/books/${BOOK_ID}/canon/characters/${part}`)).toEqual({ kind: "canon", bookId: BOOK_ID, section: "characters", slug });
      expect(parseAppRoute(`/app/books/${BOOK_ID}/research/${part}`)).toEqual({ kind: "research-detail", bookId: BOOK_ID, researchSlug: slug });
    }
  });

  it("moves between the scenes of chapters in different scripts, in the view the author is in", () => {
    const book = structure();
    const at = (path: string) => resolveContextualNavigation(book, path, BOOK_ID);

    const last = at(`/app/books/${BOOK_ID}/chapters/${encoded(RUSSIAN)}/paragraphs/002`);
    expect(last.currentFilePaths).toEqual([`chapters/${RUSSIAN}/002-ночной-порт.md`]);
    expect(last.currentLabel).toBe("Ночной порт");
    expect(last.previousHref).toBe(`/app/books/${BOOK_ID}/chapters/${RUSSIAN}/paragraphs/001`);
    expect(last.nextHref).toBe(`/app/books/${BOOK_ID}/chapters/${CHINESE}/paragraphs/001`);

    const chinese = at(`/app/books/${BOOK_ID}/chapters/${encoded(CHINESE)}/paragraphs/001/workspace/draft`);
    expect(chinese.currentFilePaths).toEqual([`drafts/${CHINESE}/001-朝の港.md`]);
    expect(chinese.previousHref).toBe(`/app/books/${BOOK_ID}/chapters/${RUSSIAN}/paragraphs/002/workspace/draft`);
    expect(chinese.nextHref).toBe(`/app/books/${BOOK_ID}/chapters/${GENERATED}/paragraphs/001/workspace/draft`);

    const generated = at(`/app/books/${BOOK_ID}/chapters/${GENERATED}/paragraphs/002/workspace/script`);
    expect(generated.currentFilePaths).toEqual([`scripts/${GENERATED}/002-scene.md`]);
    expect(generated.currentLabel).toBe("漁師の家");

    const chapterView = at(`/app/books/${BOOK_ID}/chapters/${encoded(CHINESE)}/scripts`);
    expect(chapterView.currentLabel).toBe("海辺の朝");
    expect(chapterView.previousHref).toBe(`/app/books/${BOOK_ID}/chapters/${RUSSIAN}/scripts`);
    expect(chapterView.nextHref).toBe(`/app/books/${BOOK_ID}/chapters/${GENERATED}/scripts`);
  });
});

describe("the routes of the app read from a page address, for names in any script", () => {
  function Probe() {
    const { chapterId, paragraphNum } = useParams();
    const location = useLocation();
    return <p data-testid="probe">{`${chapterId}|${paragraphNum}|${location.pathname}`}</p>;
  }

  function At({ path }: { path: string }) {
    return (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/books/:bookId/chapters/:chapterId" element={<ChapterPage />} />
          <Route path="/app/books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<Probe />} />
          <Route path="/app/books/:bookId/canon/:section/:slug" element={<CanonEntityPage />} />
          <Route path="/open/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<ParagraphPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it.each([[RUSSIAN, "Глава первая", "Тихая гавань"], [CHINESE, "海辺の朝", "朝の港"], [GENERATED, "夜の港", "灯台"]])("opens chapter %s with its own title and takes you to its scenes", async (slug, title, firstScene) => {
    for (const address of [`/app/books/book-1/chapters/${encoded(slug)}`, `/app/books/book-1/chapters/${slug}`]) {
      const view = render(<At path={address} />);
      expect(await screen.findByDisplayValue(title)).toBeInTheDocument();
      expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "local", "book-1", "main", `chapters/${slug}/chapter.md`);
      fireEvent.click(screen.getByRole("link", { name: firstScene }));
      expect((await screen.findByTestId("probe")).textContent).toBe(`${slug}|001|/app/books/book-1/chapters/${slug}/paragraphs/001`);
      view.unmount();
    }
  });

  it("reads the encoded address a browser keeps, and keeps it in the history the same way", async () => {
    window.history.pushState({}, "", `/app/books/book-1/chapters/${encoded(RUSSIAN)}`);
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/app/books/:bookId/chapters/:chapterId" element={<ChapterPage />} />
          <Route path="/app/books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<Probe />} />
        </Routes>
      </BrowserRouter>,
    );
    expect(await screen.findByDisplayValue("Глава первая")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Ночной порт" }));
    expect((await screen.findByTestId("probe")).textContent).toBe(`${RUSSIAN}|002|${window.location.pathname}`);
    expect(window.location.pathname).toBe(`/app/books/book-1/chapters/${encoded(RUSSIAN)}/paragraphs/002`);
    expect(parseAppRoute(window.location.pathname)).toEqual({ kind: "paragraph", bookId: "book-1", chapterId: RUSSIAN, paragraphNum: "002" });
    window.history.pushState({}, "", "/");
  });

  it("lists the scenes of a chapter with the title of each, never the file name the app made up", async () => {
    render(<At path={`/app/books/book-1/chapters/${encoded(GENERATED)}`} />);
    await screen.findByDisplayValue("夜の港");
    expect(screen.getByRole("link", { name: "灯台" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "漁師の家" })).toBeInTheDocument();
    expect(screen.queryByText(/^Scene$/)).not.toBeInTheDocument();
  });

  it("explains that the chapter is not there when the address names another one", async () => {
    render(<At path={`/app/books/book-1/chapters/${encoded("009-章")}`} />);
    await waitFor(() => expect(screen.queryByDisplayValue("夜の港")).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "灯台" })).not.toBeInTheDocument();
  });

  it.each([
    [RUSSIAN, "002", "chapters/001-глава-первая/002-ночной-порт.md", "Ночной порт"],
    [CHINESE, "001", "chapters/002-海辺の朝/001-朝の港.md", "朝の港"],
    [GENERATED, "002", "chapters/003-chapter/002-scene.md", "漁師の家"],
  ])("opens scene %s/%s from the file it is in, with its text", async (slug, number, path, title) => {
    render(<At path={`/open/book-1/chapters/${encoded(slug)}/paragraphs/${number}`} />);
    expect(await screen.findByText(`Text of ${title}.`)).toBeInTheDocument();
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "local", "book-1", "main", path, expect.anything());
  });

  it("opens a canon file that the author named with Unicode letters", async () => {
    render(<At path={`/app/books/book-1/canon/characters/${encoded("李明")}`} />);
    expect(await screen.findByDisplayValue("李明")).toBeInTheDocument();
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "local", "book-1", "main", "characters/李明.md");
    expect(screen.getByText("characters/李明.md")).toBeInTheDocument();
  });

  it("opens a canon file made by the app for a name in another script", async () => {
    render(<At path="/app/books/book-1/canon/characters/character-0crj2m" />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(expect.anything(), "local", "book-1", "main", "characters/character-0crj2m.md"));
  });
});
