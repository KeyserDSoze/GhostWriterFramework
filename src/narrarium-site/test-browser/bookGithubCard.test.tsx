import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { installFakeGitHubApi, type FakeApiOptions } from "./helpers/fakeGitHubApi";
import { clearRepositoryListingCache } from "@/github/useRepositoryListing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined), syncStatus: "idle" }) }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/repository/repositoryService")>()), attachLocalBookToGitHub: vi.fn() }));
vi.mock("@/github/bookRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/github/bookRepository")>()),
  preflightBookRepository: vi.fn(async () => ({ login: "ada", tokenKind: "classic", scopes: ["repo"], organizations: ["acme"], canCreate: "yes", canWriteWorkflows: "no", issues: ["no-workflow-scope"] })),
  deleteEmptyBookRepository: vi.fn(async () => undefined),
}));

import i18n from "@/i18n";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { attachLocalBookToGitHub } from "@/repository/repositoryService";
import { BookRepositoryError, deleteEmptyBookRepository, PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// The card that connects a local book to GitHub speaks the language of the app from its catalogue, its fields named in it (they were in
// English only), whatever language the settings of the book say.

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T10:00:00.000Z" };

function Where() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}

function page() {
  return render(
    <MemoryRouter initialEntries={["/app/books/book-1/settings"]}>
      <Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /><Route path="/app/books/:bookId" element={<p>The book</p>} /></Routes>
      <Where />
    </MemoryRouter>,
  );
}

/** GitHub, for the picker: by default it reaches no repository of this person, so the card starts on the creation of a new one. */
const github = (options: FakeApiOptions = {}) => installFakeGitHubApi({ repositories: [], ...options });

beforeEach(() => { github(); clearRepositoryListingCache(); });

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the card that connects a local book to GitHub", () => {
  it.each([
    ["en", "Connect this book to GitHub", "Owner of the repository", "Name of the new repository", "Create or connect the repository"],
    ["it", "Collega il libro a GitHub", "Proprietario della repository", "Nome del nuovo repository", "Crea o collega la repository"],
  ])("speaks %s", async (language, title, owner, repository, submit) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test", books: [BOOK], ui: { ...DEFAULT_SETTINGS.ui, language: language === "it" ? "en" : "it" } } });
    useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
    page();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(await screen.findByLabelText(owner)).toBeInTheDocument();
    expect(screen.getByLabelText(repository)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: submit })).toBeInTheDocument();
  });
});

const RESULT = { id: 1, owner: "ada", repo: "the-glass-harbor", defaultBranch: "main", htmlUrl: "https://github.com/ada/the-glass-harbor", private: true, committed: { files: 150, bytes: 420_000 }, workflow: "not-allowed" as const, pages: "skipped" as const, warnings: [], headSha: "a".repeat(40), shas: {}, firstCommitPath: "direct" as const, createdRepository: true, pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: "name: x\n" }] };

