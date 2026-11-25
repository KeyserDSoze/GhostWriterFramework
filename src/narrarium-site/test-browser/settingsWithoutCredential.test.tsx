import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true), syncStatus: "idle" }) }));

import i18n from "@/i18n";
import "@/i18n/localFirst";
import "@/i18n/readerAccess";
import "@/i18n/readerUpdate";
import { WorkingBranchCard } from "@/components/book/settings/WorkingBranchCard";
import { ReaderTabContent } from "@/components/book/readerAccess/ReaderTabContent";
import { markGitHubCredentialRejected } from "@/github/remoteAvailability";
import { putLocalRepository } from "@/repository/localRepository";
import { captureRepositoryOperationScope } from "@/repository/repositoryOperationScope";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { blockNetwork, createLinkedBookWithoutCredential, resetLocalWorkspace } from "./helpers/localFirst";
import { optionNames, polyfillRadix } from "./helpers/radix";

// The GitHub tab and the Online reader tab of a GitHub book with no credential on this device, or with one GitHub refused: what needs GitHub says so and
// offers to connect it, what the device has (its branches) is offered, and nothing is sent to GitHub.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const files = [{ path: "book.md", content: "---\ntype: book\nid: book\ntitle: Linked\n---\n\nA linked book.\n" }];

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

/** A second branch of the book with a complete working copy on this device. */
async function branchHere(book: BookEntry, branch: string): Promise<void> {
  await putLocalRepository({ bookId: book.id, repositoryKind: "book", remoteKind: "github", owner: book.owner, repo: book.repo, branch, defaultBranch: "main", remoteHeadSha: "remote-head", clonedAt: new Date().toISOString(), cloneComplete: true, cloneStatus: "complete", expectedFileCount: 0 }, captureRepositoryOperationScope());
}

beforeAll(polyfillRadix);
beforeEach(resetLocalWorkspace);
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each(["en", "it"] as const)("the working branch of a GitHub book without a credential, in %s", (language) => {
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("offers the branches on this device, and says that listing or making GitHub's needs GitHub, with the way to connect it", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    await branchHere(linked.book, "chapter-nine");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [linked.book] } });
    const onActiveBranch = vi.fn();

    render(<MemoryRouter><WorkingBranchCard book={linked.book} activeBranch="main" onActiveBranch={onActiveBranch} /><Where /></MemoryRouter>);

    expect(await screen.findByText(t("localFirst.githubNeededNoCredential"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("bookSettings.loadRemoteBranches") })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: t("bookSettings.createBranch") }), { target: { value: "fresh-start" } });
    expect(screen.getByRole("button", { name: t("bookSettings.createBranch") })).toBeDisabled();
    // Polled, not followed: opening the list to read it changes the page, and a wait that runs again at every change of the page would run
    // again without end before the branches of this device arrive, never letting them arrive.
    await vi.waitFor(() => expect(optionNames(screen.getByRole("combobox", { name: t("bookSettings.activeBranch") }))).toEqual(expect.arrayContaining(["chapter-nine", "main"])));
    fireEvent.click(screen.getByRole("link", { name: t("localFirst.connectGitHub") }));
    expect(screen.getByTestId("where")).toHaveTextContent("/app/settings/github");
    expect(network.requests).toEqual([]);
  });
});

describe("the working branch of a GitHub book", () => {
  it("treats a credential GitHub refused as none: the same words, and no request", async () => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    markGitHubCredentialRejected("ghp_revoked_for_branches");
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ ...linked.book, bookToken: "ghp_revoked_for_branches" }] } });

    render(<MemoryRouter><WorkingBranchCard book={{ ...linked.book, bookToken: "ghp_revoked_for_branches" }} activeBranch="main" onActiveBranch={vi.fn()} /></MemoryRouter>);

    expect(await screen.findByText(t("localFirst.githubNeededNoCredential"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("bookSettings.loadRemoteBranches") })).toBeDisabled();
    expect(network.requests).toEqual([]);
  });

  it("with a credential it can use, lists and makes branches on GitHub as before, and says nothing about connecting", async () => {
    blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    const book = { ...linked.book, bookToken: "ghp_usable_for_branches" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    render(<MemoryRouter><WorkingBranchCard book={book} activeBranch="main" onActiveBranch={vi.fn()} /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: t("bookSettings.loadRemoteBranches") })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: t("bookSettings.createBranch") }), { target: { value: "fresh-start" } });
    expect(screen.getByRole("button", { name: t("bookSettings.createBranch") })).toBeEnabled();
    expect(screen.queryByText(t("localFirst.githubNeededNoCredential"))).toBeNull();
    expect(screen.queryByRole("link", { name: t("localFirst.connectGitHub") })).toBeNull();
  });

  it("offline, says that branches need GitHub, and lists and makes none", async () => {
    blockNetwork();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const linked = await createLinkedBookWithoutCredential({ files });
    const book = { ...linked.book, bookToken: "ghp_usable_offline" };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    render(<MemoryRouter><WorkingBranchCard book={book} activeBranch="main" onActiveBranch={vi.fn()} /></MemoryRouter>);

    expect(await screen.findByText(t("localFirst.branchesOffline"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("bookSettings.loadRemoteBranches") })).toBeDisabled();
  });
});

describe("the Online reader tab of a GitHub book", () => {
  it.each([["no credential", undefined], ["a credential GitHub refused", "ghp_revoked_for_reader"]])("with %s, says the reader cannot be managed from here, and asks GitHub nothing", async (_case, token) => {
    const network = blockNetwork();
    const linked = await createLinkedBookWithoutCredential({ files });
    if (token) markGitHubCredentialRejected(token);
    const book = { ...linked.book, bookToken: token };
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });

    render(<MemoryRouter><ReaderTabContent book={book} /></MemoryRouter>);

    expect(await screen.findByText(t("readerAccess.noToken"))).toHaveAttribute("role", "alert");
    await waitFor(() => expect(screen.queryByText(t("readerUpdate.checking"))).toBeNull());
    expect(network.requests).toEqual([]);
  });
});
