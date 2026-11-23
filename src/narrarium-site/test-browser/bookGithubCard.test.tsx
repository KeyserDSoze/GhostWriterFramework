import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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

afterEach(async () => {
  cleanup();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the card that connects a local book to GitHub", () => {
  it.each([
    ["en", "Connect this book to GitHub", "Owner of the repository", "Repository", "Overwrite existing repository", "Create or connect the repository"],
    ["it", "Collega il libro a GitHub", "Proprietario della repository", "Repository", "Sovrascrivi repository esistente", "Crea o collega la repository"],
  ])("speaks %s", async (language, title, owner, repository, overwrite, submit) => {
    await i18n.changeLanguage(language);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], ui: { ...DEFAULT_SETTINGS.ui, language: language === "it" ? "en" : "it" } } });
    useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
    page();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByLabelText(owner)).toBeInTheDocument();
    expect(screen.getByLabelText(repository)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: overwrite })).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    await waitFor(() => expect(attachLocalBookToGitHub).toHaveBeenCalledOnce());
    expect(vi.mocked(attachLocalBookToGitHub).mock.calls[0][0]).toMatchObject({ token: "ghp_test", owner: "acme", repo: "the-glass-harbor", visibility: "public", pages: "enable", overwriteExisting: false });
  });

  it("shows the result when the book is on GitHub, with the focus on it and the manual steps, and opens the book from its button", async () => {
    vi.mocked(attachLocalBookToGitHub).mockResolvedValue({ owner: "ada", repo: "the-glass-harbor", branch: "main", remoteHeadSha: "a".repeat(40), repoId: "r", creation: RESULT });
    arrange();
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "the-glass-harbor" } });
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
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This token cannot create repositories for");
    expect(screen.getByText("Connect this book to GitHub")).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.books[0].storageMode).toBe("local-only");
  });

  it("offers to send the files again, or to delete the empty repository, when the first commit failed", async () => {
    const empty = { owner: "ada", repo: "the-glass-harbor", htmlUrl: "https://github.com/ada/the-glass-harbor", defaultBranch: "main", created: true };
    vi.mocked(attachLocalBookToGitHub).mockRejectedValueOnce(new BookRepositoryError("first-commit-failed", { reason: "service-unavailable", repository: empty }));
    arrange();
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "the-glass-harbor" } });
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
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "the-glass-harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create or connect the repository" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete the empty repository" }));
    expect(deleteEmptyBookRepository).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(deleteEmptyBookRepository).toHaveBeenCalledWith({ token: "ghp_test", owner: "ada", repo: "the-glass-harbor", defaultBranch: "main" }));
  });

  it("refuses a repository name GitHub would refuse, in words, and does not send it", async () => {
    arrange();
    fireEvent.change(await screen.findByLabelText("Repository"), { target: { value: "my book" } });
    expect(screen.getByText("Use only letters, digits, dots, dashes and underscores (no spaces).")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Create or connect the repository" })).toBeDisabled();
  });
});
