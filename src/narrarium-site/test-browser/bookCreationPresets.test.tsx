import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOPILOT_PRESETS, parseMarkdown, parseOutlineChapterPath, type AutopilotPresetId } from "narrarium-engine";
import { createCompleteBookRepository, type BookRepositoryFile } from "@/github/bookRepository";
import { parseOutlineBrief } from "@/autopilot/outlineBrief";
import { chooseOption, polyfillRadix } from "./helpers/radix";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { AddBookPage } from "@/pages/AddBookPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// «Parti da una misura»: the sizes of a new book, chosen when the book is created and nowhere else. Choosing one writes the brief of the book (its words
// per scene) and one empty chapter entry for each chapter of the size into the new book, and its first configuration starts with the size's review options.

const mocks = vi.hoisted(() => ({
  created: [] as Array<{ kind: "local" | "github"; book?: BookEntry; files?: Array<{ path: string; content: string }> }>,
}));

vi.mock("@/repository/repositoryService", () => ({
  createLocalOnlyBookRepository: vi.fn(async (input: { book: BookEntry; files?: Array<{ path: string; content: string }> }) => {
    mocks.created.push({ kind: "local", book: input.book, files: input.files });
    return {};
  }),
}));
// The repository is made by the creation service (see bookRepository.test.ts for the service itself): this page gives it the files and shows its result.
vi.mock("@/github/bookRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/bookRepository")>()),
  createCompleteBookRepository: vi.fn(async (input: { name: string; files: BookRepositoryFile[] }) => {
    mocks.created.push({ kind: "github", files: input.files.filter((file): file is { path: string; content: string } => "content" in file) });
    return { id: 1, owner: "acme", repo: input.name, defaultBranch: "main", htmlUrl: `https://github.com/acme/${input.name}`, private: true, committed: { files: input.files.length, bytes: 1000 }, workflow: "done", pages: "skipped", warnings: [], headSha: "a".repeat(40), shas: {}, firstCommitPath: "direct", createdRepository: true, pendingWorkflow: [] };
  }),
  preflightBookRepository: vi.fn(async () => ({ login: "acme", tokenKind: "classic", scopes: ["repo", "workflow"], organizations: [], canCreate: "yes", canWriteWorkflows: "yes", issues: [] })),
}));
vi.mock("@/github/useRepositories", () => ({ useRepositories: () => ({ repos: [], loading: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const created = () => mocks.created[mocks.created.length - 1];

function Where() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/app/books/new"]}>
      <Routes>
        <Route path="/app/books/new" element={<AddBookPage />} />
        <Route path="/app/books/:bookId" element={<p>The book</p>} />
      </Routes>
      <Where />
    </MemoryRouter>
  );
}

const sizes = () => screen.getByRole("group", { name: t("autopilot.presets.legend") });
const size = (name: string) => within(sizes()).getByRole("radio", { name }) as HTMLInputElement;
const title = (value: string) => fireEvent.change(screen.getByPlaceholderText(t("addBook.bookTitlePlaceholder")), { target: { value } });
const createLocal = () => fireEvent.click(screen.getByRole("button", { name: /Crea libro locale|Create local book/ }));

beforeAll(async () => {
  polyfillRadix();
  await loadAutopilotTranslations();
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mocks.created.length = 0;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

describe("the sizes of a new book", () => {
  it("are a group of radio buttons on the page that creates a book: none, and the three sizes, each with its name and what it is in numbers", () => {
    render(<Page />);
    expect(sizes()).toBeInTheDocument();
    expect(within(sizes()).getAllByRole("radio")).toHaveLength(AUTOPILOT_PRESETS.length + 1);
    for (const preset of AUTOPILOT_PRESETS) expect(size(t(`autopilot.presets.${preset.id}.name`))).toBeInTheDocument();
    expect(size(t("autopilot.presets.none"))).toBeChecked();
    expect(size(t("autopilot.presets.novella.name"))).not.toBeChecked();
    expect(within(sizes()).getByText(t("autopilot.presets.facts", { chapters: 12, words: "1,400" }))).toBeInTheDocument();
  });

  it("are in Italian with the names of the sizes of the page", async () => {
    await i18n.changeLanguage("it");
    render(<Page />);
    expect(within(screen.getByRole("group", { name: "Parti da una misura" })).getByRole("radio", { name: "Romanzo breve" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Parti da una misura" })).getByRole("radio", { name: "Bozza di romanzo" })).toBeInTheDocument();
  });

  it.each<AutopilotPresetId>(["story", "novella", "novel-draft"])("created with «%s», a local book starts with the brief of that size and one empty entry for each of its chapters", async (id) => {
    render(<Page />);
    fireEvent.click(size(t(`autopilot.presets.${id}.name`)));
    title("The Glass Harbor");
    createLocal();
    await waitFor(() => expect(mocks.created).toHaveLength(1));
    const preset = AUTOPILOT_PRESETS.find((entry) => entry.id === id)!;
    const files = created().files!;
    const brief = files.find((file) => file.path === "outline/_brief.md")!;
    expect(parseOutlineBrief(brief.content).brief.wordsPerScene).toBe(preset.wordsPerScene);
    const entries = files.filter((file) => parseOutlineChapterPath(file.path));
    expect(entries.map((file) => parseOutlineChapterPath(file.path)!.number)).toEqual(Array.from({ length: preset.chapters }, (_, index) => index + 1));
    for (const entry of entries) {
      const document = parseMarkdown(entry.content);
      expect(document.frontmatter.title, entry.path).toBeUndefined();
      expect(document.body.trim(), entry.path).toBe("");
    }
    expect(created().book?.startPreset).toBe(id);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/app/books/"));
  });

  it("created with none, a book starts with nothing of a size: no brief, no entries, and no size remembered", async () => {
    render(<Page />);
    title("The Glass Harbor");
    createLocal();
    await waitFor(() => expect(mocks.created).toHaveLength(1));
    expect(created().files).toBeUndefined();
    expect(created().book?.startPreset).toBeUndefined();
  });

  it("created on GitHub, the same size goes into the first commit of the new repository, with the files of the framework book around it", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "github_pat_test" } });
    render(<Page />);
    chooseOption(screen.getAllByRole("combobox")[0], "GitHub");
    fireEvent.click(size(t("autopilot.presets.story.name")));
    title("The Glass Harbor");
    fireEvent.click(screen.getByRole("button", { name: t("addBook.createRepo") }));
    await waitFor(() => expect(mocks.created).toHaveLength(1));
    expect(created().kind).toBe("github");
    expect((created().files ?? []).filter((file) => parseOutlineChapterPath(file.path))).toHaveLength(AUTOPILOT_PRESETS[0].chapters);
    const paths = (created().files ?? []).map((file) => file.path);
    for (const path of ["book.md", "outline/_brief.md", "reader/package.json", ".github/workflows/deploy-reader-pages.yml", ".github/copilot-instructions.md", "opencode.jsonc"]) expect(paths, path).toContain(path);
    expect(vi.mocked(createCompleteBookRepository)).toHaveBeenCalledWith(expect.objectContaining({ token: "github_pat_test", name: "book-the-glass-harbor", visibility: "private", existing: "error", pages: "skip" }));
    expect(useSettingsStore.getState().settings.books[useSettingsStore.getState().settings.books.length - 1]?.startPreset).toBe("story");
    // The result stays on the screen until the user opens the book: what could not be done is on it.
    expect(await screen.findByRole("heading", { name: t("github.createBook.result.title") })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/books/new");
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.result.openBook") }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/app\/books\/[0-9a-f-]{36}$/));
  });

  it("are one choice at a time: choosing a size leaves the others unchosen", () => {
    render(<Page />);
    const none = size(t("autopilot.presets.none"));
    none.focus();
    fireEvent.click(size(t("autopilot.presets.story.name")));
    expect(size(t("autopilot.presets.story.name"))).toBeChecked();
    expect(none).not.toBeChecked();
  });
});

