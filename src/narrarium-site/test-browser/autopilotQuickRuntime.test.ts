import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import type { AiPort, AiRequest, AutopilotEvent } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, ai: null as unknown, publish: vi.fn(async (..._args: unknown[]) => ({ committed: 1, pulled: 0 })) }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/autopilot/browserAi", () => ({ createBrowserAi: () => mocks.ai }));
vi.mock("@/repository/repositoryService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/repository/repositoryService")>()),
  syncFullRepository: (...args: unknown[]) => mocks.publish(...args),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { markGitHubCredentialRejected } from "@/github/remoteAvailability";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const GITHUB_BOOK: BookEntry = { ...BOOK, storageMode: "github", owner: "acme", repo: "glass-harbor" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;
let local: MemoryBookStore;
let gate: { hold: Promise<void> | null; release: () => void };

/** The engine's deterministic fake AI, which can be held back: a request waits for the gate, and a pause that abandons it is heard. */
function gatedAi(): AiPort {
  const inner = createFakeAutopilotAi({ chapters: 1, scenes: 1, words: 120 });
  return { async complete(request: AiRequest) {
    const held = gate.hold;
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

function hold(): () => void {
  gate.hold = new Promise<void>((resolve) => { gate.release = () => { gate.hold = null; resolve(); }; });
  return gate.release;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const summary = (bookId = BOOK.id) => useAutopilotStore.getState().summaries[bookId];
const feed = () => useAutopilotStore.getState().feed.map((entry) => entry.event);
const ended = () => feed().filter((event): event is Extract<AutopilotEvent, { type: "run-ended" }> => event.type === "run-ended");
const stopped = () => vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 5000 });
const savedState = () => JSON.parse(local.files.get("autopilot/state.json") ?? "null");

function useBook(book: BookEntry, patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never], defaultGitHubToken: "ghp_token", personalServer: CONNECTION, ...patch } });
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  localStorage.clear();
  server = new FakeBookServer();
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  gate = { hold: null, release: () => undefined };
  mocks.server = server;
  mocks.local = local;
  mocks.ai = gatedAi();
  mocks.publish.mockClear();
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  // A runtime of its own for each test: it keeps the sessions of the books it ran, with the stores they were made with.
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null });
  useBook(BOOK);
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  gate.release();
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 3000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  runtime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("the pause of a run in this browser", () => {
  it("asks the session to pause after the step, and the live summary says it is waiting", async () => {
    const release = hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.pause(BOOK.id, "after-step");
    expect(summary()?.pausePending).toBe("after-step");
    release();
    await stopped();
    expect(last(ended())).toMatchObject({ status: "paused" });
    expect(savedState().status).toBe("paused");
  });

  it("asks it to pause at the end of the chapter, which the summary tells apart from the other pause", async () => {
    const release = hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.pause(BOOK.id, "after-chapter");
    expect(summary()?.pausePending).toBe("after-chapter");
    release();
    await stopped();
  });

  it("takes back a pause that waits without stopping anything", async () => {
    const release = hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.pause(BOOK.id, "after-step");
    expect(summary()?.pausePending).toBe("after-step");
    await runtime.pause(BOOK.id, "cancel");
    expect(summary()?.pausePending).toBeNull();
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    release();
    await act(async () => { await runtime.pause(BOOK.id, "now"); });
    await stopped();
  });

  it("stops the request in flight with `now`", async () => {
    hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.pause(BOOK.id, "now");
    await stopped();
    expect(savedState().status).toBe("paused");
  });

  it("does nothing, and does not fail, when nothing runs", async () => {
    await expect(runtime.pause(BOOK.id, "after-chapter")).resolves.toBeUndefined();
    await expect(runtime.pause(BOOK.id, "cancel")).resolves.toBeUndefined();
  });
});

