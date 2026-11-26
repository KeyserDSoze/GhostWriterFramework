import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import { ServerRequestError, type AiPort, type AiRequest, type AutopilotMessageCode, type AutopilotStatus } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, ai: null as unknown, publish: vi.fn(async (..._args: unknown[]) => ({ committed: 1, pulled: 0 })), save: vi.fn(async () => true) }));

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
import { isHandoverConsentError } from "@/autopilot/handover";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";
import { dropSyncBaseDatabase } from "./helpers/rawSyncBase";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const GITHUB_BOOK: BookEntry = { ...BOOK, storageMode: "github", owner: "acme", repo: "glass-harbor" };
const CONNECTION = { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN };
const BRIEF = { idea: "A harbor built on glass hides a lie.", wordsPerScene: 300 };
const OPTIONS = { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false };

let runtime: BrowserAutopilotRuntime;
let server: FakeBookServer;
let local: MemoryBookStore;
let gate: { hold: Promise<void> | null; release: () => void };
let seq = 0;

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
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  gate.hold = promise;
  gate.release = () => { gate.hold = null; release(); };
  return gate.release;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];
const view = () => useAutopilotStore.getState().views[BOOK.id];
const plan = () => view()?.handover ?? null;
const hostOf = () => useSettingsStore.getState().settings.books[0].autopilotHost ?? "browser";
const untilPhase = (phase: string) => vi.waitFor(() => expect(plan()?.phase, `the plan is ${plan()?.phase}`).toBe(phase), { timeout: 20_000 });
const idle = () => vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 });

/** The server says, in its live stream, that the run of the book ended. */
function serverRunEnds(status: AutopilotStatus, message: string | null, code?: AutopilotMessageCode) {
  server.stop(status, message);
  seq += 1;
  runtime.onServerMessage({ event: "autopilot", data: { bookId: BOOK.id, at: new Date().toISOString(), seq, type: "run-ended", runId: "run-server", status, message, ...(code ? { code } : {}) } });
}

function useBook(book: BookEntry) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], aiIntegrations: [{ id: "ai-1" } as never], defaultGitHubToken: "ghp_token", personalServer: CONNECTION } });
}

async function startLocalRun(book: BookEntry = BOOK) {
  const release = hold();
  await runtime.start(book.id, { brief: BRIEF, options: OPTIONS });
  return release;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(async () => {
  await dropSyncBaseDatabase();
  localStorage.clear();
  seq = 0;
  server = new FakeBookServer();
  local = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  gate = { hold: null, release: () => undefined };
  mocks.server = server;
  mocks.local = local;
  mocks.ai = gatedAi();
  mocks.publish.mockClear();
  mocks.save.mockClear();
  const locks = new FakeLockRegistry().forTab("this-tab") as never;
  installNavigatorLocks(locks);
  runtime = new BrowserAutopilotRuntime({ locks: () => locks, channel: () => null, handover: { pollMs: 40, doneVisibleMs: 60_000 } });
  useBook(BOOK);
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id) }, summaries: {}, live: {}, feed: [], server: { status: "online", info: null, message: null, books: [], updates: null, connection: CONNECTION } });
});

