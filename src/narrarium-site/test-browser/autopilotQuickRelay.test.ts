import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import type { AiPort, AiRequest } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, ai: null as unknown }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBroadcastBus } from "./helpers/fakeBroadcastChannel";
import { FakeLockRegistry } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const BRIEF = { idea: "A harbor built on glass hides a lie.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let bus: FakeBroadcastBus;
let locks: FakeLockRegistry;
let local: MemoryBookStore;
let holding: { promise: Promise<void> | null; release: () => void };
let tabA: BrowserAutopilotRuntime;
let tabB: BrowserAutopilotRuntime;

function openTab(name: string): BrowserAutopilotRuntime {
  const channel = bus.channel(name);
  return new BrowserAutopilotRuntime({ locks: () => locks.forTab(name) as never, channel: () => channel as never });
}

function heldAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return { async complete(request: AiRequest) {
    const held = holding.promise;
    if (held) {
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve);
        const abandon = () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"));
        if (request.signal?.aborted) abandon();
        else request.signal?.addEventListener("abort", abandon, { once: true });
      });
    }
    request.signal?.throwIfAborted();
    return inner.complete(request);
  } };
}

const summary = () => useAutopilotStore.getState().summaries[BOOK.id];
const commandsPosted = () => bus.posted.filter((entry) => (entry.data as { kind?: string }).kind === "command").map((entry) => (entry.data as { command: { type: string; mode?: string } }).command);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  localStorage.clear();
  bus = new FakeBroadcastBus();
  locks = new FakeLockRegistry();
  local = new MemoryBookStore(seedBookFiles());
  mocks.local = local;
  mocks.ai = heldAi();
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  holding = { promise, release: () => { holding.promise = null; release(); } };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never] } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
  tabA = openTab("A");
  tabB = openTab("B");
  // The run belongs to the tab A; its first step is held back.
  await tabA.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
});

afterEach(async () => {
  await tabA.pause(BOOK.id, "now").catch(() => undefined);
  holding.release();
  await vi.waitFor(() => expect(tabA.isRunningHere(BOOK.id)).toBe(false), { timeout: 3000 }).catch(() => undefined);
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
});

describe("commanding a run that belongs to another tab of this browser", () => {
  it("relays the pause at the end of the chapter to the tab that runs the book, which says it to the others", async () => {
    await tabB.pause(BOOK.id, "after-chapter");
    expect(commandsPosted()).toEqual([{ type: "pause", mode: "after-chapter" }]);
    expect(summary()?.pausePending).toBe("after-chapter");
  });

  it("relays taking back a pause as a command of its own, never as a pause: a tab that does not know it must not pause the run", async () => {
    await tabB.pause(BOOK.id, "after-step");
    expect(summary()?.pausePending).toBe("after-step");
    await tabB.pause(BOOK.id, "cancel");
    expect(commandsPosted().map((command) => command.type)).toEqual(["pause", "cancel-pause"]);
    expect(JSON.stringify(commandsPosted())).not.toContain('"mode":"cancel"');
    expect(summary()?.pausePending).toBeNull();
    expect(tabA.isRunningHere(BOOK.id)).toBe(true);
  });

  it("relays the options that change during a run, and the tab that runs the book saves them", async () => {
    await tabB.updateOptions(BOOK.id, { publishEvery: "step" });
    expect(commandsPosted()).toEqual([{ type: "update-options", options: { publishEvery: "step" } }]);
    expect(JSON.parse(local.files.get("autopilot/state.json") ?? "{}").options.publishEvery).toBe("step");
    expect(summary()?.publish).toBe("step");
  });

  it("says so when no tab answers", async () => {
    bus.closeTab("A");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const refused = tabB.pause(BOOK.id, "after-chapter").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await refused).toMatchObject({ code: "other-tab" });
    } finally {
      vi.useRealTimers();
    }
  });
});
