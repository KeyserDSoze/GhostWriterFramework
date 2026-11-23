import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { AiProviderError, type AiPort, type AiRequest, type AutopilotEvent, type AutopilotLongRetry } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, ai: null as unknown }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
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
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeBroadcastBus } from "./helpers/fakeBroadcastChannel";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

// «Retry now» and «Retry later» through the runtime of the site: in this browser with a real run of the engine (the waits are as long as a minute
// makes them, so that only «Retry now» ends them), in another tab of the same browser through the tab that runs the book, and on the personal server
// through the engine's client, which the fake server answers as the real one does.

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };
const LATER: AutopilotLongRetry = { everyMinutes: 60, cycles: 3 };
/** A quick wait of a minute at least, and a long one of hours: nothing ends them but «Retry now», a pause, or turning «Retry later» off. */
const SLOW = 60_000;

let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;
let local: MemoryBookStore;
let failures = 0;

/** The engine's fake AI, whose concept fails `times` times with an overloaded provider (503) before it works. */
function overloaded(times: number): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return { async complete(request: AiRequest) {
    request.signal?.throwIfAborted();
    if (request.label === "autopilot:concept" && failures < times) {
      failures += 1;
      throw new AiProviderError("openai m: HTTP 503 — overloaded", 503, true, { transient: true });
    }
    return inner.complete(request);
  } };
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const summary = (bookId = BOOK.id) => useAutopilotStore.getState().summaries[bookId];
const feed = () => useAutopilotStore.getState().feed.map((entry) => entry.event);
const insights = (code: string) => feed().filter((event) => event.type === "insight" && event.code === code);
const ended = () => feed().filter((event): event is Extract<AutopilotEvent, { type: "run-ended" }> => event.type === "run-ended");
const stopped = (on: BrowserAutopilotRuntime = runtime) => vi.waitFor(() => expect(on.isRunningHere(BOOK.id)).toBe(false), { timeout: 5000 });
const savedState = () => JSON.parse(local.files.get("autopilot/state.json") ?? "null");

/** Wait for the quick waits one after the other and skip each one: the counters are the engine's. */
async function skipQuickWaits(on: BrowserAutopilotRuntime = runtime) {
  for (const attempt of [1, 2, 3]) {
    await vi.waitFor(() => expect(summary()?.retry).toMatchObject({ attempt, retries: 3 }), { timeout: 5000 });
    expect(summary()?.retry?.longTerm, "a quick wait is not a restart").toBeUndefined();
    await expect(on.retryNow(BOOK.id)).resolves.toBe(true);
  }
}

function useBook(book: BookEntry) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never], personalServer: CONNECTION } });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  failures = 0;
  server = new FakeBookServer();
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  mocks.server = server;
  mocks.local = local;
  mocks.ai = overloaded(0);
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null, retryDelayMs: SLOW });
  useBook(BOOK);
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 3000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("«Retry now» in this browser, with a real run", () => {
  it("skips the quick waits and the wait of «Retry later», and the step that failed works after it", async () => {
    mocks.ai = overloaded(4);
    await runtime.start(BOOK.id, { brief: BRIEF, options: { ...OPTIONS, longRetry: LATER } });
    await skipQuickWaits();
    // The quick retries are used up: the run waits an hour (at this scale) for its first restart.
    await vi.waitFor(() => expect(summary()?.retry?.longTerm).toEqual({ cycle: 1, cycles: 3 }), { timeout: 5000 });
    expect(summary()?.retry).toMatchObject({ attempt: 3, retries: 3 });
    expect(Date.parse(summary()?.retry?.at ?? "") - Date.now()).toBeGreaterThan(SLOW);
    expect(last(insights("longRetryWait"))).toMatchObject({ cycle: 1, cycles: 3 });
    await expect(runtime.retryNow(BOOK.id)).resolves.toBe(true);
    // The attempt starts at once and works: the concept is written, and nothing waits any more.
    await vi.waitFor(() => expect(feed().some((event) => event.type === "task-finished" && event.activity.task === "concept" && event.activity.status === "succeeded")).toBe(true), { timeout: 5000 });
    expect(summary()?.retry).toBeUndefined();
    expect(insights("retrySkipped")).toHaveLength(4);
    expect(failures).toBe(4);
    // The book has one chapter in its Scaletta: once it is written the run is complete, and nothing is left to run.
    await vi.waitFor(() => expect(summary()?.status).toBe("completed"), { timeout: 5000 });
  });

  it("stops a run that waits for «Retry later» when it is turned off, with the failure and the code of the engine", async () => {
    mocks.ai = overloaded(Number.POSITIVE_INFINITY);
    await runtime.start(BOOK.id, { brief: BRIEF, options: { ...OPTIONS, longRetry: LATER } });
    await skipQuickWaits();
    await vi.waitFor(() => expect(summary()?.retry?.longTerm).toEqual({ cycle: 1, cycles: 3 }), { timeout: 5000 });
    await runtime.updateOptions(BOOK.id, { longRetry: null });
    await stopped();
    expect(last(ended())).toMatchObject({ status: "error", code: "longRetryOff" });
    expect(savedState().status).toBe("error");
    expect(savedState().options.longRetry).toBeUndefined();
    expect(summary()?.retry).toBeUndefined();
  });

  it("stops the run with the failure once the quick retries are used up, when «Retry later» is off: there is no long wait", async () => {
    mocks.ai = overloaded(Number.POSITIVE_INFINITY);
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await skipQuickWaits();
    await stopped();
    expect(last(ended())).toMatchObject({ status: "error" });
    expect(insights("longRetryWait")).toHaveLength(0);
  });

  it("answers false and changes nothing when nothing waits: no run, or a run that is not waiting", async () => {
    await expect(runtime.retryNow(BOOK.id)).resolves.toBe(false);
    mocks.ai = overloaded(1);
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await vi.waitFor(() => expect(summary()?.retry).toMatchObject({ attempt: 1 }), { timeout: 5000 });
    await expect(runtime.retryNow(BOOK.id)).resolves.toBe(true);
    await vi.waitFor(() => expect(summary()?.retry).toBeUndefined());
    await expect(runtime.retryNow(BOOK.id)).resolves.toBe(false);
    expect(insights("retrySkipped")).toHaveLength(1);
  });
});

