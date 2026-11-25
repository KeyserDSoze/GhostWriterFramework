import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ copies: [] as Array<{ branch: string; owner: string; repo: string; cloneComplete: boolean; pendingBranch?: unknown }>, status: {} as Record<string, { dirty: number; ahead: number }> }));
const remoteList = vi.hoisted(() => ({ cached: new Map<string, string>(), fresh: null as Map<string, string> | null, calls: 0 }));
const actions = vi.hoisted(() => ({ switchBranch: vi.fn(async () => undefined), createBranch: vi.fn(async () => ({})), setBookAutoSyncMode: vi.fn(async () => undefined) }));
const syncRequests = vi.hoisted(() => [] as Array<[string, string, string | undefined]>);
const toasts = vi.hoisted(() => vi.fn());

vi.mock("@/repository/localRepository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/localRepository")>()),
  listLocalRepositoriesByBook: async () => local.copies,
  getLocalRepositoryStatusSnapshot: async (_owner: string, _repo: string, branch: string) => ({ meta: {}, status: { clean: 0, modified: 0, new: 0, deleted: 0, ...(local.status[branch] ?? { dirty: 0, ahead: 0 }) } }),
}));
vi.mock("@/branches/remoteBranches", () => ({
  cachedRemoteBranches: () => ({ heads: remoteList.cached, at: 0 }),
  listRemoteBranches: async () => { remoteList.calls += 1; if (!remoteList.fresh) throw new Error("offline"); return { heads: remoteList.fresh, complete: true, unchanged: false, rate: null }; },
}));
vi.mock("@/branches/branchActions", () => actions);
vi.mock("@/branches/useBranchAutoSync", () => ({ requestBranchSync: (bookId: string, trigger: string, branch?: string) => syncRequests.push([bookId, trigger, branch]) }));
vi.mock("@/components/ui/use-toast", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/ui/use-toast")>()), useToast: () => ({ toast: toasts }), toast: toasts }));

import i18n from "@/i18n";
import { BranchSwitcherDialog, type BranchSwitcherDialogProps } from "@/components/branches/BranchSwitcherDialog";
import { recordBranchUse } from "@/branches/memory";
import { labelBranch, setBookAutoSync } from "@/branches/memoryEdits";
import { useBranchSyncStore } from "@/branches/syncStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookBranchMemory, type BookEntry } from "@/types/settings";
import { polyfillRadix } from "./helpers/radix";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const book: BookEntry = { id: "book-1", owner: "writer", repo: "novel", name: "The Glass Harbor", tokenIndex: null, bookToken: "ghp_x", activeBranch: "main", addedAt: ago(10_000) };

function memoryOf(): BookBranchMemory {
  let memory = recordBranchUse(undefined, "draft/old-idea", ago(3 * 24 * 60));
  memory = recordBranchUse(memory, "feature/ending", ago(60));
  memory = labelBranch(memory, "feature/ending", "The dark ending", ago(60));
  return recordBranchUse(memory, "main", ago(5), { current: true });
}

function show(props: Partial<BranchSwitcherDialogProps> = {}, memory: BookBranchMemory = memoryOf()) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], branchMemory: { "writer/novel": memory } } });
  const onOpenChange = vi.fn();
  const onSyncNow = vi.fn();
  const view = render(
    <MemoryRouter>
      <BranchSwitcherDialog open onOpenChange={onOpenChange} book={book} branch="main" pending={false} remote="ready" token="ghp_x" onSyncNow={onSyncNow} {...props} />
    </MemoryRouter>,
  );
  return { view, onOpenChange, onSyncNow, dialog: () => screen.getByTestId("branch-switcher") };
}

const flush = async () => { await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }); };
const options = () => within(screen.getByRole("listbox", { name: /Branches of the book|Rami del libro/ })).queryAllByRole("option");
const optionOf = (name: string) => options().find((option) => option.getAttribute("data-branch") === name)!;

