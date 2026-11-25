import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/drive/useSettings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/drive/useSettings")>()), saveSettingsNow: saved }));

import i18n from "@/i18n";
import "@/i18n/branches";
// The tabs of the book settings register these: the card lives in them.
import "@/i18n/bookSettingsTabs";
import { BranchButton } from "@/components/branches/BranchButton";
import { AutoSyncStatus } from "@/components/branches/AutoSyncStatus";
import { BranchMemoryCard } from "@/components/book/settings/BranchMemoryCard";
import { WorkingBranchCard } from "@/components/book/settings/WorkingBranchCard";
import { applyDraft, draftOfBook } from "@/bookSettings/draft";
import { bookBranchMemory, recordBranchUse } from "@/branches/memory";
import { labelBranch } from "@/branches/memoryEdits";
import { useBranchSyncStore } from "@/branches/syncStore";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookBranchMemory, type BookEntry } from "@/types/settings";
import { chooseOption, optionNames, polyfillRadix } from "./helpers/radix";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const book: BookEntry = { id: "book-1", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, bookToken: "ghp_x", activeBranch: "main", addedAt: ago(10_000) };
const flush = async () => { await act(async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }); };

function memoryOf(): BookBranchMemory {
  let memory = recordBranchUse(undefined, "draft/old", ago(3 * 24 * 60), { createdHere: true });
  memory = recordBranchUse(memory, "feature/ending", ago(60));
  return recordBranchUse(memory, "main", ago(5), { current: true });
}

beforeEach(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  useBranchSyncStore.setState({ books: {} });
  useBooksStore.setState({ structures: {}, workingBranches: {} });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], branchMemory: { "writer/novel": memoryOf() } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("the branch button of the top bar", () => {
  it("is named by the words it shows, with what concerns the branch, and opens the switcher", () => {
    const onOpen = vi.fn();
    const view = render(<BranchButton bookId="book-1" branch="draft/2026-11-24" pending mode="off" onOpen={onOpen} />);
    const button = screen.getByRole("button", { name: "Branch draft/2026-11-24, not published, auto-sync off. Switch branch or create one" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveTextContent("draft/2026-11-24not publishedauto-sync off");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { status: "running", branches: { "draft/2026-11-24": { outcome: "diverged", at: NOW } } }); });
    view.rerender(<BranchButton bookId="book-1" branch="draft/2026-11-24" pending={false} mode="open-focus" onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "Branch draft/2026-11-24, needs attention, syncing. Switch branch or create one" })).toBeInTheDocument();
  });

  it("speaks Italian too", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    render(<BranchButton bookId="book-1" branch="main" pending={false} mode="open-focus" onOpen={() => undefined} />);
    expect(screen.getByRole("button", { name: "Ramo main. Cambia ramo o creane uno" })).toBeInTheDocument();
  });
});

describe("what the automatic sync did, in the menu of the pill", () => {
  it("says the mode, off plainly, and the last cycle, or that there was none, or why it waits", () => {
    const view = render(<AutoSyncStatus bookId="book-1" mode="off" />);
    expect(screen.getByText("Automatic sync is off for this book")).toHaveClass("font-medium");
    expect(screen.queryByText(/Last automatic sync/)).toBeNull();
    view.rerender(<AutoSyncStatus bookId="book-1" mode="open-focus" />);
    expect(screen.getByText("No automatic sync since the app opened.")).toBeInTheDocument();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { lastSummary: { at: NOW - 3 * 60_000, pulledFiles: 0, pulled: 0, pushed: 0, published: 1, downloaded: 2, attention: 0 } }); });
    expect(screen.getByText("Last automatic sync 3 minutes ago: published the new branch, brought 2 branches to this device.")).toBeInTheDocument();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { lastSummary: { at: NOW - 30_000, pulledFiles: 0, pulled: 0, pushed: 0, published: 0, downloaded: 0, attention: 0 } }); });
    expect(screen.getByText("Last automatic sync now: nothing to do.")).toBeInTheDocument();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { status: "autopilot" }); });
    expect(screen.getByText("Waiting: the autopilot is running this book.")).toBeInTheDocument();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { status: "failed", pausedUntil: NOW + 10 * 60_000, lastSummary: { at: NOW - 60_000, pulledFiles: 0, pulled: 0, pushed: 0, published: 0, downloaded: 0, attention: 0, failed: "network" } }); });
    expect(screen.getByText("Last automatic sync 1 minute ago failed: GitHub could not be reached. Remote state is unverified. Next try in 10 minutes.")).toBeInTheDocument();
  });
});