afterEach(async () => {
  cleanup();
  await runtime.pause(BOOK.id, "now").catch(() => undefined);
  gate.release();
  await vi.waitFor(() => expect(runtime.isRunningHere(BOOK.id)).toBe(false), { timeout: 20_000 }).catch(() => undefined);
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  runtime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [], server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("browser → server", () => {
  it("moves a book that is stopped, makes the server its host, keeps the setting, and does not start it", async () => {
    local.write("book.md", "the book");
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await untilPhase("done");
    expect(hostOf()).toBe("server");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(server.registered).toHaveLength(1);
    expect(server.store.files.get("book.md")).toBe("the book");
    expect(server.started).toEqual([]);
    expect(view().server).not.toBeNull();
    // The consents were not asked again, and no secret was sent: the server already had what it needs.
    expect(server.registered[0].input).not.toHaveProperty("githubToken");
    expect(server.count("putAiConfig")).toBe(0);
  });

  it("waits for the end of the step of a run, pauses it there, moves the book and goes on on the server", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    expect(plan()).toMatchObject({ to: "server", when: "after-step", phase: "armed" });
    expect(useAutopilotStore.getState().summaries[BOOK.id]?.pausePending).toBe("after-step");
    // The step is still in flight: nothing moved, nothing started anywhere else.
    expect(server.registered).toEqual([]);
    expect(server.started).toEqual([]);

    release();
    await untilPhase("done");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
    expect(hostOf()).toBe("server");
    expect(server.started).toEqual([{}]);
    expect(server.running).toBe(true);
  });

  it("now: abandons the request in flight, and goes on on the server with the step done again there", async () => {
    await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server", when: "now" }, { saveSettings: mocks.save });
    await untilPhase("done");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
    expect(server.started).toEqual([{}]);
    expect(hostOf()).toBe("server");
  });

  it("can be taken back while it waits: the pause it asked for is taken back, and the run goes on here", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    expect(await runtime.cancelHandover(BOOK.id)).toBe(true);
    expect(plan()).toBeNull();
    expect(useAutopilotStore.getState().summaries[BOOK.id]?.pausePending).toBeNull();
    release();
    // Nothing asked it to stop: it goes on to the end of the book, here.
    await idle();
    const ends = useAutopilotStore.getState().feed.map((entry) => entry.event).filter((event) => event.type === "run-ended");
    expect(last(ends)).toMatchObject({ status: "completed" });
    expect(server.registered).toEqual([]);
    expect(hostOf()).toBe("browser");
  });

  it("is taken back when the author stops the run now: the autopilot is not started on the other side after they stopped it", async () => {
    await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await runtime.pause(BOOK.id, "now");
    expect(plan()).toBeNull();
    await idle();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(server.registered).toEqual([]);
    expect(server.started).toEqual([]);
    expect(hostOf()).toBe("browser");
  });

  it("is taken back when the author takes back the pause: nothing is left waiting for a pause that is not asked for", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await runtime.pause(BOOK.id, "cancel");
    expect(plan()).toBeNull();
    expect(useAutopilotStore.getState().summaries[BOOK.id]?.pausePending ?? null).toBeNull();
    release();
    await idle();
    expect(server.registered).toEqual([]);
  });

  it("is not taken back by a pause that is not a stop: the author may ask for more", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await runtime.pause(BOOK.id, "after-chapter");
    expect(plan()?.phase).toBe("armed");
    release();
    await untilPhase("done");
  });

  it("stops where it is, with the reason, when files changed on both sides: the run is not resumed, nothing is lost", async () => {
    server.store.write("plot.md", "plot, written on the server");
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    release();
    await untilPhase("failed");
    expect(plan()?.error).toBe(t("autopilot.errors.conflictsMoveToServer", { count: 1 }));
    expect(view().sync).toMatchObject({ kind: "conflicts", conflicts: ["plot.md"] });
    expect(hostOf()).toBe("browser");
    expect(server.started).toEqual([]);
    expect(server.store.files.get("plot.md")).toBe("plot, written on the server");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("waits a moment for the lock of the book when the run that has just ended has not let it go yet", async () => {
    // Another holder of the book's lock lets it go a little after the plan wanted to move the book.
    const registry = new FakeLockRegistry();
    const here = registry.forTab("this-tab") as never;
    installNavigatorLocks(here);
    runtime = new BrowserAutopilotRuntime({ locks: () => here, channel: () => null, handover: { pollMs: 40, doneVisibleMs: 60_000 } });
    let letGo: () => void = () => undefined;
    void registry.forTab("other-tab").request(`narrarium:autopilot:${BOOK.id}`, () => new Promise<void>((resolve) => { letGo = resolve; }));
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(plan()?.phase).toBe("moving");
    letGo();
    await untilPhase("done");
    expect(hostOf()).toBe("server");
  });

  it("gives up, saying that another tab holds the book, when the lock is not let go", async () => {
    const registry = new FakeLockRegistry();
    const here = registry.forTab("this-tab") as never;
    installNavigatorLocks(here);
    runtime = new BrowserAutopilotRuntime({ locks: () => here, channel: () => null, handover: { pollMs: 40, doneVisibleMs: 60_000 } });
    void registry.forTab("other-tab").request(`narrarium:autopilot:${BOOK.id}`, () => new Promise<void>(() => undefined));
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await untilPhase("failed");
    expect(plan()?.error).toBe(t("autopilot.errors.busyWith.otherTab"));
    expect(hostOf()).toBe("browser");
  });

  it("is refused, and pauses nothing, when the server cannot be reached", async () => {
    await startLocalRun();
    server.failures.aiStatus = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    await expect(runtime.armHandover(BOOK.id, { to: "server" })).rejects.toMatchObject({ code: "unreachable" });
    expect(plan()).toBeNull();
    expect(useAutopilotStore.getState().summaries[BOOK.id]?.pausePending ?? null).toBeNull();
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
  });

  it("is refused while another operation holds the book, with the message of that operation", async () => {
    await startLocalRun();
    let release: () => void = () => undefined;
    server.gates.manifest = new Promise<void>((resolve) => { release = resolve; });
    const syncing = runtime.syncWithServer(BOOK.id);
    try {
      await vi.waitFor(() => expect(server.count("manifest")).toBeGreaterThan(0));
      const refused = await runtime.armHandover(BOOK.id, { to: "server" }).catch((error: unknown) => error);
      expect((refused as Error).name).toBe("AutopilotOperationBusyError");
      expect((refused as Error).message).toBe(t("autopilot.errors.busyWith.sync"));
      expect(plan()).toBeNull();
      expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    } finally {
      release();
      await syncing.catch(() => undefined);
    }
  });

  it("fails, and leaves the book here and stopped, when another operation takes the book while the step ends", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    let free: () => void = () => undefined;
    server.gates.manifest = new Promise<void>((resolve) => { free = resolve; });
    const syncing = runtime.syncWithServer(BOOK.id);
    try {
      await vi.waitFor(() => expect(server.count("manifest")).toBeGreaterThan(0));
      release();
      await untilPhase("failed");
      expect(plan()?.error).toBe(t("autopilot.errors.busyWith.sync"));
      expect(hostOf()).toBe("browser");
      expect(runtime.isRunningHere(BOOK.id)).toBe(false);
      expect(server.started).toEqual([]);
    } finally {
      free();
      await syncing.catch(() => undefined);
    }
  });

  it("is refused, saying what is missing, when the server does not have the AI configuration: a handover never sends keys by itself", async () => {
    await startLocalRun();
    server.aiConfigured = false;
    const refused = await runtime.armHandover(BOOK.id, { to: "server" }).catch((error: unknown) => error);
    expect(isHandoverConsentError(refused)).toBe(true);
    expect((refused as { missing: string }).missing).toBe("ai");
    expect((refused as Error).message).toBe(t("autopilot.quick.handover.consent.ai"));
    expect(server.count("putAiConfig")).toBe(0);
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    expect(plan()).toBeNull();
  });

  it("is refused, saying what is missing, when the server does not have the GitHub token of a GitHub book", async () => {
    useBook(GITHUB_BOOK);
    server.hasGithubToken = false;
    const refused = await runtime.armHandover(GITHUB_BOOK.id, { to: "server" }).catch((error: unknown) => error);
    expect(isHandoverConsentError(refused)).toBe(true);
    expect((refused as { missing: string }).missing).toBe("github");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("moves a GitHub book to a server that already holds its token, publishing it first and sending no token", async () => {
    useBook(GITHUB_BOOK);
    useAutopilotStore.getState().patchView(GITHUB_BOOK.id, { server: { ...server.summary(GITHUB_BOOK.id), hasGithubToken: true } });
    await runtime.armHandover(GITHUB_BOOK.id, { to: "server" }, { saveSettings: mocks.save });
    await vi.waitFor(() => expect(useAutopilotStore.getState().views[GITHUB_BOOK.id].handover?.phase).toBe("done"));
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(server.registered[0].input).toMatchObject({ storage: { kind: "github", owner: "acme", repo: "glass-harbor" } });
    expect(server.registered[0].input).not.toHaveProperty("githubToken");
  });
});

describe("server → browser", () => {
  beforeEach(() => {
    useBook({ ...BOOK, autopilotHost: "server" });
    server.running = true;
    useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
  });

  it("asks the server to pause after the step, waits for the end of the run it hears, brings the work back, and goes on here", async () => {
    server.store.write("chapters/001/001-scene.md", "written by the autopilot on the server");
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    expect(plan()).toMatchObject({ to: "browser", phase: "armed" });
    expect(server.paused).toEqual(["after-step"]);
    // The server is still running its step: the book stays where it is.
    expect(server.count("readFiles")).toBe(0);

    hold();
    serverRunEnds("paused", null);
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(local.files.get("chapters/001/001-scene.md")).toBe("written by the autopilot on the server");
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    expect(view().server).toBeNull();
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("goes on here when the run ended by the pause that was asked, even if the download of that moment calls the stop an interruption", async () => {
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    expect(server.paused).toEqual(["after-step"]);
    hold();
    // A server that reads its state while the run ends can call the stop an interruption in what it answers (the engine that fixed it is 0.1.6);
    // the event the run announced as it ended says how it ended.
    server.stop("paused", "Interrupted: resume to continue from the last saved step.");
    seq += 1;
    runtime.onServerMessage({ event: "autopilot", data: { bookId: BOOK.id, at: new Date().toISOString(), seq, type: "run-ended", runId: "run-server", status: "paused", message: null } });
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
  });

  it("does not go on when the event the run announced says it stopped for another reason, whatever the download says", async () => {
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    hold();
    server.stop("paused", null);
    seq += 1;
    runtime.onServerMessage({ event: "autopilot", data: { bookId: BOOK.id, at: new Date().toISOString(), seq, type: "run-ended", runId: "run-server", status: "paused", message: "Budget reached: raise the limit to continue." } });
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
  });

  it("notices the end of the run by looking, when the live connection lost the event", async () => {
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    hold();
    server.stop("paused", null);
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
  });

  it("does not wait for a pause that nobody carries out: the run ended by itself, and the book comes back stopped", async () => {
    server.onPause = () => server.stop("completed", "The book is complete.");
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
  });

  it("asks nothing of the server, and keeps the book there, when it cannot be reached to start", async () => {
    server.failures.autopilot = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    await expect(runtime.armHandover(BOOK.id, { to: "browser" })).rejects.toBeTruthy();
    expect(server.paused).toEqual([]);
    expect(hostOf()).toBe("server");
    expect(plan()).toBeNull();
  });

  it("fails when the server goes away while it waits for the run to end", async () => {
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    server.failures.autopilot = new ServerRequestError("The personal server is not reachable.", 0, "unreachable");
    await untilPhase("failed");
    expect(plan()?.error).toBe(t("autopilot.serverOffline"));
    expect(hostOf()).toBe("server");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("brings the book back stopped when it was stopped, and asks for no pause", async () => {
    server.running = false;
    await runtime.armHandover(BOOK.id, { to: "browser" }, { saveSettings: mocks.save });
    await untilPhase("done");
    expect(server.paused).toEqual([]);
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
  });
});

describe("one step on the other side, and back", () => {
  it("browser → server → browser: the step runs on the server with that limit, the book comes back, and the run goes on here", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server", returnAfterSteps: 1 }, { saveSettings: mocks.save });
    release();
    await untilPhase("running-there");
    expect(server.started).toEqual([{ limits: { steps: 1 } }]);
    expect(hostOf()).toBe("server");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);

    hold();
    serverRunEnds("paused", "Step done as requested: paused.", "stepLimit");
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(server.started).toHaveLength(1);
  });

  it("server → browser → server: one step here with that limit, then the book goes back to the server and the run goes on there", async () => {
    useBook({ ...BOOK, autopilotHost: "server" });
    server.running = true;
    useAutopilotStore.getState().patchView(BOOK.id, { server: server.summary(BOOK.id) });
    await runtime.armHandover(BOOK.id, { to: "browser", returnAfterSteps: 1 }, { saveSettings: mocks.save });
    serverRunEnds("paused", null);
    await untilPhase("done");
    // The one step ran here, with its limit (the engine says so when the run ends), and the book is on the server again, running.
    const ends = useAutopilotStore.getState().feed.map((entry) => entry.event).filter((event) => event.type === "run-ended");
    expect(ends.map((event) => (event as { code?: string }).code)).toContain("stepLimit");
    expect(useAutopilotStore.getState().feed.filter((entry) => entry.event.type === "task-finished")).toHaveLength(1);
    expect(hostOf()).toBe("server");
    expect(server.started).toEqual([{}]);
    expect(server.running).toBe(true);
  });

  it("is refused for a server that predates the quick controls, before anything is paused: the step would not stop", async () => {
    const release = await startLocalRun();
    server.controls = false;
    const refused = await runtime.armHandover(BOOK.id, { to: "server", returnAfterSteps: 1 }).catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotControlsUnsupportedError");
    expect(useAutopilotStore.getState().summaries[BOOK.id]?.pausePending ?? null).toBeNull();
    expect(runtime.isRunningHere(BOOK.id)).toBe(true);
    release();
  });

  it("goes back without going on when the step on the server ended with a question for the author", async () => {
    const release = await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server", returnAfterSteps: 1 }, { saveSettings: mocks.save });
    release();
    await untilPhase("running-there");
    serverRunEnds("waiting-author", "The director has a question.");
    await untilPhase("done");
    expect(hostOf()).toBe("browser");
    expect(runtime.isRunningHere(BOOK.id)).toBe(false);
  });
});

describe("the plans of a view", () => {
  it("keep a plan that is done for a while and then close it, and keep a failed one until it is closed", async () => {
    server.store.write("plot.md", "plot, written on the server");
    await runtime.armHandover(BOOK.id, { to: "server" });
    await untilPhase("failed");
    runtime.dismissHandover(BOOK.id);
    expect(plan()).toBeNull();
  });

  it("does not make a second plan for the same book while one goes on", async () => {
    await startLocalRun();
    await runtime.armHandover(BOOK.id, { to: "server" });
    await act(async () => { await expect(runtime.armHandover(BOOK.id, { to: "server" })).rejects.toMatchObject({ name: "HandoverRefusedError", reason: "in-progress" }); });
  });
});
