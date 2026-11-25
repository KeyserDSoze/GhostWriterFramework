import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import type { AiPort, AiRequest, AutopilotEvent } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ local: null as unknown, ai: null as unknown, workingCopy: true }));

vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  getExistingLocalBookStructure: async () => (mocks.workingCopy ? { meta: {}, structure: {} } : null),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { interruptedRuns, noteResume, recentResumes, setAutoResume } from "@/autopilot/resume";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { currentRepositoryScopeIdentity } from "@/repository/repositoryOperationScope";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

// The autopilot of this browser after the page ended in the middle of a run (a reload, an update, a browser closed): the intent the runtime keeps
// while a run goes on, and what a new page does with it. A page that ends is a runtime that stops without a word and a tab whose locks the browser
// releases; the new page is another runtime, in another tab, over the same working copy.

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const AI = { id: "ai-1", name: "Fake", provider: "openai", endpoint: "http://127.0.0.1:9/v1", apiKey: "sk-test", chatModels: [{ id: "m", name: "m", capabilities: ["autopilot"] }] };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let locks: FakeLockRegistry;
let local: MemoryBookStore;
let gate: { hold: Promise<void> | null; release: () => void; fail: (error: Error) => void; waiting: number };
const runtimes: BrowserAutopilotRuntime[] = [];

/** The engine's fake AI, which a test holds back: a request waits for the gate (the step in the middle of which the page ends). */
function gatedAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120, reviewVerdict: () => "approve" });
  return { async complete(request: AiRequest) {
    const held = gate.hold;
    if (held) {
      gate.waiting += 1;
      await new Promise<void>((resolve, reject) => {
        held.then(resolve, reject);
        const abandon = () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"));
        if (request.signal?.aborted) abandon();
        else request.signal?.addEventListener("abort", abandon, { once: true });
      });
    }
    request.signal?.throwIfAborted();
    return inner.complete(request);
  } };
}

function hold(): void {
  gate.hold = new Promise<void>((resolve, reject) => {
    gate.release = () => { gate.hold = null; resolve(); };
    gate.fail = (error) => { gate.hold = null; reject(error); };
  });
  gate.hold.catch(() => undefined);
}

/** A page of the app in a tab: its runtime, with the tab's locks. */
function page(tab: string): BrowserAutopilotRuntime {
  const runtime = new BrowserAutopilotRuntime({ locks: () => locks.forTab(tab) as never, channel: () => null });
  runtimes.push(runtime);
  return runtime;
}

const scope = () => currentRepositoryScopeIdentity();
const savedState = () => JSON.parse(local.files.get("autopilot/state.json") ?? "null");
const savedSteps = () => (JSON.parse(local.files.get("autopilot/activity.json") ?? "{\"activities\":[]}").activities as Array<{ task: string; status: string; chapterNumber?: number; sceneNumber?: number }>);
const feed = () => useAutopilotStore.getState().feed.map((entry) => entry.event);
const insights = () => feed().filter((event): event is Extract<AutopilotEvent, { type: "insight" }> => event.type === "insight").map((event) => event.code);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  locks = new FakeLockRegistry();
  installNavigatorLocks(locks.forTab("first") as never);
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  gate = { hold: null, release: () => undefined, fail: () => undefined, waiting: 0 };
  mocks.local = local;
  mocks.ai = gatedAi();
  mocks.workingCopy = true;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [AI as never] }, cloudLoaded: true });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [] });
});

afterEach(async () => {
  // A page that ended in a test is shown again for the next one.
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  gate.release();
  for (const runtime of runtimes.splice(0)) {
    await runtime.pause(BOOK.id, "now").catch(() => undefined);
    await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 5000 }).catch(() => undefined);
  }
  delete (navigator as { locks?: unknown }).locks;
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
});

/** A run of the first page, in the middle of a step when the page ends: its runtime goes quiet and the browser releases the tab's locks. */
async function interruptedRun(): Promise<void> {
  const first = page("first");
  hold();
  await first.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
  await vi.waitFor(() => expect(interruptedRuns(scope())[0]?.step).toBeTruthy());
  locks.closeTab("first");
}

describe("the intent that this browser runs the autopilot of a book", () => {
  it("is remembered when the author starts the run, keeps the step that runs, and goes when the run ends", async () => {
    const runtime = page("first");
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    expect(interruptedRuns(scope())).toEqual([expect.objectContaining({ bookId: BOOK.id, scope: scope() })]);
    await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 10_000 });
    expect(savedState().status).toBe("completed");
    expect(interruptedRuns(scope())).toEqual([]);
  });

  it("goes as soon as the author asks to pause, before the step ends, and comes back if they take the pause back", async () => {
    const runtime = page("first");
    hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.pause(BOOK.id, "after-step");
    expect(interruptedRuns(scope())).toEqual([]);
    await runtime.pause(BOOK.id, "cancel");
    expect(interruptedRuns(scope())).toHaveLength(1);
    await runtime.pause(BOOK.id, "now");
    await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false));
    expect(interruptedRuns(scope())).toEqual([]);
  });
});

