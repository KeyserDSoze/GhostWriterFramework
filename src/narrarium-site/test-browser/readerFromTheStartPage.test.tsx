import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseOption, polyfillRadix } from "./helpers/radix";
import { installFakeGitHubApi } from "./helpers/fakeGitHubApi";
import { clearRepositoryListingCache } from "@/github/useRepositoryListing";
import i18n from "@/i18n";
import { AddBookPage } from "@/pages/AddBookPage";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { PAGES_WORKFLOW_PATH, createCompleteBookRepository, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { ReaderProtectionFailed, retryProtectedReader } from "@/readerAccess/creation";

// The page that adds a book, with GitHub Pages on: «public / protected by a password», the first password, and what the result says when the password could or
// could not be put in place. The service of the creation is replaced (readerFromTheStart.test.ts runs the real one against a fake GitHub).

const env = vi.hoisted(() => ({ supports: true }));
vi.mock("@/repository/repositoryService", () => ({ createLocalOnlyBookRepository: vi.fn() }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true) }) }));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => ({}) }));
vi.mock("@/narrarium/bookTemplate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/narrarium/bookTemplate")>();
  return { ...real, loadBookTemplate: vi.fn(async () => (env.supports ? { ...(await real.loadBookTemplate()), files: { ...(await real.loadBookTemplate()).files, ".github/workflows/deploy-reader-pages.yml": { text: "env:\n  P: ${{ vars.READER_PASSWORD_SECRETS }}\n" } } } : { ...(await real.loadBookTemplate()), files: { ...(await real.loadBookTemplate()).files, ".github/workflows/deploy-reader-pages.yml": { text: "name: old\n" } } })) };
});
vi.mock("@/github/bookRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/bookRepository")>()),
  createCompleteBookRepository: vi.fn(),
  deleteEmptyBookRepository: vi.fn(async () => undefined),
  preflightBookRepository: vi.fn(async () => ({ login: "ada", tokenKind: "classic", scopes: ["repo", "workflow"], organizations: [], canCreate: "yes", canWriteWorkflows: "yes", issues: [] })),
}));
vi.mock("@/readerAccess/creation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/readerAccess/creation")>()), retryProtectedReader: vi.fn() }));

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const create = vi.mocked(createCompleteBookRepository);
const retry = vi.mocked(retryProtectedReader);

function made(overrides: Partial<CreateCompleteBookRepositoryResult> = {}): CreateCompleteBookRepositoryResult {
  return { id: 1, owner: "ada", repo: "book-the-glass-harbor", defaultBranch: "main", htmlUrl: "https://github.com/ada/book-the-glass-harbor", private: true, committed: { files: 160, bytes: 430_000 }, workflow: "done", pages: "enabled", warnings: [], headSha: "a".repeat(40), shas: {}, firstCommitPath: "direct", createdRepository: true, pendingWorkflow: [], ...overrides };
}
const held = (error: unknown = new ReaderProtectionFailed({ ok: false, done: ["save"], failed: { step: "secret", failure: { kind: "permission", status: 403, permissions: ["secrets"], fromHeader: true } }, dispatched: false, secretName: "READER_PASSWORD_001" })) => made({ workflow: "held", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: "name: x\n" }], beforeWorkflow: { status: "failed", error } });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/app/books/new"]}>
      <Routes><Route path="/app/books/new" element={<AddBookPage />} /><Route path="/app/books/:bookId" element={<p>The book</p>} /></Routes>
    </MemoryRouter>,
  );
}

async function fill() {
  chooseOption(screen.getAllByRole("combobox")[0], "GitHub");
  fireEvent.change(screen.getByPlaceholderText(t("addBook.bookTitlePlaceholder")), { target: { value: "The Glass Harbor" } });
  await screen.findByRole("heading", { name: t("github.createBook.panel.checklist.title") });
}
const pagesBox = () => screen.getByRole("checkbox", { name: new RegExp(t("github.createBook.panel.pages.label").slice(0, 12)) });
const submit = () => fireEvent.click(screen.getByRole("button", { name: t("addBook.createRepo") }));

beforeAll(() => polyfillRadix());
beforeEach(async () => {
  installFakeGitHubApi({ repositories: [] });
  clearRepositoryListingCache();
  env.supports = true;
  create.mockReset();
  retry.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test" } });
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage("en"); });

