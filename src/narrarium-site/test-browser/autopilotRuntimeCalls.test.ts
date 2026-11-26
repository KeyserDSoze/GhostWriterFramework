import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";

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
import { ensureCallsHost, resetCallsHostForTests } from "@/autopilot/calls/host";
import { resetRecordingForTests, setRecording } from "@/autopilot/calls/recording";
import { callsWritesSettled, getAiCallStore, resetAiCallStoreForTests } from "@/autopilot/calls/wire";
import { callsCopier, configureCopyServices, resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { MemoryCopyLedger } from "@/autopilot/calls/copies/stores";
import type { CopyFile, CopyTarget } from "@/autopilot/calls/copies/types";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

// The browser's runtime with the records wired in: a step run in this browser is recorded in the browser's store for the account, the recording switch of the book is honoured at
// the next run, and a finished step is copied to the place the book has.

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let runtime: BrowserAutopilotRuntime;

const stopped = () => vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 });
const feed = () => useAutopilotStore.getState().feed.map((entry) => entry.event);

/** One step, run to its end, and what the browser's store holds of the book after the engine's writes are over. */
async function oneStep(first = false): Promise<void> {
  if (first) await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 1 } });
  else await runtime.runOne(BOOK.id, "step");
  await stopped();
  await callsWritesSettled();
}

async function tasksInStore() {
  const store = await getAiCallStore();
  return (await store!.listTasks(BOOK.id, { limit: 200 })).tasks;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  resetRecordingForTests();
  mocks.local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  mocks.ai = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK], aiIntegrations: [{ id: "ai-1" } as never], defaultGitHubToken: "ghp_token" } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 }).catch(() => undefined);
  await callsWritesSettled();
  delete (navigator as { locks?: unknown }).locks;
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  resetCallsHostForTests();
  (await getAiCallStore())?.close();
  resetAiCallStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-ai-calls");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  resetAiCallStoreForTests();
  localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("a step run in this browser", () => {
  it("is recorded in the browser's store, with what was sent and what came back, and the events of its calls reach the page", async () => {
    await oneStep(true);
    const [task] = await tasksInStore();
    expect(task).toMatchObject({ status: "done" });
    const kept = (await (await getAiCallStore())!.readTask(BOOK.id, task.activityId))!;
    expect(kept.calls.length).toBeGreaterThanOrEqual(1);
    const call = kept.calls[0];
    const store = (await getAiCallStore())!;
    expect((await store.readText(BOOK.id, call.callId, "system", 0))?.text.length).toBeGreaterThan(0);
    expect((await store.readText(BOOK.id, call.callId, "user", 0))?.text).toContain("harbor");
    expect(feed().some((event) => event.type === "call-started")).toBe(true);
    expect(feed().some((event) => event.type === "call-ended")).toBe(true);
  });

  it("is not recorded while the recording of the book is off on this device, from the next run on, and is again once it is back on", async () => {
    await oneStep(true);
    expect(await tasksInStore()).toHaveLength(1);
    setRecording(BOOK.id, false);
    await oneStep();
    expect(await tasksInStore(), "the second step was run with the recording off").toHaveLength(1);
    expect(feed().filter((event) => event.type === "task-finished")).toHaveLength(2);
    setRecording(BOOK.id, true);
    await oneStep();
    expect(await tasksInStore(), "and the third with it on").toHaveLength(2);
  });

  it("is run as it was without the records when the recording was off from the start: no event of a call, nothing in the store", async () => {
    setRecording(BOOK.id, false);
    await oneStep(true);
    expect(feed().some((event) => event.type === "call-started" || event.type === "call-ended")).toBe(false);
    expect(feed().filter((event) => event.type === "task-finished")).toHaveLength(1);
    expect(await tasksInStore()).toEqual([]);
  });

  it("is copied to the place the book has when it ends, with nothing done by the page", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, books: [{ ...BOOK, aiCallsCopy: "github" }] } });
    const written: CopyFile[] = [];
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => { arrive = resolve; });
    const target: CopyTarget = {
      kind: "github",
      prepare: async () => undefined,
      write: async (files, onWritten) => {
        for (const file of files) {
          written.push(file);
          await onWritten(file.taskId, file.bytes.length);
        }
        arrive();
      },
      removeDays: async () => undefined,
      removeAll: async () => undefined,
    };
    await ensureCallsHost();
    configureCopyServices({ openTarget: async () => target, ledger: new MemoryCopyLedger(), online: () => true });
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 1 } });
    await stopped();
    await callsWritesSettled();
    await arrived;
    const [task] = await tasksInStore();
    expect(written.map((file) => file.taskId)).toContain(task.activityId);
    expect(await callsCopier().status(BOOK.id, "github")).toMatchObject({ waiting: 0, copiedTasks: 1 });
  });
});

describe("the runtime's host", () => {
  it("makes the store and the copies ready on request, once, and a session that is made does the same", async () => {
    runtime.ensureCallsHost();
    expect(await ensureCallsHost()).not.toBeNull();
    expect(await ensureCallsHost()).toBe(await getAiCallStore());
  });
});
