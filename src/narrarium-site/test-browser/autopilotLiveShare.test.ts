import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import type { AiPort, AiRequest, AutopilotAttemptInfo } from "narrarium-engine";

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
import { eventOf, runningStep } from "./helpers/autopilotBand";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

// A tab that opens while another tab of the same browser runs the book: it has no step to show until the next event, and the candidate of the route that the call asks is said once, as the
// request is sent. The tab that runs the book answers when another asks, with the live part it follows, and the asking tab keeps it only if it follows no step yet.

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const TRYING: AutopilotAttemptInfo = { attempt: 2, attempts: 2, candidateIndex: 1, candidateCount: 2, fallback: true, integrationId: "proxy", integrationName: "LlmProxy", provider: "openai", model: "muse-glimmer-30b", thinking: "medium", streamMode: "auto" };
const STEP = runningStep("write", "Writing scene 2 of chapter 5 «Scene 2»", { chapterNumber: 5, sceneNumber: 2 });

let bus: FakeBroadcastBus;
let locks: FakeLockRegistry;
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

const posted = (kind: string) => bus.posted.filter((entry) => (entry.data as { kind?: string }).kind === kind);
const live = () => useAutopilotStore.getState().live[BOOK.id];

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  localStorage.clear();
  bus = new FakeBroadcastBus();
  locks = new FakeLockRegistry();
  mocks.local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
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

describe("a tab that opens in the middle of a step of a run that belongs to another tab", () => {
  it("asks the tab that runs the book what it shows, and that tab answers with its live part: the candidate of the route the call asks is there", async () => {
    await vi.waitFor(() => expect(live()?.activity.status).toBe("running"), { timeout: 3000 });
    // What the run of the tab A shows now: the step, and the candidate its call asks (the events of the run say it as the request is sent).
    useAutopilotStore.getState().ingest(eventOf({ type: "call-attempt", activityId: live()!.activity.id, callSeq: 1, ...TRYING }, 900), BOOK.name);
    expect(live()?.trying).toEqual(TRYING);

    await tabB.refresh(BOOK.id);
    expect(useAutopilotStore.getState().views[BOOK.id]?.busyInAnotherTab, "the book runs in another tab").toBe(true);
    expect(posted("live-request").map((entry) => [entry.from, (entry.data as { bookId: string }).bookId])).toEqual([["B", BOOK.id]]);
    await vi.waitFor(() => expect(posted("live")).toHaveLength(1));
    const answer = posted("live")[0];
    expect(answer.from, "only the tab that runs the book answers").toBe("A");
    expect((answer.data as { live: { trying: unknown; activity: { id: string } } }).live.trying).toEqual(TRYING);
    expect((answer.data as { live: { activity: { id: string } } }).live.activity.id).toBe(live()!.activity.id);
  });

  it("does not ask for a book that no other tab runs", async () => {
    await tabA.pause(BOOK.id, "now");
    await vi.waitFor(() => expect(tabA.isRunningHere(BOOK.id)).toBe(false), { timeout: 3000 });
    bus.posted.length = 0;
    await tabB.refresh(BOOK.id);
    expect(posted("live-request")).toEqual([]);
  });
});

describe("what a tab keeps of the live part another tab sent", () => {
  const seeded = { activity: STEP, characters: 120, preview: "The keeper climbed", callSeq: 3, trying: TRYING };

  it("shows it at once when it follows no step of the book, with the candidate", () => {
    useAutopilotStore.setState({ live: {} });
    useAutopilotStore.getState().seedLive(BOOK.id, seeded);
    expect(live()?.trying).toEqual(TRYING);
    expect(live()?.preview).toBe("The keeper climbed");
    expect(live()?.callSeq).toBe(3);
  });

  it("keeps what it follows: the events it heard are newer than the answer", () => {
    useAutopilotStore.setState({ live: { [BOOK.id]: { activity: STEP, characters: 500, preview: "newer", callSeq: 4 } } });
    useAutopilotStore.getState().seedLive(BOOK.id, seeded);
    expect(live()?.preview).toBe("newer");
    expect(live()?.trying).toBeUndefined();
  });

  it("keeps nothing of a step that is over (its end was heard), of a part that is not a step, or of what is not a live part", () => {
    useAutopilotStore.setState({ live: {}, feed: [{ event: eventOf({ type: "task-finished", activity: { ...STEP, status: "succeeded" } }, 5), bookTitle: BOOK.name }] });
    useAutopilotStore.getState().seedLive(BOOK.id, seeded);
    expect(live()).toBeUndefined();
    useAutopilotStore.setState({ feed: [] });
    useAutopilotStore.getState().seedLive(BOOK.id, { activity: { ...STEP, status: "succeeded" }, characters: 1, preview: "x" });
    useAutopilotStore.getState().seedLive(BOOK.id, "nonsense");
    useAutopilotStore.getState().seedLive(BOOK.id, null);
    expect(live()).toBeUndefined();
  });

  it("reads the live part as any live part from elsewhere: a candidate that does not say which it is, or a model of a page, is cut", () => {
    useAutopilotStore.setState({ live: {} });
    useAutopilotStore.getState().seedLive(BOOK.id, { ...seeded, trying: { ...TRYING, model: "m".repeat(400), fallback: false } });
    expect(live()?.trying?.model).toHaveLength(160);
    expect(live()?.trying?.fallback).toBe(true);
    useAutopilotStore.setState({ live: {} });
    useAutopilotStore.getState().seedLive(BOOK.id, { ...seeded, trying: { attempt: 1 } });
    expect(live()?.trying).toBeUndefined();
    expect(live()?.preview).toBe("The keeper climbed");
  });
});