beforeEach(async () => {
  polyfillRadix();
  await i18n.changeLanguage("en");
  local.copies = [{ branch: "main", owner: "writer", repo: "novel", cloneComplete: true }, { branch: "feature/ending", owner: "writer", repo: "novel", cloneComplete: true }, { branch: "draft/here-only", owner: "writer", repo: "novel", cloneComplete: true, pendingBranch: { base: "main", headSha: "a", createdAt: ago(1) } }];
  local.status = { "feature/ending": { dirty: 2, ahead: 1 } };
  remoteList.cached = new Map([["main", "1"], ["feature/ending", "2"]]);
  remoteList.fresh = new Map([["main", "1"], ["feature/ending", "2"], ["draft/old-idea", "3"], ["colleague/notes", "4"]]);
  remoteList.calls = 0;
  syncRequests.length = 0;
  useBranchSyncStore.setState({ books: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("the branch switcher", () => {
  it("shows the current branch, then the branches worked on and the others of GitHub, each with what concerns it, from what this device knows and then GitHub", async () => {
    show();
    await flush();
    expect(screen.getByRole("dialog", { name: "Branches" })).toBeInTheDocument();
    expect(screen.getByTestId("current-branch-state")).toHaveTextContent("Open now · On GitHub");
    expect(options().map((option) => option.getAttribute("data-branch"))).toEqual(["main", "feature/ending", "draft/old-idea", "draft/here-only", "colleague/notes"]);
    expect(optionOf("main")).toHaveAttribute("aria-current", "true");
    expect(optionOf("feature/ending")).toHaveTextContent("feature/ending(The dark ending)On GitHub · 2 changes not published · 1 commit not published · used 1 hour ago");
    expect(optionOf("draft/here-only")).toHaveTextContent("Only on this device, not published yet");
    expect(optionOf("draft/old-idea")).toHaveTextContent("On GitHub, not on this device yet · used 3 days ago");
    expect(remoteList.calls).toBe(1);
    // The field has the focus, and the list is said with it.
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Find a branch" }));
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
  });

  it("is found by typing (a label too), moved through with the arrows, and opens a branch with Enter", async () => {
    const { onOpenChange } = show();
    await flush();
    const field = screen.getByRole("combobox", { name: "Find a branch" });
    fireEvent.change(field, { target: { value: "dark" } });
    expect(options().map((option) => option.getAttribute("data-branch"))).toEqual(["feature/ending"]);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toBe(optionOf("feature/ending").id);
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    expect(actions.switchBranch).toHaveBeenCalledWith("book-1", "feature/ending");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toasts).toHaveBeenCalledWith({ title: "Opened the branch feature/ending", description: "Your work on main stays on that branch." });
    fireEvent.change(field, { target: { value: "nothing like this" } });
    expect(options()).toEqual([]);
    expect(screen.getByText("No branch has this name. Create it below.", { selector: "li" })).toBeInTheDocument();
  });

  it("without GitHub keeps the branches of this device and says why the others wait", async () => {
    remoteList.cached = new Map([["main", "1"], ["feature/ending", "2"], ["draft/old-idea", "3"]]);
    show({ remote: "no-credential" });
    await flush();
    expect(remoteList.calls).toBe(0);
    expect(screen.getByText(/Without a GitHub credential, the branches on this device still open and work/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute("href", "/app/settings/github");
    expect(optionOf("feature/ending")).not.toHaveAttribute("aria-disabled");
    const remoteOnly = optionOf("draft/old-idea");
    expect(remoteOnly).toHaveAttribute("aria-disabled", "true");
    expect(remoteOnly).toHaveTextContent("On GitHub: downloading it needs GitHub");
    fireEvent.click(remoteOnly);
    await flush();
    expect(actions.switchBranch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sync the branches now" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Publish it on GitHub now" })).toBeDisabled();
  });

  it("says plainly when the automatic sync of the book is off, and switches it in one place", async () => {
    const { view } = show({}, setBookAutoSync(memoryOf(), "off", ago(1)));
    await flush();
    const toggle = screen.getByRole("switch", { name: "Automatic sync of this book" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    // Said with the current branch, at the top, and where it is switched.
    expect(within(screen.getByTestId("branch-switcher")).getByTestId("auto-sync-off")).toHaveTextContent("Automatic sync is off for this book");
    expect(within(screen.getByTestId("branch-switcher")).getAllByText("Automatic sync is off for this book")).toHaveLength(2);
    fireEvent.click(toggle);
    expect(actions.setBookAutoSyncMode).toHaveBeenCalledWith("book-1", "on");
    view.unmount();
    show();
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Automatic sync of this book" }));
    expect(actions.setBookAutoSyncMode).toHaveBeenLastCalledWith("book-1", "off");
    fireEvent.click(screen.getByRole("button", { name: "Sync the branches now" }));
    expect(syncRequests).toEqual([["book-1", "manual", "main"]]);
  });

  it("shows what the last automatic sync did, and offers the Sync when GitHub and this device both changed the branch", async () => {
    useBranchSyncStore.getState().patchBook("book-1", { lastSummary: { at: NOW - 120_000, pulledFiles: 3, pulled: 1, pushed: 1, published: 0, downloaded: 0, attention: 1 }, branches: { main: { outcome: "diverged", at: NOW } } });
    const { onSyncNow, onOpenChange } = show();
    await flush();
    expect(screen.getByText("Last automatic sync 2 minutes ago: brought 3 files from GitHub, published your changes, 1 branch needs attention.")).toBeInTheDocument();
    expect(screen.getByTestId("current-branch-state")).toHaveTextContent("GitHub and this device both changed it");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSyncNow).toHaveBeenCalled();
  });
});

describe("a new branch", () => {
  it("is one action: a name suggested from the day, made from the current branch, published with the next sync", async () => {
    const { onOpenChange } = show();
    await flush();
    const name = screen.getByRole("textbox", { name: "Name of the new branch" }) as HTMLInputElement;
    expect(name.value).toMatch(/^draft\/\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText(/From main, with what it has now\. Made on this device first, it opens at once\. It is published with the next sync\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await flush();
    expect(actions.createBranch).toHaveBeenCalledWith({ bookId: "book-1", from: "main", name: name.value, publishNow: false, token: "ghp_x" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toasts).toHaveBeenCalledWith({ title: `Created the branch ${name.value}`, description: "It is on this device: it is published with the next sync." });
  });

  it("turns words into a name, refuses a name Git would refuse or one that is taken, and can be published at once", async () => {
    show();
    await flush();
    const name = screen.getByRole("textbox", { name: "Name of the new branch" });
    const create = screen.getByRole("button", { name: "Create branch" });
    fireEvent.change(name, { target: { value: "The dark ending" } });
    expect(screen.getByText("It will be called feature/the-dark-ending.")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "feature/ending" } });
    expect(screen.getByText("A branch with this name already exists: choose it in the list, or pick another name.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(create).toBeDisabled();
    fireEvent.change(name, { target: { value: "draft/ends.lock" } });
    expect(screen.getByText("It will be called draft/ends-lock.")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "?!" } });
    expect(screen.getByText("Write a name, or a few words: they become the name.")).toBeInTheDocument();
    expect(create).toBeDisabled();
    fireEvent.change(name, { target: { value: "The dark ending" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Publish it on GitHub now" }));
    expect(screen.getByText(/Publish it on GitHub now$/, { selector: "p" })).toBeInTheDocument();
    actions.createBranch.mockResolvedValueOnce({ published: { outcome: "published" } } as never);
    fireEvent.click(create);
    await flush();
    expect(actions.createBranch).toHaveBeenCalledWith({ bookId: "book-1", from: "main", name: "feature/the-dark-ending", publishNow: true, token: "ghp_x" });
    expect(toasts).toHaveBeenCalledWith({ title: "Created the branch feature/the-dark-ending", description: "It is on GitHub too." });
  });

  it("stays on this device, and says why, when publishing it at once fails", async () => {
    show();
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: "Publish it on GitHub now" }));
    actions.createBranch.mockResolvedValueOnce({ published: { outcome: "name-taken" } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await flush();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive", description: expect.stringMatching(/^The branch is on this device, but publishing it failed: It has other changes/) }));
  });

  it("speaks Italian too", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    show();
    await flush();
    expect(screen.getByRole("dialog", { name: "Rami" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Trova un ramo" })).toBeInTheDocument();
    expect(optionOf("feature/ending")).toHaveTextContent("2 modifiche non pubblicate");
    expect(screen.getByRole("button", { name: "Crea il ramo" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("5 rami"));
  });
});