describe("the branches in the GitHub tab", () => {
  function show() {
    return render(<MemoryRouter><BranchMemoryCard book={useSettingsStore.getState().settings.books[0]} /></MemoryRouter>);
  }
  const memoryNow = () => bookBranchMemory(useSettingsStore.getState().settings, book)!;

  it("show the last branch worked on and every branch worked on, the newest first", () => {
    show();
    expect(screen.getByTestId("last-working-branch")).toHaveTextContent("Last branch worked on, on any device: main (5 minutes ago).");
    const rows = within(screen.getByTestId("branch-memory-card")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-branch"))).toEqual(["main", "feature/ending", "draft/old"]);
    expect(rows[0]).toHaveTextContent("used 5 minutes ago · Open now");
    expect(rows[2]).toHaveTextContent("used 3 days ago · created in Narrarium");
  });

  it("make the automatic sync of the book obvious, off included, and set it for this book alone", async () => {
    show();
    const select = screen.getByRole("combobox", { name: "Automatic sync of this book" });
    expect(optionNames(select)).toEqual(["Like the other books (When the book opens and when you come back to it)", "Off", "When the book opens and when you come back to it", "Also every 5 minutes"]);
    chooseOption(select, "Off");
    await flush();
    expect(memoryNow().autoSync).toBe("off");
    expect(saved).toHaveBeenCalled();
    expect(screen.getByTestId("auto-sync-off")).toHaveTextContent("Automatic sync is off for this book: nothing comes from GitHub or is published until you sync.");
    chooseOption(screen.getByRole("combobox", { name: "Automatic sync of this book" }), /^Like the other books/);
    await flush();
    expect(memoryNow().autoSync).toBeUndefined();
    expect(screen.queryByTestId("auto-sync-off")).toBeNull();
  });

  it("rename (a name in this list only), keep in sync or not, and forget, never the branch open here", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Rename feature/ending in this list" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name in this list for feature/ending" }), { target: { value: "The dark ending" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(memoryNow().knownBranches.find((entry) => entry.name === "feature/ending")).toMatchObject({ name: "feature/ending", label: "The dark ending" });
    chooseOption(screen.getByRole("combobox", { name: "Keep draft/old in sync" }), "Always sync it");
    await flush();
    expect(memoryNow().knownBranches.find((entry) => entry.name === "draft/old")?.sync).toBe(true);
    expect(screen.getByRole("button", { name: "Forget main" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Forget draft/old" }));
    await flush();
    expect(memoryNow().knownBranches.map((entry) => entry.name)).toEqual(["main", "feature/ending"]);
    expect(memoryNow().lastWorkingBranch).toBe("main");
  });

  it("speak Italian too", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, branchMemory: { "writer/novel": labelBranch(memoryOf(), "main", "Principale", ago(1)) } } });
    show();
    expect(screen.getByRole("heading", { name: "Rami su cui hai lavorato" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sincronizzazione automatica di questo libro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dimentica feature/ending" })).toBeEnabled();
  });
});

describe("the branch name of a book kept on this device", () => {
  const localBook: BookEntry = { id: "local-1", storageMode: "local-only", localRepositoryId: "l1", owner: "", repo: "", name: "Here", tokenIndex: null, activeBranch: "local:l1", addedAt: ago(10) };

  it("is shown and edited in the GitHub tab, main unless chosen, and a name Git refuses is said and not saved", () => {
    const onName = vi.fn();
    const view = render(<MemoryRouter><WorkingBranchCard book={localBook} activeBranch="local:l1" onActiveBranch={() => undefined} localBranchName="main" onLocalBranchName={onName} /></MemoryRouter>);
    expect(screen.getByTestId("working-branch-state")).toHaveTextContent("«main» — only on this device");
    const field = screen.getByRole("textbox", { name: "Name of the branch" });
    expect(field).toHaveAccessibleDescription(/a new or empty repository gets this branch, with the book, as its default branch/);
    fireEvent.change(field, { target: { value: "draft" } });
    expect(onName).toHaveBeenCalledWith("draft");
    view.rerender(<MemoryRouter><WorkingBranchCard book={localBook} activeBranch="local:l1" onActiveBranch={() => undefined} localBranchName="my draft" onLocalBranchName={onName} /></MemoryRouter>);
    expect(screen.getByRole("alert")).toHaveTextContent("A name has no spaces.");
    expect(applyDraft(localBook, { ...draftOfBook(localBook), localBranchName: "my draft" }).localBranchName).toBeUndefined();
    expect(applyDraft(localBook, { ...draftOfBook(localBook), localBranchName: " draft " }).localBranchName).toBe("draft");
    expect(applyDraft({ ...localBook, localBranchName: "draft" }, { ...draftOfBook(localBook), localBranchName: "main" }).localBranchName).toBeUndefined();
    expect(draftOfBook(localBook).localBranchName).toBe("main");
  });
});
