import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => undefined) }) }));

import i18n from "@/i18n";
import "@/i18n/localFirst";
import { OnboardingDialog } from "@/components/layout/OnboardingDialog";
import { RepositoryStatusDialog } from "@/components/repository/RepositoryStatusDialog";
import { getLocalFile } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { updateFile, createFile } from "@/github/githubClient";
import { resetBookStructureLoadCoordinator, useBookStructure } from "@/hooks/useBookStructure";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { putCleanLocalFile, putLocalRepository } from "@/repository/localRepository";
import { useAuthStore } from "@/store/authStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { blockNetwork, createLinkedBookWithoutCredential, createLocalOnlyBook, resetLocalWorkspace } from "./helpers/localFirst";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

vi.setConfig({ testTimeout: 60_000 });
beforeAll(() => i18n.changeLanguage("en"));
beforeEach(async () => {
  await resetLocalWorkspace();
  mocks.toast.mockReset();
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("the first-run guide", () => {
  it.each(["en", "it"])("opens the pages of the app its steps name, not GitHub (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [] } });
    render(<MemoryRouter initialEntries={["/app/books"]}><OnboardingDialog /><Where /></MemoryRouter>);
    act(() => { window.dispatchEvent(new Event("narrarium:open-onboarding")); });
    const next = async () => fireEvent.click(await screen.findByRole("button", { name: t("onboarding.next") }));
    const step = async (index: number, path: string) => {
      fireEvent.click(await screen.findByRole("button", { name: t(`onboarding.steps.${index}.action`) }));
      expect(screen.getByTestId("where")).toHaveTextContent(new RegExp(`^${path}$`));
    };

    await next();
    await step(1, "/app/books/add");
    await next();
    await step(2, "/app/account-sync");
    await next();
    await next();
    await step(4, "/app/books");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the repository status of a book kept on this device", () => {
  it("shows what the book has, says that GitHub is needed for the rest, and compares and undoes only what the device holds", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    const ideas = await getLocalFile(local.meta.id, "ideas.md", captureRepositoryOperationScope());
    await updateFile(local.token, local.book.owner, local.book.repo, local.branch, "ideas.md", ideas!.currentHash, "# Ideas\n\n- A gate of glass.\n", "Edit ideas");
    await createFile(local.token, local.book.owner, local.book.repo, local.branch, "notes/gate.md", "# The gate\n", "Add a note");
    const settings = { ...DEFAULT_SETTINGS, books: [local.book] };

    render(<RepositoryStatusDialog open onOpenChange={() => undefined} book={local.book} branch={local.branch} settings={settings} />);

    expect(await screen.findByText(t("localFirst.statusLocal"))).toBeInTheDocument();
    expect(screen.getByText(t("localFirst.deviceOnly"))).toBeInTheDocument();
    for (const githubOnly of [t("repoStatus.checkToken"), t("repoStatus.reclone"), t("repoStatus.forceReclone"), t("repoStatus.fetch"), t("repoStatus.pull")]) {
      expect(screen.queryByRole("button", { name: githubOnly })).toBeNull();
    }

    const diffButtons = await screen.findAllByRole("button", { name: t("localFirst.showDiff") });
    expect(diffButtons).toHaveLength(2);
    for (const button of diffButtons) fireEvent.click(button);
    // The previous text of a changed file is not kept on this device: the dialog says so instead of comparing it with an empty file.
    expect(await screen.findByText(t("localFirst.diffNoBase"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: t("localFirst.selectForRestore", { path: "ideas.md" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("localFirst.restoreSelected") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("repoStatus.actionFailed"), description: t("localFirst.restoreNoBase"), variant: "destructive" }));
    expect((await getLocalFile(local.meta.id, "ideas.md", captureRepositoryOperationScope()))?.text).toBe("# Ideas\n\n- A gate of glass.\n");

    mocks.toast.mockReset();
    fireEvent.click(screen.getByRole("checkbox", { name: t("localFirst.selectForRestore", { path: "ideas.md" }) }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("localFirst.selectForRestore", { path: "notes/gate.md" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("localFirst.restoreSelected") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("localFirst.restoredFiles", { count: 1 }) }));
    expect(await getLocalFile(local.meta.id, "notes/gate.md", captureRepositoryOperationScope())).toBeNull();
    expect(network.requests).toEqual([]);
  });
});

describe("a book whose working copy is not on this device", () => {
  it("says that a book kept on another device lives there, without asking GitHub for a personal branch", async () => {
    const network = blockNetwork();
    useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
    resetBookStructureLoadCoordinator();
    // The registry of the books travels with the account; the working copy and its branch stay on the device that made it.
    const elsewhere: BookEntry = { id: "elsewhere", storageMode: "local-only", owner: "", repo: "", name: "Elsewhere", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [elsewhere] } });

    const { result } = renderHook(() => useBookStructure("elsewhere"));

    await waitFor(() => expect(result.current.error?.message).toBe(t("localFirst.localBookOnAnotherDevice")));
    expect(network.requests).toEqual([]);
  });

  it("says that a linked book cannot be downloaded offline", async () => {
    const network = blockNetwork();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    resetBookStructureLoadCoordinator();
    const linked: BookEntry = { id: "linked", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, bookToken: "ghp_token", activeBranch: "main", addedAt: "2026-01-01T00:00:00.000Z" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [linked] } });

    const { result } = renderHook(() => useBookStructure("linked"));

    await waitFor(() => expect(result.current.error?.message).toBe(t("localFirst.notDownloadedOffline")));
    expect(network.requests).toEqual([]);
  });
});

describe("a GitHub book without a credential", () => {
  const files = [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" }, { path: "ideas.md", content: "# Ideas\n" }];
  const signedIn = () => useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });
  /** A copy of the book on another branch than the one it is set to, as after the branch was changed on another device. */
  async function copyOn(book: BookEntry, branch: string) {
    const scope = captureRepositoryOperationScope();
    const meta = await putLocalRepository({ bookId: book.id, repositoryKind: "book", remoteKind: "github", owner: book.owner, repo: book.repo, branch, defaultBranch: "main", remoteHeadSha: "remote-head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete", expectedFileCount: 1 }, scope);
    await putCleanLocalFile({ repoId: meta.id, path: "book.md", kind: "text", text: files[0].content, baseSha: "blob-0", size: files[0].content.length }, scope);
  }

  it("opens from its working copy, with no request to GitHub", async () => {
    const network = blockNetwork();
    resetBookStructureLoadCoordinator();
    const linked = await createLinkedBookWithoutCredential({ files });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [linked.book] } });

    const { result } = renderHook(() => useBookStructure(linked.book.id));

    await waitFor(() => expect(result.current.structure?.loadedBranch).toBe("main"));
    expect(result.current.error).toBeUndefined();
    expect(network.requests).toEqual([]);
  });

  it("keeps working on the copy this device has when the personal branch of the author cannot be made without GitHub", async () => {
    const network = blockNetwork();
    signedIn();
    resetBookStructureLoadCoordinator();
    const book: BookEntry = { id: "personal", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, addedAt: "2026-01-01T00:00:00.000Z" };
    await copyOn(book, "main");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    const { result } = renderHook(() => useBookStructure(book.id));

    await waitFor(() => expect(result.current.structure?.loadedBranch).toBe("main"));
    expect(useBooksStore.getState().workingBranches[book.id]).toBe("main");
    expect(network.requests).toEqual([]);
  });

  it("says which branch it is set to is not on this device, and offers to connect GitHub", async () => {
    const network = blockNetwork();
    resetBookStructureLoadCoordinator();
    const book: BookEntry = { id: "branch", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, activeBranch: "chapter-nine", addedAt: "2026-01-01T00:00:00.000Z" };
    await copyOn(book, "main");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    const { result } = renderHook(() => useBookStructure(book.id));

    await waitFor(() => expect(result.current.error).toMatchObject({ message: t("localFirst.branchNotDownloadedNoCredential", { branch: "chapter-nine" }), connectGitHub: true }));
    expect(network.requests).toEqual([]);
  });

  it("never downloaded on this device, says so plainly and offers to connect GitHub, in both languages", async () => {
    const network = blockNetwork();
    resetBookStructureLoadCoordinator();
    const book: BookEntry = { id: "never", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, activeBranch: "main", addedAt: "2026-01-01T00:00:00.000Z" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    const { result } = renderHook(() => useBookStructure(book.id));

    await waitFor(() => expect(result.current.error).toMatchObject({ message: "This book is not on this device yet: connect GitHub to download it.", connectGitHub: true }));
    render(<MemoryRouter initialEntries={["/app/books/never"]}><BookStructureErrorAlert error={result.current.error!} reload={() => undefined} /><Where /></MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: "Connect GitHub" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/settings/github");
    cleanup();

    await i18n.changeLanguage("it");
    render(<MemoryRouter><BookStructureErrorAlert error={{ ...result.current.error!, message: t("localFirst.notDownloadedNoCredential") }} reload={() => undefined} /></MemoryRouter>);
    expect(screen.getByText("Questo libro non è ancora su questo dispositivo: collega GitHub per scaricarlo.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Collega GitHub" })).toBeInTheDocument();
    expect(network.requests).toEqual([]);
  });

  it("shows its repository status, offers to connect GitHub, and undoes only what the device holds", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    const ideas = await getLocalFile(linked.meta.id, "ideas.md", captureRepositoryOperationScope());
    await updateFile(linked.token, linked.book.owner, linked.book.repo, linked.branch, "ideas.md", ideas!.currentHash, "# Ideas\n\n- A gate.\n", "Edit ideas");
    const settings = { ...DEFAULT_SETTINGS, books: [linked.book] };

    render(<MemoryRouter><RepositoryStatusDialog open onOpenChange={() => undefined} book={linked.book} branch={linked.branch} settings={settings} /></MemoryRouter>);

    expect(await screen.findByText(t("localFirst.statusNoCredential"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("localFirst.connectGitHub") })).toHaveAttribute("href", "/app/settings/github");
    for (const githubOnly of [t("repoStatus.checkToken"), t("repoStatus.reclone"), t("repoStatus.fetch"), t("repoStatus.pull")]) {
      expect(screen.getByRole("button", { name: githubOnly })).toBeDisabled();
    }
    fireEvent.click(await screen.findByRole("checkbox", { name: t("localFirst.selectForRestore", { path: "ideas.md" }) }));
    fireEvent.click(screen.getByRole("button", { name: t("localFirst.restoreSelected") }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: t("repoStatus.actionFailed"), description: t("localFirst.restoreNoCredential"), variant: "destructive" }));
    expect((await getLocalFile(linked.meta.id, "ideas.md", captureRepositoryOperationScope()))?.text).toBe("# Ideas\n\n- A gate.\n");
    expect(network.requests).toEqual([]);
  });
});