describe.each(["en", "it"] as const)("the choice of the reader when a book is made, in %s", (language) => {
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("offers nothing before Pages is chosen, then «protected» (the default) and «public», with a strong first password shown masked", async () => {
    renderPage();
    await fill();
    expect(screen.queryByTestId("reader-choice")).toBeNull();
    fireEvent.click(pagesBox());
    const choice = await screen.findByTestId("reader-choice");
    expect(within(choice).getByRole("radio", { name: t("github.createBook.reader.protected") })).toBeChecked();
    expect(within(choice).getByRole("radio", { name: t("github.createBook.reader.public") })).not.toBeChecked();
    const value = await within(choice).findByLabelText(t("readerAccess.passwordValueFor", { label: t("github.createBook.reader.firstLabel") }));
    expect(value).toHaveTextContent("••••");
    fireEvent.click(within(choice).getByRole("button", { name: t("readerAccess.revealFor", { label: t("github.createBook.reader.firstLabel") }) }));
    expect(value.textContent).toMatch(/^(?:[A-HJ-NP-Za-km-z2-9]{5}-){4}[A-HJ-NP-Za-km-z2-9]{5}$/);
    const first = value.textContent;
    fireEvent.click(within(choice).getByRole("button", { name: t("readerAccess.generate") }));
    await waitFor(() => expect(value.textContent).not.toBe(first));
  });

  it("offers nothing protective while the reader that the book gets cannot honour passwords", async () => {
    env.supports = false;
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    await waitFor(() => expect(screen.getByRole("heading", { name: t("github.createBook.panel.checklist.title") })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("reader-choice")).toBeNull();
    create.mockResolvedValue(made());
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0].pages).toBe("enable");
    expect(create.mock.calls[0][0].beforeWorkflow).toBeUndefined();
  });

  it("gives the creation the step that puts the password in place before the workflow, with a protected reader; none with a public one", async () => {
    create.mockResolvedValue(made({ beforeWorkflow: { status: "done" } }));
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    await screen.findByTestId("reader-choice");
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ pages: "enable" });
    expect(typeof create.mock.calls[0][0].beforeWorkflow).toBe("function");
    const result = await screen.findByTestId("reader-setup");
    expect(within(result).getByText(new RegExp(t("github.createBook.result.reader.setBody").slice(0, 25)))).toBeInTheDocument();
    expect(within(result).queryByRole("alert")).toBeNull();
    expect(result.textContent).not.toMatch(/[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}/);
    cleanup();

    create.mockClear();
    create.mockResolvedValue(made());
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    const again = await screen.findByTestId("reader-choice");
    fireEvent.click(within(again).getByRole("radio", { name: t("github.createBook.reader.public") }));
    expect(within(again).queryByRole("button", { name: t("readerAccess.generate") })).toBeNull();
    submit();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0].beforeWorkflow).toBeUndefined();
    expect(screen.queryByTestId("reader-setup")).toBeNull();
  });

  it("says plainly that nothing is published when the password could not be put in place, names the permission, keeps the password, and offers to try again", async () => {
    create.mockResolvedValue(held());
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    await screen.findByTestId("reader-choice");
    submit();
    const section = await screen.findByTestId("reader-setup");
    const alert = within(section).getByRole("alert");
    expect(alert).toHaveTextContent(t("github.createBook.result.reader.notPublicTitle"));
    expect(alert).toHaveTextContent(/«Secrets»/);
    expect(screen.getByText(t("github.createBook.result.workflow.held"))).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: t("readerAccess.revealFor", { label: t("github.createBook.reader.firstLabel") }) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("github.createBook.result.reader.retry") })).toBeEnabled();
    expect(screen.queryByText(new RegExp(t("github.createBook.manual.workflow.title")))).toBeNull();
  });

  it("finishes the same password and adds the workflow on a retry, and shows the result as done", async () => {
    create.mockResolvedValue(held());
    retry.mockResolvedValue({ ok: true, secretName: "READER_PASSWORD_001" });
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    await screen.findByTestId("reader-choice");
    submit();
    fireEvent.click(await screen.findByRole("button", { name: t("github.createBook.result.reader.retry") }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(retry.mock.calls[0][0]).toMatchObject({ owner: "ada", repo: "book-the-glass-harbor", branch: "main", files: [{ path: PAGES_WORKFLOW_PATH }], password: { label: t("github.createBook.reader.firstLabel") } });
    await waitFor(() => expect(screen.queryByRole("button", { name: t("github.createBook.result.reader.retry") })).toBeNull());
    expect(screen.getByTestId("reader-setup").querySelector('[role="alert"]')).toBeNull();
    expect(screen.getByText(t("github.createBook.result.workflow.done"))).toBeInTheDocument();
  });

  it("keeps saying nothing is public when the retry fails, with what stopped it", async () => {
    create.mockResolvedValue(held());
    retry.mockResolvedValue({ ok: false, stage: "workflow", failure: { kind: "permission", status: 403, permissions: ["workflows"], fromHeader: false }, secretName: "READER_PASSWORD_001" });
    renderPage();
    await fill();
    fireEvent.click(pagesBox());
    await screen.findByTestId("reader-choice");
    submit();
    fireEvent.click(await screen.findByRole("button", { name: t("github.createBook.result.reader.retry") }));
    const alert = await within(await screen.findByTestId("reader-setup")).findByText(t("github.createBook.result.reader.failedWorkflow"));
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/«Workflows»/);
    expect(screen.getByRole("button", { name: t("github.createBook.result.reader.retry") })).toBeEnabled();
  });
});
