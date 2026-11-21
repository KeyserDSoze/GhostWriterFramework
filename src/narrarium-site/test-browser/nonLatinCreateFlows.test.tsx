import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  book: null as unknown,
  structure: null as unknown,
  branch: "main",
  read: vi.fn(),
  createFile: vi.fn(),
  capture: vi.fn(),
  commit: vi.fn(),
  toast: vi.fn(),
  reload: vi.fn(),
  loadPersonas: vi.fn(),
  savePersona: vi.fn(),
}));

vi.mock("@/hooks/useBookStructure", () => ({ useBookStructure: () => ({ book: mocks.book, structure: mocks.structure, loading: false, error: undefined, reload: mocks.reload }) }));
vi.mock("@/github/useWorkingBranch", () => ({ useWorkingBranch: () => ({ branch: mocks.branch, ready: true, ensuring: false, error: null }) }));
vi.mock("@/github/githubClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/github/githubClient")>()), readFileWithSha: mocks.read, createFile: mocks.createFile }));
vi.mock("@/assistant/immediateMutation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/assistant/immediateMutation")>()), captureImmediateMutation: mocks.capture, commitImmediateMutation: mocks.commit, commitImmediateMutations: vi.fn() }));
vi.mock("@/narrarium/readerEvaluations", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/narrarium/readerEvaluations")>()), loadReaderPersonas: mocks.loadPersonas, saveReaderPersona: mocks.savePersona }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import { slugCode, slugify } from "narrarium/slug";
import i18n from "@/i18n";
import { ChapterPage } from "@/pages/ChapterPage";
import { GhostwritersPage } from "@/pages/GhostwritersPage";
import { ReaderPersonasPage } from "@/pages/ReaderPersonasPage";
import { emptyGhostwriter, serializeGhostwriter } from "@/narrarium/ghostwriter";
import { builtinReaderPersonas } from "@/narrarium/readerPersona";
import { useBooksStore } from "@/store/booksStore";
import { useSaveStore } from "@/store/saveStore";
import type { BookEntry } from "@/types/settings";

// Each of these renders a whole page several times; a busy machine needs more than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "Book", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const NAMES = {
  Russian: { name: "Тихая гавань", slug: "tikhaya-gavan" },
  Greek: { name: "Η μικρή πόλη", slug: "i-mikri-poli" },
  Chinese: { name: "李明", slug: `-${slugCode("李明")}` },
  Japanese: { name: "海辺の朝", slug: `-${slugCode("海辺の朝")}` },
  Arabic: { name: "الميناء", slug: `-${slugCode("الميناء")}` },
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mocks.book = { ...BOOK };
  mocks.branch = "main";
  mocks.read.mockReset();
  mocks.createFile.mockReset().mockResolvedValue("new-sha");
  mocks.capture.mockReset().mockImplementation(async (input: { path: string }) => ({ path: input.path, content: null, sha: "sha", hash: "hash", remoteHeadSha: "head" }));
  mocks.commit.mockReset().mockResolvedValue("commit");
  mocks.toast.mockReset();
  mocks.reload.mockReset();
  mocks.loadPersonas.mockReset().mockResolvedValue(builtinReaderPersonas("en"));
  mocks.savePersona.mockReset().mockImplementation(async (input: { profile: { slug: string } }) => `personas/${input.profile.slug}.md`);
});

afterEach(() => {
  cleanup();
  useSaveStore.setState({ current: null });
  useBooksStore.setState({ structures: {} });
  vi.restoreAllMocks();
});