describe("connecting the book", () => {
  beforeEach(() => {
    vi.mocked(attachLocalBookToGitHub).mockReset();
    vi.mocked(deleteEmptyBookRepository).mockClear();
  });

  function arrange() {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test", books: [BOOK] } });
    useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
    page();
  }

  it("tells what the token lacks before anything is sent, then passes the owner, the visibility and Pages to the service", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "acme", repo: "the-glass-harbor", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: RESULT });
    arrange();
    expect(await screen.findByText(/It has no «workflow» scope/)).toBeInTheDocument();
    await screen.findByRole("option", { name: "acme (organization)" });
    fireEvent.change(screen.getByLabelText("Owner of the repository"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    expect(screen.getByRole("checkbox", { name: "Also turn on GitHub Pages" })).toBeChecked();
    fireEvent.change(screen.getByLabelText("Name of the new repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    await waitFor(() => expect(attachLocalBookToGitHub).toHaveBeenCalledOnce());
    expect(vi.mocked(attachLocalBookToGitHub).mock.calls[0][0]).toMatchObject({ token: "ghp_test", owner: "acme", repo: "the-glass-harbor", visibility: "public", pages: "enable", overwriteExisting: false });
  });

  it("shows the result when the book is on GitHub, with the focus on it and the manual steps, and opens the book from its button", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "ada", repo: "the-glass-harbor", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: RESULT });
    arrange();
    fireEvent.change(await screen.findByLabelText("Name of the new repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    const region = await screen.findByRole("region", { name: "The repository is ready" });
    expect(region).toHaveFocus();
    // The card is gone (the book is no longer on this device only) and the result is not.
    expect(screen.queryByText("Connect this book to GitHub")).not.toBeInTheDocument();
    expect(screen.getByText(/this token may not write workflow files/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the workflow" })).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.books[0]).toMatchObject({ storageMode: "github", owner: "ada", repo: "the-glass-harbor", activeBranch: "main" });
    expect(screen.getByTestId("location")).toHaveTextContent("/settings");
    fireEvent.click(screen.getByRole("button", { name: "Open the book" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/app\/books\/book-1$/));
  });

  it("says a refusal in words and keeps the book on this device", async () => {
    vi.mocked(attachLocalBookToGitHub).mockRejectedValue(new BookRepositoryError("cannot-create", { status: 403 }));
    arrange();
    fireEvent.change(await screen.findByLabelText("Name of the new repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This token cannot create repositories for");
    expect(screen.getByText("Connect this book to GitHub")).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.books[0].storageMode).toBe("local-only");
  });

  it("offers to send the files again, or to delete the empty repository, when the first commit failed", async () => {
    const empty = { owner: "ada", repo: "the-glass-harbor", htmlUrl: "https://github.com/ada/the-glass-harbor", defaultBranch: "main", created: true };
    vi.mocked(attachLocalBookToGitHub).mockRejectedValueOnce(new BookRepositoryError("first-commit-failed", { reason: "service-unavailable", repository: empty }));
    arrange();
    fireEvent.change(await screen.findByLabelText("Name of the new repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    expect(await screen.findByText("The empty repository is still there")).toBeInTheDocument();
    vi.mocked(attachLocalBookToGitHub).mockResolvedValueOnce({ owner: "ada", repo: "the-glass-harbor", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: { ...RESULT, workflow: "done", pendingWorkflow: [], createdRepository: false } });
    fireEvent.click(screen.getByRole("button", { name: "Send the files again" }));
    expect(await screen.findByRole("region", { name: "The repository is ready" })).toBeInTheDocument();
    expect(attachLocalBookToGitHub).toHaveBeenCalledTimes(2);
    expect(deleteEmptyBookRepository).not.toHaveBeenCalled();
  });

  it("deletes the empty repository with the book's token, only after the confirmation", async () => {
    const empty = { owner: "ada", repo: "the-glass-harbor", htmlUrl: "https://github.com/ada/the-glass-harbor", defaultBranch: "main", created: true };
    vi.mocked(attachLocalBookToGitHub).mockRejectedValue(new BookRepositoryError("first-commit-failed", { reason: "network", repository: empty }));
    arrange();
    fireEvent.change(await screen.findByLabelText("Name of the new repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete the empty repository" }));
    expect(deleteEmptyBookRepository).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(deleteEmptyBookRepository).toHaveBeenCalledWith({ token: "ghp_test", owner: "ada", repo: "the-glass-harbor", defaultBranch: "main" }));
  });

  it("refuses a repository name GitHub would refuse, in words, and does not send it", async () => {
    arrange();
    fireEvent.change(await screen.findByLabelText("Name of the new repository"), { target: { value: "my book" } });
    expect(screen.getByText("Use only letters, digits, dots, dashes and underscores (no spaces).")).toBeInTheDocument();
    expect(screen.getByLabelText("Name of the new repository")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Create or connect the repository" })).toBeDisabled();
  });
});

describe("connecting the book to a repository that is there", () => {
  beforeEach(() => {
    vi.mocked(attachLocalBookToGitHub).mockReset();
  });

  function arrange(options: FakeApiOptions) {
    github(options);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_test", books: [BOOK] } });
    useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
    page();
  }
  const pickRepository = async (name: string) => {
    const input = await screen.findByRole("combobox", { name: "Search a repository" });
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
  };

  it("starts on the list of the repositories, and the button names what will happen", async () => {
    arrange({ repositories: [{ owner: "ada", name: "giungla", holds: "empty" }] });
    expect(await screen.findByRole("radio", { name: "Connect an existing repository" })).toBeChecked();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name of the new repository")).not.toBeInTheDocument();
    await pickRepository("giungla");
    expect(await screen.findByText("ada/giungla is empty: the book of this device is published into it.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Publish into this repository" })).toBeInTheDocument();
  });

  it("publishes the book of this device into an empty repository, without making a new one and without replacing anything", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "ada", repo: "giungla", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: { ...RESULT, repo: "giungla", workflow: "done", pendingWorkflow: [], createdRepository: false } });
    arrange({ repositories: [{ owner: "ada", name: "giungla", holds: "empty" }] });
    await pickRepository("giungla");
    const button = await screen.findByRole("button", { name: "Publish into this repository" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(attachLocalBookToGitHub).toHaveBeenCalledOnce());
    expect(vi.mocked(attachLocalBookToGitHub).mock.calls[0][0]).toMatchObject({ owner: "ada", repo: "giungla", createRepository: false, overwriteExisting: false, pages: "skip" });
    expect(await screen.findByRole("region", { name: "The repository is ready" })).toBeInTheDocument();
  });

  it("adds a repository that is a Narrarium book as a book of its own: the book of this device stays, nothing is written, nothing is overwritten", async () => {
    arrange({ repositories: [{ owner: "ada", name: "giungla", holds: "book" }] });
    await pickRepository("giungla");
    expect(await screen.findByText(/added as a book of its own; the book on this device stays as it is, and nothing is overwritten/)).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Add the book" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/app\/books\/[0-9a-f-]{36}$/));
    expect(attachLocalBookToGitHub).not.toHaveBeenCalled();
    const books = useSettingsStore.getState().settings.books;
    expect(books).toHaveLength(2);
    expect(books[0]).toMatchObject({ id: "book-1", storageMode: "local-only" });
    expect(books[1]).toMatchObject({ owner: "ada", repo: "giungla", name: "giungla" });
    expect(books[1].storageMode).toBeUndefined();
  });

  it("asks before replacing a repository with other files: the switch is off, nothing is sent, and with it on the replacement is passed to the service", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "ada", repo: "website", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: { ...RESULT, repo: "website", workflow: "done", pendingWorkflow: [], createdRepository: false } });
    arrange({ repositories: [{ owner: "ada", name: "website", holds: "other" }] });
    await pickRepository("website");
    const toggle = await screen.findByRole("switch", { name: "Overwrite existing repository" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("If the repository is not empty, its branch will be replaced by this local book.")).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Publish into this repository" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(attachLocalBookToGitHub).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    const replace = await screen.findByRole("button", { name: "Replace and publish" });
    await waitFor(() => expect(replace).toBeEnabled());
    fireEvent.click(replace);
    await waitFor(() => expect(attachLocalBookToGitHub).toHaveBeenCalledOnce());
    expect(vi.mocked(attachLocalBookToGitHub).mock.calls[0][0]).toMatchObject({ owner: "ada", repo: "website", createRepository: false, overwriteExisting: true });
  });

  it("makes a new repository with the name derived from the title, which stays, or with the one the person chose", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "ada", repo: "mio", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: { ...RESULT, repo: "mio" } });
    arrange({ repositories: [{ owner: "ada", name: "giungla", holds: "empty" }] });
    fireEvent.click(await screen.findByRole("radio", { name: "Create a new repository" }));
    const name = await screen.findByLabelText("Name of the new repository");
    expect(name).toHaveValue("the-glass-harbor");
    fireEvent.change(name, { target: { value: "mio" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    await waitFor(() => expect(attachLocalBookToGitHub).toHaveBeenCalledOnce());
    expect(vi.mocked(attachLocalBookToGitHub).mock.calls[0][0]).toMatchObject({ repo: "mio", createRepository: true, overwriteExisting: false });
  });
});

