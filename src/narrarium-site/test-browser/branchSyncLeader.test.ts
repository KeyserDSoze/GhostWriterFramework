import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncTrigger } from "@/branches/autoSyncPolicy";
import { BranchSyncRuntime } from "@/branches/syncRuntime";
import { emptyBookSyncState, useBranchSyncStore, type BookSyncState } from "@/branches/syncStore";
import { FakeLockRegistry } from "./helpers/fakeWebLocks";
import { FakeBroadcastBus } from "./helpers/fakeBroadcastChannel";

// Three tabs of one browser: one syncs, the others ask it; when it closes, the next one takes over. Every cycle is recorded with the tab that ran it.

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

function browser() {
  const locks = new FakeLockRegistry();
  const bus = new FakeBroadcastBus();
  const cycles: Array<{ tab: string; bookId: string; trigger: SyncTrigger; branch?: string }> = [];
  const refreshed: Array<{ tab: string; bookId: string; branch: string }> = [];
  const gates = new Map<string, () => void>();
  const tab = (name: string, options: { slow?: boolean } = {}) => new BranchSyncRuntime({
    locks: () => locks.forTab(name) as unknown as LockManager,
    channel: () => bus.channel(name),
    refresh: (bookId, branch) => refreshed.push({ tab: name, bookId, branch }),
    cycle: async (bookId, request, branchUpdated) => {
      cycles.push({ tab: name, bookId, trigger: request.trigger, ...(request.branch ? { branch: request.branch } : {}) });
      if (options.slow) await new Promise<void>((resolve) => gates.set(`${name}:${bookId}`, resolve));
      branchUpdated(bookId, "main");
      return { ...emptyBookSyncState(), status: "done", lastCycleAt: cycles.length, branches: { main: { outcome: "pulled", at: cycles.length } } } satisfies BookSyncState;
    },
  });
  return { locks, bus, cycles, refreshed, tab, release: (key: string) => gates.get(key)?.() };
}

afterEach(() => { useBranchSyncStore.setState({ books: {} }); vi.restoreAllMocks(); });

describe("one tab syncs for the whole browser", () => {
  it("runs the cycles the other tabs ask for, tells them what it found, and has them read the branch again", async () => {
    const world = browser();
    const first = world.tab("first");
    first.start();
    await flush();
    const second = world.tab("second");
    second.start();
    await flush();
    expect(first.isLeader).toBe(true);
    expect(second.isLeader).toBe(false);

    // The asking tab says which branch it shows: the leading tab may not show the book at all.
    second.request("book-1", "focus", "draft");
    await flush();
    expect(world.cycles).toEqual([{ tab: "first", bookId: "book-1", trigger: "focus", branch: "draft" }]);
    // The answer reaches the tab that asked (and every other one): its store has it, and the pages showing the branch read it again.
    expect(useBranchSyncStore.getState().books["book-1"]).toMatchObject({ status: "done", branches: { main: { outcome: "pulled" } } });
    expect(world.refreshed).toEqual(expect.arrayContaining([{ tab: "first", bookId: "book-1", branch: "main" }, { tab: "second", bookId: "book-1", branch: "main" }]));
  });

  it("runs one cycle of a book at a time: what is asked meanwhile runs once more after, with the strongest reason and the branch shown last", async () => {
    const world = browser();
    const leader = world.tab("leader", { slow: true });
    leader.start();
    await flush();
    leader.request("book-1", "open", "main");
    leader.request("book-1", "focus", "main");
    leader.request("book-1", "manual", "main");
    leader.request("book-1", "periodic", "draft");
    await flush();
    expect(world.cycles.map((cycle) => cycle.trigger)).toEqual(["open"]);
    world.release("leader:book-1");
    await flush();
    expect(world.cycles.slice(1)).toEqual([{ tab: "leader", bookId: "book-1", trigger: "manual", branch: "draft" }]);
    world.release("leader:book-1");
    await flush();
    expect(world.cycles).toHaveLength(2);
  });

  it("hands over when the leading tab closes: the next one leads, and runs what was asked of the tab that went away", async () => {
    const world = browser();
    const first = world.tab("first", { slow: true });
    first.start();
    await flush();
    const second = world.tab("second");
    second.start();
    await flush();
    world.locks.closeTab("first");
    world.bus.closeTab("first");
    await flush();
    expect(second.isLeader).toBe(true);
    second.request("book-2", "open");
    await flush();
    expect(world.cycles).toEqual([{ tab: "second", bookId: "book-2", trigger: "open" }]);
  });

  it("runs, once it leads, what it asked before any tab could answer", async () => {
    const world = browser();
    const alone = world.tab("alone");
    alone.request("book-3", "open");
    expect(alone.isLeader).toBe(false);
    await flush();
    expect(alone.isLeader).toBe(true);
    expect(world.cycles).toEqual([{ tab: "alone", bookId: "book-3", trigger: "open" }]);
  });

  it("syncs by itself without Web Locks", async () => {
    const cycle = vi.fn(async () => ({ ...emptyBookSyncState(), status: "done" as const }));
    const tab = new BranchSyncRuntime({ locks: () => undefined, channel: () => null, cycle });
    tab.request("book-4", "open");
    await flush();
    expect(tab.isLeader).toBe(true);
    expect(cycle).toHaveBeenCalledWith("book-4", { trigger: "open" }, expect.any(Function));
  });
});