describe("the limits of one run in this browser", () => {
  it("runs one step and pauses, with the reason the engine gives, and keeps the limit out of the saved state", async () => {
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 1 } });
    await stopped();
    const finished = feed().filter((event) => event.type === "task-finished");
    expect(finished).toHaveLength(1);
    expect(last(ended())).toMatchObject({ status: "paused", code: "stepLimit" });
    expect(JSON.stringify(savedState())).not.toContain("limits");
    // The next run has no limit unless it asks.
    expect(summary()?.limits ?? null).toBeNull();
  });

  it("runOne('step') is a run limited to one step, again and again", async () => {
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 1 } });
    await stopped();
    for (let round = 2; round <= 3; round += 1) {
      await runtime.runOne(BOOK.id, "step");
      await stopped();
      expect(feed().filter((event) => event.type === "task-finished")).toHaveLength(round);
    }
    expect(ended().map((event) => event.code)).toEqual(["stepLimit", "stepLimit", "stepLimit"]);
  });

  it("runOne('chapter') runs until one chapter is completed, and says so", async () => {
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 1 } });
    await stopped();
    await runtime.runOne(BOOK.id, "chapter");
    await stopped();
    expect(last(ended())).toMatchObject({ status: "paused", code: "chapterLimit" });
    const closed = feed().filter((event) => event.type === "task-finished" && event.activity.task === "consolidate");
    expect(closed).toHaveLength(1);
  });

  it("shows the limits of the run while it goes on", async () => {
    const release = hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS, limits: { steps: 5 } });
    await vi.waitFor(() => expect(summary()?.limits).toMatchObject({ steps: 5, stepsDone: 0 }));
    release();
    await act(async () => { await runtime.pause(BOOK.id, "now"); });
    await stopped();
  });
});

describe("the pause of a run on the server", () => {
  beforeEach(() => {
    useBook(SERVER_BOOK);
    server.running = true;
  });

  it.each(["now", "after-step", "after-chapter", "cancel"] as const)("sends `%s` to a server that has the quick controls", async (mode) => {
    await runtime.pause(BOOK.id, mode);
    expect(server.paused).toEqual([mode]);
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.bookId).toBe(BOOK.id);
  });

  it("keeps the snapshot the server answers, with the pause that waits", async () => {
    await runtime.pause(BOOK.id, "after-chapter");
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.summary?.pausePending).toBe("after-chapter");
    await runtime.pause(BOOK.id, "cancel");
    expect(useAutopilotStore.getState().views[BOOK.id].snapshot?.summary?.pausePending).toBeNull();
  });

  it("refuses `after-chapter` and `cancel` for a server that predates them, and sends nothing: it would read them as `after-step`", async () => {
    server.controls = false;
    for (const mode of ["after-chapter", "cancel"] as const) {
      const refused = await runtime.pause(BOOK.id, mode).catch((error: unknown) => error);
      expect((refused as Error).name).toBe("AutopilotControlsUnsupportedError");
      expect(runtime.describeError(refused)).toBe(t("autopilot.errors.controlsUnsupported", { version: "0.1.5" }));
      expect(runtime.describeError(refused)).not.toBe("autopilot.errors.controlsUnsupported");
    }
    expect(server.paused).toEqual([]);
    await runtime.pause(BOOK.id, "after-step");
    await runtime.pause(BOOK.id, "now");
    expect(server.paused).toEqual(["after-step", "now"]);
  });
});

describe("the limits of a run on the server", () => {
  beforeEach(() => useBook(SERVER_BOOK));

  it("hands them to the server with the start", async () => {
    await runtime.start(BOOK.id, { limits: { steps: 3 } });
    expect(server.started).toEqual([{ limits: { steps: 3 } }]);
    expect(server.limits).toEqual({ steps: 3 });
  });

  it("runOne('step') and runOne('chapter') start with one step, or one chapter, as the limit", async () => {
    await runtime.runOne(BOOK.id, "step");
    expect(last(server.started)).toEqual({ limits: { steps: 1 } });
    server.stop();
    await runtime.runOne(BOOK.id, "chapter");
    expect(last(server.started)).toEqual({ limits: { chapters: 1 } });
  });

  it("does not start a run with a limit on a server that would ignore it: the run would not stop, and would go on spending", async () => {
    server.controls = false;
    const refused = await runtime.runOne(BOOK.id, "step").catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotControlsUnsupportedError");
    expect(server.started).toEqual([]);
    expect(server.running).toBe(false);
    // Nothing of the book was handed over either: the server is checked before anything is sent to it.
    expect(server.count("commitFiles")).toBe(0);
    await expect(runtime.start(BOOK.id, { limits: { steps: 0 } })).resolves.toBeUndefined();
  });

  it("still starts a run without a limit on a server that predates the controls", async () => {
    server.controls = false;
    await runtime.start(BOOK.id);
    expect(server.started).toEqual([{}]);
  });
});