describe("creating a ghostwriter whose name is in any script", () => {
  const structure = () => ({ title: "Book", language: "en", chapters: [], ghostwriters: [{ slug: "night-owl", path: "ghostwriters/night-owl.md", name: "Night Owl" }], ghostwriter: "night-owl", searchableFiles: [], loadedBranch: "main" });

  function Page() {
    return (
      <MemoryRouter initialEntries={["/app/books/book-1/ghostwriters"]}>
        <Routes><Route path="/app/books/:bookId/ghostwriters" element={<GhostwritersPage />} /></Routes>
      </MemoryRouter>
    );
  }

  async function createWithName(name: string): Promise<{ path: string; content: string }> {
    mocks.capture.mockClear();
    mocks.commit.mockClear();
    mocks.read.mockImplementation(async () => ({ content: serializeGhostwriter({ slug: "night-owl", ...emptyGhostwriter("Night Owl") }), sha: "sha" }));
    const view = render(<Page />);
    await screen.findByDisplayValue("Night Owl");
    fireEvent.click(screen.getByRole("button", { name: t("ghostwriters.new") }));
    fireEvent.change(screen.getByPlaceholderText(t("ghostwriters.namePlaceholder")), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: t("common.add") }));
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
    const { path } = mocks.capture.mock.calls.map(([input]) => input as { path: string }).find((input) => input.path.startsWith("ghostwriters/") && input.path !== "ghostwriters/night-owl.md")!;
    const { content } = mocks.commit.mock.calls[0][0] as { content: string };
    view.unmount();
    return { path, content };
  }

  beforeEach(() => {
    mocks.structure = structure();
  });

  it("saves it in a file with a name the core accepts, a different one for each name, and keeps the real name inside", async () => {
    const paths = new Set<string>();
    for (const [script, { name, slug }] of Object.entries(NAMES)) {
      const { path, content } = await createWithName(name);
      const fileSlug = path.slice("ghostwriters/".length, -".md".length);
      expect(path, script).toMatch(/^ghostwriters\/[a-z0-9]+(-[a-z0-9]+)*\.md$/);
      expect(slugify(fileSlug), `${script}: the core refuses a ghostwriter whose slug is not already a slug`).toBe(fileSlug);
      expect(fileSlug.endsWith(slug), script).toBe(true);
      expect(content, script).toContain(`id: ghostwriter:${fileSlug}`);
      expect(content, script).toContain(`name: ${name}`);
      paths.add(path);
    }
    expect(paths.size).toBe(Object.keys(NAMES).length);
  });

  it("always gives the same name the same file", async () => {
    for (const name of ["李明", "Тихая гавань"]) expect((await createWithName(name)).path, name).toBe((await createWithName(name)).path);
    expect((await createWithName("李明")).path).toBe(`ghostwriters/ghostwriter-${slugCode("李明")}.md`);
  });

  it("keeps the file names of Latin names", async () => {
    expect((await createWithName("Moon Walker")).path).toBe("ghostwriters/moon-walker.md");
    expect((await createWithName("Città di Sale")).path).toBe("ghostwriters/citta-di-sale.md");
    expect((await createWithName("José Smith")).path).toBe("ghostwriters/jose-smith.md");
  });
});

describe("creating a simulated reader whose name is in any script", () => {
  const structure = () => ({ title: "Book", language: "en", chapters: [], ghostwriters: [], readerPersonas: [], readerEvaluationFiles: [], auditFiles: [], searchableFiles: [], loadedBranch: "main" });

  function Page() {
    return (
      <MemoryRouter initialEntries={["/app/books/book-1/simulated-readers"]}>
        <Routes><Route path="/app/books/:bookId/simulated-readers" element={<ReaderPersonasPage />} /></Routes>
      </MemoryRouter>
    );
  }

  async function saveWithName(name: string): Promise<{ slug: string; path: string }> {
    mocks.savePersona.mockClear();
    const view = render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: t("readerPersonas.new") }));
    const nameInput = (await screen.findByText(t("readerPersonas.name"), { selector: "label" })).parentElement!.querySelector("input")!;
    fireEvent.change(nameInput, { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: t("common.save") }));
    await waitFor(() => expect(mocks.savePersona).toHaveBeenCalledTimes(1));
    const { profile } = mocks.savePersona.mock.calls[0][0] as { profile: { slug: string; name: string } };
    expect(profile.name).toBe(name);
    view.unmount();
    return { slug: profile.slug, path: `personas/${profile.slug}.md` };
  }

  beforeEach(() => {
    mocks.structure = structure();
  });

  it("saves it in a file with a readable name, a different one for each name, whatever the script", async () => {
    const slugs = new Set<string>();
    for (const [script, { name, slug }] of Object.entries(NAMES)) {
      const saved = await saveWithName(name);
      expect(saved.slug, script).toMatch(SLUG);
      expect(saved.slug.endsWith(slug), script).toBe(true);
      expect(slugify(saved.slug), `${script}: a plain slug`).toBe(saved.slug);
      slugs.add(saved.slug);
    }
    expect(slugs.size).toBe(Object.keys(NAMES).length);
  });

  it("always gives the same name the same file", async () => {
    for (const name of ["李明", "Тихая гавань"]) expect((await saveWithName(name)).slug, name).toBe((await saveWithName(name)).slug);
    expect((await saveWithName("李明")).slug).toBe(`reader-${slugCode("李明")}`);
    expect((await saveWithName("Тихая читательница")).slug).toBe("tikhaya-chitatelnitsa");
  });

  it("keeps the file names of Latin names", async () => {
    expect((await saveWithName("Night Reader")).slug).toBe("night-reader");
    expect((await saveWithName("Lettore di Città")).slug).toBe("lettore-di-citta");
    expect((await saveWithName("José Smith")).slug).toBe("jose-smith");
  });
});

