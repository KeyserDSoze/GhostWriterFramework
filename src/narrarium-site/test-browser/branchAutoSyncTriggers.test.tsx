import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ requests: [] as Array<[string, string]>, branches: [] as Array<string | undefined> }));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/branches/syncRuntime", () => ({ branchSyncRuntime: () => ({ request: (bookId: string, trigger: string, branch?: string) => { runtime.requests.push([bookId, trigger]); runtime.branches.push(branch); } }) }));
vi.mock("@/components/ui/use-toast", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/components/ui/use-toast")>()), toast: toasts }));

import i18n from "@/i18n";
// What the branch sync loads with itself: the texts of what it tells the person.
import "@/i18n/branches";
import { PERIODIC_INTERVAL_MS } from "@/branches/autoSyncPolicy";
import { useBranchAutoSync, type BranchAutoSyncInput } from "@/branches/useBranchAutoSync";
import { sayOutcomesOfWatchedBranch } from "@/branches/outcomeToasts";
import { useBranchSyncStore } from "@/branches/syncStore";
import { useSaveStore } from "@/store/saveStore";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

function Probe(props: BranchAutoSyncInput) {
  useBranchAutoSync(props);
  return null;
}

const flush = async () => { await act(async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }); };
const base: BranchAutoSyncInput = { bookId: "book-1", loadedBranch: "main", ready: true, mode: "open-focus", onSyncNow: () => undefined };

beforeEach(async () => {
  runtime.requests.length = 0;
  runtime.branches.length = 0;
  sessionStorage.clear();
  useBranchSyncStore.setState({ books: {} });
  useSaveStore.setState({ current: null });
  await i18n.changeLanguage("en");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("what starts the automatic sync of the book on the screen", () => {
  it("opening the book, switching branch, and coming back to the window", async () => {
    const view = render(<Probe {...base} />);
    await flush();
    expect(runtime.requests).toEqual([["book-1", "open"]]);
    view.rerender(<Probe {...base} loadedBranch="draft" />);
    await flush();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(runtime.requests).toEqual([["book-1", "open"], ["book-1", "switch"], ["book-1", "focus"]]);
    // Each says which branch this tab shows: the tab that syncs may not show the book.
    expect(runtime.branches).toEqual(["main", "draft", "draft"]);
  });

  it("nothing without GitHub, then a cycle as soon as GitHub can be reached; nothing at all when the mode is off", async () => {
    const view = render(<Probe {...base} ready={false} />);
    await flush();
    act(() => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(runtime.requests).toEqual([]);
    view.rerender(<Probe {...base} ready />);
    await flush();
    expect(runtime.requests).toEqual([["book-1", "open"], ["book-1", "online"]]);
    cleanup();
    runtime.requests.length = 0;
    render(<Probe {...base} mode="off" />);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(runtime.requests).toEqual([]);
  });

  it("the timer in the periodic mode, counted from the last cycle and longer after failures", async () => {
    vi.useFakeTimers();
    render(<Probe {...base} mode="periodic" />);
    await flush();
    act(() => { vi.advanceTimersByTime(PERIODIC_INTERVAL_MS - 1); });
    expect(runtime.requests).toEqual([["book-1", "open"]]);
    act(() => { vi.advanceTimersByTime(1); });
    await flush();
    expect(runtime.requests).toEqual([["book-1", "open"], ["book-1", "periodic"]]);
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { failures: 2, lastCycleAt: 1 }); });
    act(() => { vi.advanceTimersByTime(PERIODIC_INTERVAL_MS * 4 - 1); });
    expect(runtime.requests).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    await flush();
    expect(runtime.requests).toHaveLength(3);
  });
});

describe("unsaved edits", () => {
  it("hold a shared lock for the book while they last, so that no tab pulls under them", async () => {
    const registry = new FakeLockRegistry();
    const restore = installNavigatorLocks(registry.forTab("tab"));
    try {
      render(<Probe {...base} />);
      act(() => { useSaveStore.setState({ current: { dirty: true, save: () => true } }); });
      await flush();
      expect((await registry.forTab("tab").query()).held.map((lock) => lock.name)).toEqual(["narrarium:editing:book-1"]);
      act(() => { useSaveStore.setState({ current: { dirty: false, save: () => true } }); });
      await flush();
      expect((await registry.forTab("tab").query()).held).toEqual([]);
    } finally { restore(); }
  });
});

describe("what the person is told", () => {
  // Said by the branch sync of the tab (it loads with the first request), about the branch the hook says this tab shows.
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; });

  it("that GitHub and this device both changed the branch, once, with the Sync at hand", async () => {
    const onSyncNow = vi.fn();
    render(<Probe {...base} onSyncNow={onSyncNow} />);
    stop = sayOutcomesOfWatchedBranch();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { main: { outcome: "diverged", at: 1, remoteHeadSha: "abc" } } }); });
    await flush();
    expect(toasts).toHaveBeenCalledTimes(1);
    const shown = toasts.mock.calls[0][0];
    expect(shown).toMatchObject({ title: "GitHub and this device both changed main", description: "Nothing was overwritten. Sync to bring the two together: if the same file changed on both sides, you choose which version to keep." });
    shown.action.props.onClick();
    expect(onSyncNow).toHaveBeenCalled();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { main: { outcome: "diverged", at: 2, remoteHeadSha: "abc" } } }); });
    await flush();
    expect(toasts).toHaveBeenCalledTimes(1);
  });

  it("about the branch this tab shows only, also when the tab switches to a branch that needs attention", async () => {
    const view = render(<Probe {...base} />);
    stop = sayOutcomesOfWatchedBranch();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { draft: { outcome: "gone", at: 1 } } }); });
    await flush();
    expect(toasts).not.toHaveBeenCalled();
    view.rerender(<Probe {...base} loadedBranch="draft" />);
    await flush();
    expect(toasts).toHaveBeenCalledWith({ title: "draft is no longer on GitHub", description: "The copy on this device is kept, with its changes. To publish them, create a new branch from it." });
  });

  it("why it failed, in Italian too; and nothing for what cannot lose anything", async () => {
    await act(async () => { await i18n.changeLanguage("it"); });
    render(<Probe {...base} />);
    stop = sayOutcomesOfWatchedBranch();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { main: { outcome: "pulled", at: 1 } } }); });
    await flush();
    expect(toasts).not.toHaveBeenCalled();
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { main: { outcome: "failed", at: 2, errorKind: "network" } } }); });
    await flush();
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ title: "La sincronizzazione automatica di main non è riuscita", variant: "destructive" }));
    expect(toasts.mock.calls[0][0].description).toMatch(/Riproverà più tardi\.$/);
    act(() => { useBranchSyncStore.getState().patchBook("book-1", { branches: { main: { outcome: "gone", at: 3 } } }); });
    await flush();
    expect(toasts).toHaveBeenLastCalledWith({ title: "main non è più su GitHub", description: "La copia su questo dispositivo resta, con le sue modifiche. Per pubblicarle, crea un nuovo ramo a partire da questo." });
  });
});