describe("the options that change while a run goes on", () => {
  it("are saved in the browser's state, and the live summary says where the book is published now", async () => {
    useBook(GITHUB_BOOK);
    const release = hold();
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: OPTIONS });
    await runtime.updateOptions(GITHUB_BOOK.id, { publishEvery: "step" });
    expect(savedState().options.publishEvery).toBe("step");
    expect(summary()?.publish).toBe("step");
    await runtime.updateOptions(GITHUB_BOOK.id, { publishEvery: "off" });
    expect(summary()?.publish).toBe("off");
    release();
    await act(async () => { await runtime.pause(GITHUB_BOOK.id, "now"); });
    await stopped();
  });

  it("refuses an option that only a stopped autopilot can change, as `configure` does", async () => {
    const release = hold();
    await runtime.start(BOOK.id, { brief: BRIEF, options: OPTIONS });
    await expect(runtime.updateOptions(BOOK.id, { budgetLimit: 3 } as never)).rejects.toMatchObject({ name: "AutopilotBusyError" });
    release();
    await act(async () => { await runtime.pause(BOOK.id, "now"); });
    await stopped();
  });

  it("go to the server for a book it runs, when the server has the quick controls", async () => {
    useBook(SERVER_BOOK);
    await runtime.updateOptions(BOOK.id, { publishEvery: "chapter" });
    expect(server.optionsUpdated).toEqual([{ publishEvery: "chapter" }]);
    await runtime.updateOptions(BOOK.id, { publishEvery: null });
    expect(last(server.optionsUpdated)).toEqual({ publishEvery: null });
  });

  it("are not sent to a server that does not know them", async () => {
    useBook(SERVER_BOOK);
    server.controls = false;
    const refused = await runtime.updateOptions(BOOK.id, { publishEvery: "step" }).catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotControlsUnsupportedError");
    expect(server.optionsUpdated).toEqual([]);
  });

  it("are refused while another operation holds the book", async () => {
    useBook(SERVER_BOOK);
    let release: () => void = () => undefined;
    server.gates.manifest = new Promise<void>((resolve) => { release = resolve; });
    const syncing = runtime.syncWithServer(BOOK.id);
    try {
      await vi.waitFor(() => expect(server.count("manifest")).toBeGreaterThan(0));
      const refused = await runtime.updateOptions(BOOK.id, { publishEvery: "step" }).catch((error: unknown) => error);
      expect((refused as Error).name).toBe("AutopilotOperationBusyError");
    } finally {
      release();
      await syncing.catch(() => undefined);
    }
  });
});