describe("«Retry now» for a run in another tab of this browser", () => {
  it("is relayed to the tab that runs the book, which answers whether the wait was skipped", async () => {
    const bus = new FakeBroadcastBus();
    const locks = new FakeLockRegistry();
    const open = (name: string) => {
      const channel = bus.channel(name);
      return new BrowserAutopilotRuntime({ locks: () => locks.forTab(name) as never, channel: () => channel as never, retryDelayMs: SLOW });
    };
    const tabA = open("A");
    const tabB = open("B");
    try {
      mocks.ai = overloaded(1);
      await tabA.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
      await vi.waitFor(() => expect(summary()?.retry).toMatchObject({ attempt: 1 }), { timeout: 5000 });
      await expect(tabB.retryNow(BOOK.id)).resolves.toBe(true);
      const commands = bus.posted.filter((entry) => (entry.data as { kind?: string }).kind === "command").map((entry) => (entry.data as { command: unknown }).command);
      expect(commands).toEqual([{ type: "retry-now" }]);
      await vi.waitFor(() => expect(summary()?.retry).toBeUndefined());
      await expect(tabB.retryNow(BOOK.id), "nothing waits any more: the other tab says so").resolves.toBe(false);
    } finally {
      await tabA.pause(BOOK.id, "now").catch(() => undefined);
      await stopped(tabA).catch(() => undefined);
    }
  });
});

describe("«Retry now» and «Retry later» on the personal server", () => {
  beforeEach(() => {
    useBook(SERVER_BOOK);
    server.running = true;
  });

  it("asks a server that has them, and follows the snapshot it answers", async () => {
    server.retry = true;
    server.waiting = { at: new Date(Date.now() + 36_000).toISOString(), attempt: 1, retries: 3 };
    await expect(runtime.retryNow(BOOK.id)).resolves.toBe(true);
    expect(server.count("retryNow")).toBe(1);
    expect(summary()?.retry).toBeUndefined();
    await expect(runtime.retryNow(BOOK.id), "the server says nothing waited: no error").resolves.toBe(false);
  });

  it("sends nothing to a server that does not have them, and says to update it", async () => {
    server.waiting = { at: new Date(Date.now() + 36_000).toISOString(), attempt: 1, retries: 3 };
    await expect(runtime.retryNow(BOOK.id)).rejects.toThrow(t("autopilot.retry.oldServer", { version: "0.1.10" }));
    expect(server.count("retryNow")).toBe(0);
    await expect(runtime.updateOptions(BOOK.id, { longRetry: { everyMinutes: 10, cycles: 6 } })).rejects.toThrow(t("autopilot.retry.oldServer", { version: "0.1.10" }));
    expect(server.optionsUpdated).toEqual([]);
  });

  it("changes «Retry later» during a run on a server that has it, and turning it off stops a run that waits for it", async () => {
    server.retry = true;
    await runtime.updateOptions(BOOK.id, { longRetry: { everyMinutes: 10, cycles: 6 } });
    expect(server.optionsUpdated).toEqual([{ longRetry: { everyMinutes: 10, cycles: 6 } }]);
    server.waiting = { at: new Date(Date.now() + 600_000).toISOString(), attempt: 3, retries: 3, longTerm: { cycle: 1, cycles: 6 } };
    await runtime.updateOptions(BOOK.id, { longRetry: null });
    expect(server.running).toBe(false);
    expect(summary()?.status).toBe("error");
    expect(summary()?.retry).toBeUndefined();
  });

  it("saves the other settings on a server without it, as long as the author did not set «Retry later»", async () => {
    server.running = false;
    await runtime.configure(BOOK.id, { brief: BRIEF, options: OPTIONS });
    expect(server.configured).toHaveLength(1);
  });
});
