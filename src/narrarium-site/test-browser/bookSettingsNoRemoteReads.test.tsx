import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

const env = vi.hoisted(() => ({ octokit: null as unknown as Octokit }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: () => undefined }), toast: () => undefined }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ save: vi.fn(async () => true), syncStatus: "idle" }) }));
vi.mock("@/components/book/McpServerSection", () => ({ McpServerSection: () => <section aria-label="mcp-stub" /> }));
vi.mock("@/components/book/BookGitHubAccess", () => ({ BookGitHubAccess: () => <section aria-label="book-github-access-stub" /> }));
vi.mock("@/components/book/GitHubRepositoryPicker", () => ({ GitHubRepositoryPicker: () => <section aria-label="picker-stub" /> }));
vi.mock("@/repository/githubRequest", () => ({ createTrackedGitHubClient: () => env.octokit }));

import i18n from "@/i18n";
import { BookSettingsPage } from "@/pages/BookSettingsPage";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { PAGES_WORKFLOW_PATH } from "@/github/bookRepository";
import { loadBookTemplate } from "@/narrarium/bookTemplate";
import { forgetPublishingBranchReads } from "@/readerUpdate/publishingBranch";
import { blockNetwork, createLinkedBookClone, resetLocalWorkspace } from "./helpers/localFirst";
import { createFakeBranchGitHub, type FakeBranchGitHub } from "./helpers/fakeBranchGitHub";
import v1 from "./fixtures/pagesWorkflowV1.yml?raw";

// A GitHub book on a branch that is not the one the workflow publishes from, with an old reader: the notice of the GitHub tab knows it from the working copy on this
// device. Opening the settings page must not ask GitHub for anything (the page «authenticated route families survive direct navigation and refresh» of the e2e
// found two failed reads of the publishing branch, 2026-11-27): GitHub is asked only when the card that needs the answer is on the screen.

let github: FakeBranchGitHub;

async function setup() {
  const template = await loadBookTemplate();
  const reader = Object.entries(template.files).filter(([path]) => path.startsWith("reader/")).map(([path, file]) => ({ path, content: file.text.split(template.placeholders.readerPackage).join("jesus-reader") }));
  const files = [{ path: "book.md", content: "---\ntype: book\ntitle: Jesus\n---\n" }, ...reader.slice(0, 5), { path: PAGES_WORKFLOW_PATH, content: v1 }];
  github = createFakeBranchGitHub({ branch: "main", files: Object.fromEntries(files.map((file) => [file.path, file.content])) });
  github.refs.set("feature/x", github.refs.get("main")!);
  env.octokit = github.octokit;
  const local = await createLinkedBookClone({ owner: "keyser", repo: "jesus", branch: "feature/x", token: "ghp_book", files });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultGitHubToken: "ghp_default", books: [local.book] } });
  useBooksStore.setState({ structures: { [local.book.id]: { ...local.structure, defaultBranch: "main" } } } as never);
  return local;
}

function mount(bookId: string, hash = "") {
  return render(
    <MemoryRouter initialEntries={[`/app/books/${bookId}/settings${hash}`]}>
      <Routes><Route path="/app/books/:bookId/settings" element={<BookSettingsPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await resetLocalWorkspace();
  forgetPublishingBranchReads();
  window.history.replaceState(null, "", "/");
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe.each([["en", "GitHub", "The reader of this book is out of date"], ["it", "GitHub", "Il lettore di questo libro è vecchio"]] as const)("the settings of a book on GitHub, in %s", (language, githubTab, noticeTitle) => {
  beforeEach(async () => { await i18n.changeLanguage(language); });

  it("makes no request to GitHub when the page is opened on its default tab, however long it is left open, though the old reader is known from this device", async () => {
    const network = blockNetwork();
    const local = await setup();
    mount(local.book.id);
    // The notice of the GitHub tab (drawn, hidden) has read the working copy: it knows the reader is old.
    await waitFor(() => expect(document.querySelector(`section[aria-label="${noticeTitle}"]`)).not.toBeNull(), { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(github.calls).toEqual([]);
    expect(network.github()).toEqual([]);
  });

  it("asks GitHub for what the publishing branch has once the GitHub tab is opened, and not before", async () => {
    const network = blockNetwork();
    const local = await setup();
    mount(local.book.id);
    await waitFor(() => expect(document.querySelector(`section[aria-label="${noticeTitle}"]`)).not.toBeNull(), { timeout: 20_000 });
    expect(github.calls).toEqual([]);
    fireEvent.click(screen.getByRole("tab", { name: githubTab }));
    await waitFor(() => expect(github.calls.some((call) => call.method === "getRef" && (call.args as { ref?: string }).ref === "heads/main")).toBe(true), { timeout: 20_000 });
    expect(network.github()).toEqual([]);
  });

  it("opened directly on the GitHub tab (a link to it), asks at once", async () => {
    blockNetwork();
    const local = await setup();
    mount(local.book.id, "#github");
    await waitFor(() => expect(github.calls.some((call) => call.method === "getRef")).toBe(true), { timeout: 20_000 });
  });
});