describe("publishing from the browser while the autopilot runs", () => {
  const steps = () => feed().filter((event) => event.type === "task-finished" && event.activity.status === "succeeded").length;
  const chapters = () => feed().filter((event) => event.type === "task-finished" && event.activity.task === "consolidate").length;

  async function runWhole(publishEvery: "off" | "chapter" | "step") {
    useBook(GITHUB_BOOK);
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: { ...OPTIONS, publishEvery } });
    await vi.waitFor(() => expect(runtime.isRunningHere(GITHUB_BOOK.id)).toBe(false), { timeout: 5000 });
  }

  it("publishes after every step, and again when a chapter closes, when the author chose every step", async () => {
    await runWhole("step");
    expect(chapters()).toBe(1);
    expect(mocks.publish).toHaveBeenCalledTimes(steps() + chapters());
  });

  it("publishes when a chapter closes, and not after the other steps, when the author chose every chapter", async () => {
    await runWhole("chapter");
    expect(steps()).toBeGreaterThan(3);
    expect(mocks.publish).toHaveBeenCalledTimes(chapters());
  });

  it("publishes nothing when the author chose never", async () => {
    await runWhole("off");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("publishes nothing while the browser is offline: the commits wait on this device, and the run goes on to its end", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await runWhole("step");
    } finally {
      online.mockRestore();
    }
    expect(steps()).toBeGreaterThan(3);
    expect(chapters()).toBe(1);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(last(ended())?.status).not.toBe("error");
  });

  it("runs a GitHub book without a credential here to its end, and publishes nothing: its commits wait for a sync once GitHub is connected", async () => {
    useBook(GITHUB_BOOK, { defaultGitHubToken: "" });
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: { ...OPTIONS, publishEvery: "step" } });
    await vi.waitFor(() => expect(runtime.isRunningHere(GITHUB_BOOK.id)).toBe(false), { timeout: 5000 });
    expect(steps()).toBeGreaterThan(3);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(last(ended())?.status).not.toBe("error");
  });

  it("publishes nothing with a credential GitHub refused, and the run goes on to its end", async () => {
    markGitHubCredentialRejected("ghp_refused_by_github");
    useBook(GITHUB_BOOK, { defaultGitHubToken: "ghp_refused_by_github" });
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: { ...OPTIONS, publishEvery: "step" } });
    await vi.waitFor(() => expect(runtime.isRunningHere(GITHUB_BOOK.id)).toBe(false), { timeout: 5000 });
    expect(steps()).toBeGreaterThan(3);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(last(ended())?.status).not.toBe("error");
  });

  it("goes on as it always did without a choice: after every chapter when the older option says so", async () => {
    useBook(GITHUB_BOOK);
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: { ...OPTIONS, syncAfterChapter: true } });
    await vi.waitFor(() => expect(runtime.isRunningHere(GITHUB_BOOK.id)).toBe(false), { timeout: 5000 });
    expect(mocks.publish).toHaveBeenCalledTimes(chapters());
  });

  it("follows a change made during the run, from the next step", async () => {
    useBook(GITHUB_BOOK);
    const release = hold();
    await runtime.start(GITHUB_BOOK.id, { brief: BRIEF, options: { ...OPTIONS, publishEvery: "step" } });
    await runtime.updateOptions(GITHUB_BOOK.id, { publishEvery: "off" });
    release();
    await vi.waitFor(() => expect(runtime.isRunningHere(GITHUB_BOOK.id)).toBe(false), { timeout: 5000 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("publishing now", () => {
  it("publishes this browser's commits of a GitHub book that runs here, and says so", async () => {
    useBook(GITHUB_BOOK);
    const outcome = await runtime.publishNow(GITHUB_BOOK.id);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", repo: "glass-harbor", token: "ghp_token" }));
    expect(outcome).toMatchObject({ ok: true, kind: "published" });
    expect(useAutopilotStore.getState().views[GITHUB_BOOK.id].sync).toMatchObject({ kind: "published" });
  });

  it("asks for a token before anything is published", async () => {
    useBook(GITHUB_BOOK, { defaultGitHubToken: "" });
    const refused = await runtime.publishNow(GITHUB_BOOK.id).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "github-token" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("asks the server to publish its own work first, for a book the server runs, before this browser looks at what GitHub has", async () => {
    useBook({ ...GITHUB_BOOK, autopilotHost: "server" });
    // This browser has no working copy of the book in the test: what comes after the server's publication is not what is looked at here.
    await runtime.publishNow(GITHUB_BOOK.id).catch(() => undefined);
    expect(server.calls[0]).toBe("syncGitHub");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("is one operation of the book: a second one while it lasts is refused", async () => {
    useBook(SERVER_BOOK);
    let release: () => void = () => undefined;
    server.gates.syncGitHub = new Promise<void>((resolve) => { release = resolve; });
    useBook({ ...GITHUB_BOOK, autopilotHost: "server" });
    const first = runtime.publishNow(GITHUB_BOOK.id);
    try {
      await vi.waitFor(() => expect(server.count("syncGitHub")).toBe(1));
      const refused = await runtime.publishNow(GITHUB_BOOK.id).catch((error: unknown) => error);
      expect((refused as Error).name).toBe("AutopilotOperationBusyError");
    } finally {
      release();
      await first.catch(() => undefined);
    }
  });
});