describe("adding a scene with a title in any script", () => {
  const paragraph = (number: string, title: string, slug: string) => ({ number, title, path: `chapters/001-chapter/${number}-${slug}.md` });
  const structure = () => ({
    title: "Book", language: "en", ghostwriters: [], ghostwriter: undefined, readerEvaluationFiles: [], researchFiles: [], searchableFiles: [], loadedBranch: "main",
    chapters: [{ slug: "001-chapter", path: "chapters/001-chapter", title: "海辺の朝", hasResume: false, hasEvaluation: false, paragraphs: [paragraph("001", "朝の港", "scene")] }],
  });

  function Page() {
    return (
      <MemoryRouter initialEntries={["/app/books/book-1/chapters/001-chapter"]}>
        <Routes>
          <Route path="/app/books/:bookId/chapters/:chapterId" element={<ChapterPage />} />
          <Route path="/app/books/:bookId/chapters/:chapterId/paragraphs/:paragraphNum" element={<p>opened</p>} />
        </Routes>
      </MemoryRouter>
    );
  }

  async function addScene(title: string): Promise<{ path: string; content: string; listed: { number: string; title: string; path: string } }> {
    mocks.createFile.mockClear();
    mocks.structure = structure();
    useBooksStore.setState({ structures: { "book-1": mocks.structure as never } });
    mocks.read.mockResolvedValue({ content: "---\ntype: chapter\ntitle: 海辺の朝\n---\n", sha: "chapter-sha" });
    const view = render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: t("chapter.addParagraph") }));
    fireEvent.change(screen.getByPlaceholderText(t("chapter.paragraphPlaceholder")), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: t("common.add") }));
    await waitFor(() => expect(mocks.createFile).toHaveBeenCalledTimes(1));
    await screen.findByText("opened");
    const [, , , , path, content] = mocks.createFile.mock.calls[0] as string[];
    const scenes = useBooksStore.getState().structures["book-1"].chapters[0].paragraphs;
    const listed = scenes[scenes.length - 1];
    view.unmount();
    return { path, content, listed };
  }

  it("never saves the scene in an invisible or unreadable file", async () => {
    const files: string[] = [];
    for (const [script, { name }] of Object.entries(NAMES)) {
      const { path, content, listed } = await addScene(name);
      expect(path, script).toMatch(/^chapters\/001-chapter\/002-[a-z0-9]+(-[a-z0-9]+)*\.md$/);
      const slug = path.slice("chapters/001-chapter/".length, -".md".length);
      expect(content, script).toContain(`id: paragraph:001-chapter:${slug}`);
      expect(content, script).toContain(`title: ${name}`);
      expect(listed, `${script}: the list shows the title the author typed`).toEqual({ number: "002", title: name, path });
      files.push(path);
    }
    expect(files).toContain("chapters/001-chapter/002-tikhaya-gavan.md");
    expect(files).toContain("chapters/001-chapter/002-scene.md");
  });

  it("names the file the way every other part of the app names a scene", async () => {
    expect((await addScene("李明")).path).toBe("chapters/001-chapter/002-scene.md");
    expect((await addScene("???")).path).toBe("chapters/001-chapter/002-scene.md");
  });

  it("keeps the file names of Latin titles", async () => {
    expect((await addScene("The Arrival")).path).toBe("chapters/001-chapter/002-the-arrival.md");
    expect((await addScene("Città di sale")).path).toBe("chapters/001-chapter/002-citta-di-sale.md");
    expect((await addScene("Don't Stop")).path).toBe("chapters/001-chapter/002-don-t-stop.md");
  });
});
