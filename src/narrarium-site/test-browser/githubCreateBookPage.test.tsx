import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseOption, polyfillRadix } from "./helpers/radix";
import i18n from "@/i18n";
import { AddBookPage } from "@/pages/AddBookPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BookRepositoryError, PAGES_WORKFLOW_PATH, createCompleteBookRepository, deleteEmptyBookRepository, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";

// The page that adds a book, on GitHub: what it asks (owner, visibility, Pages), what it tells while it works, and what it shows when the repository
// is made, half made or refused. The service is replaced (see bookRepository.test.ts for it); the files it is given are the real ones of the template.

vi.mock("@/repository/repositoryService", () => ({ createLocalOnlyBookRepository: vi.fn() }));
vi.mock("@/github/useRepositories", () => ({ useRepositories: () => ({ repos: [], loading: false, error: null }) }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/github/bookRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/bookRepository")>()),
  createCompleteBookRepository: vi.fn(),
  deleteEmptyBookRepository: vi.fn(async () => undefined),
  preflightBookRepository: vi.fn(async () => ({ login: "ada", tokenKind: "classic", scopes: ["repo", "workflow"], organizations: ["acme"], canCreate: "yes", canWriteWorkflows: "yes", issues: [] })),
}));

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const create = vi.mocked(createCompleteBookRepository);

function made(overrides: Partial<CreateCompleteBookRepositoryResult> = {}): CreateCompleteBookRepositoryResult {
  return { id: 1, owner: "ada", repo: "book-the-glass-harbor", defaultBranch: "main", htmlUrl: "https://github.com/ada/book-the-glass-harbor", private: true, committed: { files: 160, bytes: 430_000 }, workflow: "done", pages: "skipped", warnings: [], headSha: "a".repeat(40), shas: {}, firstCommitPath: "direct", createdRepository: true, pendingWorkflow: [], ...overrides };
}

function Where() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/books/new"]}>
      <Routes><Route path="/app/books/new" element={<AddBookPage />} /><Route path="/app/books/:bookId" element={<p>The book</p>} /></Routes>
      <Where />
    </MemoryRouter>,
  );
}

async function fill(title = "The Glass Harbor") {
  chooseOption(screen.getAllByRole("combobox")[0], "GitHub");
  fireEvent.change(screen.getByPlaceholderText(t("addBook.bookTitlePlaceholder")), { target: { value: title } });
  await screen.findByRole("option", { name: "acme (organization)" });
}
const submit = () => fireEvent.click(screen.getByRole("button", { name: t("addBook.createRepo") }));

beforeAll(() => polyfillRadix());
beforeEach(async () => {
  await i18n.changeLanguage("en");
  create.mockReset();
  vi.mocked(deleteEmptyBookRepository).mockClear();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test" } });
});
afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