describe("a page that ends in the middle of a step", () => {
  it("records nothing of the step it cuts off: no failure in the feed, in the other tabs or in the book, and the run stays to be resumed", async () => {
    const posted: unknown[] = [];
    const first = new BrowserAutopilotRuntime({ locks: () => locks.forTab("first") as never, channel: () => ({ postMessage: (message: unknown) => posted.push(message), addEventListener: () => undefined }) as never });
    runtimes.push(first);
    hold();
    await first.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    const saved = savedSteps().length;
    const shown = feed().length;
    const shared = posted.length;
    // The browser ends the page: `pagehide`, then the request in flight fails, as a reload makes it fail.
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    gate.fail(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(feed()).toHaveLength(shown);
    expect(posted).toHaveLength(shared);
    expect(savedSteps()).toHaveLength(saved);
    expect(savedState().status).toBe("running");
    expect(interruptedRuns(scope())).toHaveLength(1);
  });

  it("is a page that goes on when the browser only keeps it for later (the back/forward cache): what its run says is said", async () => {
    const first = page("first");
    hold();
    await first.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await vi.waitFor(() => expect(gate.waiting).toBe(1));
    const shown = feed().length;
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    gate.fail(new TypeError("Failed to fetch"));
    await vi.waitFor(() => expect(feed().slice(shown).some((event) => event.type === "call-ended")).toBe(true));
  });
});

describe("a new page, after the page ended in the middle of a run", () => {
  it("resumes the run by itself, which says so, goes on from what the book saved, and finishes without doing a step twice", async () => {
    await interruptedRun();
    expect(savedState()).toMatchObject({ status: "running" });
    gate.hold = null;
    const second = page("second");
    installNavigatorLocks(locks.forTab("second") as never);
    const [report] = await second.resumeInterrupted();
    expect(report.decision).toEqual({ kind: "resume" });
    expect(report.error).toBeUndefined();
    expect(insights()).toContain("resumedAfterRestart");
    await vi.waitFor(() => expect(second.isRunningHere(BOOK.id)).toBe(false), { timeout: 10_000 });
    expect(savedState().status).toBe("completed");
    const keys = savedSteps().filter((step) => step.status === "succeeded").map((step) => `${step.task}:${step.chapterNumber ?? ""}:${step.sceneNumber ?? ""}`);
    expect(keys.length).toBeGreaterThan(4);
    expect(new Set(keys).size).toBe(keys.length);
    expect(interruptedRuns(scope())).toEqual([]);
    expect(recentResumes(scope(), BOOK.id, Date.now())).toHaveLength(1);
  });

  it("does not start while another tab holds the book, and keeps the intent", async () => {
    await interruptedRun();
    // Another tab took the book meanwhile (it runs it, or resumed it first).
    void locks.forTab("other").request(`narrarium:autopilot:${BOOK.id}`, () => new Promise(() => undefined));
    const second = page("second");
    const [report] = await second.resumeInterrupted();
    expect(report.decision).toEqual({ kind: "skip", reason: "other-tab", forget: false });
    expect(second.isRunningHere(BOOK.id)).toBe(false);
    expect(interruptedRuns(scope())).toHaveLength(1);
  });

  it("stops after three automatic resumes in ten minutes, and leaves the run to the author", async () => {
    await interruptedRun();
    for (let index = 3; index > 0; index -= 1) noteResume(scope(), BOOK.id, Date.now() - index * 1000);
    const [report] = await page("second").resumeInterrupted();
    expect(report.decision).toEqual({ kind: "skip", reason: "crash-loop", forget: true });
    expect(interruptedRuns(scope())).toEqual([]);
    expect(savedState().status).toBe("running");
  });

  it("does nothing for a book whose author turned the resume off on this device, nor without its working copy or its AI", async () => {
    await interruptedRun();
    mocks.workingCopy = false;
    expect((await page("second").resumeInterrupted())[0].decision).toEqual({ kind: "skip", reason: "no-working-copy", forget: false });
    mocks.workingCopy = true;
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, aiIntegrations: [{ ...AI, apiKey: "" } as never] } });
    expect((await page("third").resumeInterrupted())[0].decision).toEqual({ kind: "skip", reason: "no-ai", forget: false });
    setAutoResume(BOOK.id, false);
    expect((await page("fourth").resumeInterrupted())[0].decision).toEqual({ kind: "skip", reason: "off", forget: true });
    expect(interruptedRuns(scope())).toEqual([]);
  });

  it("waits while the device is offline", async () => {
    await interruptedRun();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect((await page("second").resumeInterrupted())[0].decision).toEqual({ kind: "wait", reason: "offline" });
    expect(interruptedRuns(scope())).toHaveLength(1);
  });
});