describe("creating a book on GitHub from the page that adds one", () => {
  it("asks for the owner, the visibility and Pages, with the checklist, and gives the service what was chosen and the files of a complete book", async () => {
    create.mockResolvedValue(made({ owner: "acme" }));
    renderPage();
    await fill();
    expect(screen.getByRole("heading", { name: t("github.createBook.panel.checklist.title") })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("github.createBook.panel.owner.label")), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({ token: "ghp_test", owner: "acme", name: "book-the-glass-harbor", visibility: "public", pages: "enable", existing: "error", description: "Narrarium book: The Glass Harbor" });
    const paths = input.files.map((file) => file.path);
    expect(paths.length).toBeGreaterThan(130);
    for (const path of ["book.md", "reader/package.json", PAGES_WORKFLOW_PATH, ".github/copilot-instructions.md", ".opencode/commands/resume-book.md", ".vscode/mcp.json", "scripts/sync-script-ledger.mjs"]) expect(paths, path).toContain(path);
    const readerPackage = input.files.find((file) => file.path === "reader/package.json");
    expect(readerPackage && "content" in readerPackage && JSON.parse(readerPackage.content)).toMatchObject({ name: "the-glass-harbor-reader", dependencies: { narrarium: expect.stringMatching(/^\^\d+\.\d+\.\d+$/) } });
    const book = input.files.find((file) => file.path === "book.md");
    expect(book && "content" in book && book.content).toContain("title: The Glass Harbor");
    const entry = useSettingsStore.getState().settings.books[useSettingsStore.getState().settings.books.length - 1];
    expect(entry).toMatchObject({ owner: "acme", repo: "book-the-glass-harbor", activeBranch: "main", name: "The Glass Harbor" });
  });

  it("says what it is doing while it works, in one polite line, and keeps the form from being sent twice", async () => {
    let finish!: (value: CreateCompleteBookRepositoryResult) => void;
    create.mockImplementation((input) => new Promise((resolve) => {
      finish = resolve;
      input.onProgress?.({ step: "first-commit", chunk: 2, chunks: 3 });
    }));
    renderPage();
    await fill();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const live = screen.getAllByRole("status").find((node) => node.textContent?.includes("part 2 of 3"))!;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: t("addBook.creatingRepo") })).toBeDisabled();
    expect(screen.getByLabelText(t("github.createBook.panel.owner.label"))).toBeDisabled();
    finish(made());
    expect(await screen.findByRole("region", { name: t("github.createBook.result.title") })).toHaveFocus();
  });

  it("shows the result, not the book, when the repository is made, and opens the book from its button", async () => {
    create.mockResolvedValue(made({ workflow: "not-allowed", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: "name: x\n" }] }));
    renderPage();
    await fill();
    submit();
    const region = await screen.findByRole("region", { name: t("github.createBook.result.title") });
    expect(within(region).getByText(/this token may not write workflow files/)).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/app/books/new");
    expect(screen.queryByRole("button", { name: t("addBook.createRepo") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.result.openBook") }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/app\/books\/[0-9a-f-]{36}$/));
  });

  it("says a refusal in words and leaves the form as it was, with the book not added", async () => {
    create.mockRejectedValue(new BookRepositoryError("cannot-create", { status: 403 }));
    renderPage();
    await fill();
    const before = useSettingsStore.getState().settings.books.length;
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("This token cannot create repositories");
    expect(screen.getByRole("button", { name: t("addBook.createRepo") })).toBeEnabled();
    expect(useSettingsStore.getState().settings.books).toHaveLength(before);
  });

  it("says «name taken» as the name's own problem, and a bad name before sending", async () => {
    create.mockRejectedValue(new BookRepositoryError("name-taken", { status: 422 }));
    renderPage();
    await fill();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("A repository named «book-the-glass-harbor» already exists in");
    fireEvent.change(screen.getByPlaceholderText("book-my-story"), { target: { value: "my book" } });
    expect(screen.getByText(t("github.createBook.panel.nameProblem.characters"))).toBeInTheDocument();
    expect(screen.getByPlaceholderText("book-my-story")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: t("addBook.createRepo") })).toBeDisabled();
  });

  it("when the first commit failed, says the repository exists and is empty, and sends the files again into it on a retry", async () => {
    const empty = { owner: "ada", repo: "book-the-glass-harbor", htmlUrl: "https://github.com/ada/book-the-glass-harbor", defaultBranch: "main", created: true };
    create.mockRejectedValueOnce(new BookRepositoryError("first-commit-failed", { reason: "service-unavailable", repository: empty }));
    renderPage();
    await fill();
    submit();
    expect(await screen.findByText(t("github.createBook.recover.title"))).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("It is empty for now");
    expect(useSettingsStore.getState().settings.books.some((book) => book.repo === "book-the-glass-harbor")).toBe(false);
    create.mockResolvedValueOnce(made({ createdRepository: false }));
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.retry") }));
    expect(await screen.findByRole("region", { name: t("github.createBook.result.title") })).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({ existing: "empty", name: "book-the-glass-harbor" });
  });

  it("deletes the empty repository only when the user confirms, with the token of the page", async () => {
    const empty = { owner: "ada", repo: "book-the-glass-harbor", htmlUrl: "https://github.com/ada/book-the-glass-harbor", defaultBranch: "main", created: true };
    create.mockRejectedValue(new BookRepositoryError("first-commit-failed", { reason: "network", repository: empty }));
    renderPage();
    await fill();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: t("github.createBook.recover.delete") }));
    expect(deleteEmptyBookRepository).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.confirmYes") }));
    await waitFor(() => expect(deleteEmptyBookRepository).toHaveBeenCalledWith({ token: "ghp_test", owner: "ada", repo: "book-the-glass-harbor", defaultBranch: "main" }));
  });

  it("makes a repository for the user's own account when no owner is chosen", async () => {
    create.mockResolvedValue(made());
    renderPage();
    await fill();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0].owner).toBeUndefined();
    expect(create.mock.calls[0][0]).toMatchObject({ visibility: "private", pages: "skip" });
  });

  it("is in Italian from the form to the result", async () => {
    await i18n.changeLanguage("it");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test", ui: { ...DEFAULT_SETTINGS.ui, language: "it" } } });
    create.mockResolvedValue(made({ workflow: "not-allowed", pages: "manual", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: "name: x\n" }] }));
    renderPage();
    chooseOption(screen.getAllByRole("combobox")[0], "GitHub");
    fireEvent.change(screen.getByPlaceholderText(t("addBook.bookTitlePlaceholder")), { target: { value: "Il porto di vetro" } });
    await screen.findByRole("option", { name: "acme (organizzazione)" });
    expect(screen.getByRole("heading", { name: "Cosa verrà creato" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("addBook.createRepo") }));
    const region = await screen.findByRole("region", { name: "La repository è pronta" });
    expect(within(region).getByText(/questo token non può scrivere i file dei workflow/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Copia il workflow" })).toBeInTheDocument();
    expect(create.mock.calls[0][0].files.find((file) => file.path === "book.md")).toMatchObject({ content: expect.stringContaining("language: it") });
  });
});
