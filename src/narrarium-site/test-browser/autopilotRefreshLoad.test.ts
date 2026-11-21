import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, type AutopilotEvent, type AutopilotSnapshot, type AutopilotStateSummary, type AutopilotStatus } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => ({ client: mocks.client, info: { serverId: "server-1" }, fingerprint: "f".repeat(64) }),
}));

import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { longPlan, planOf } from "./helpers/autopilotFixtures";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PIN = "f".repeat(64);
const STATS = { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 };

/** The runtime's two doors for what happens to a book: the live stream of the personal server, and the other tabs of this browser. */
const runtime = autopilotRuntime as unknown as {
  onServerMessage(message: { event: "autopilot"; data: AutopilotEvent }): void;
  afterEvent(bookId: string, event: AutopilotEvent, local: boolean): void;
  refresh(bookId: string, options?: { join?: boolean }): Promise<AutopilotSnapshot | null>;
};

let bookCount = 0;
let bookId = "";

/** A personal server that holds one book and counts how often its whole autopilot state is downloaded. */
class FakeServer {
  version = 0;
  status: AutopilotStatus = "running";
  readonly downloads: number[] = [];
  private inFlight = 0;
  mostInFlight = 0;

  constructor(readonly chapters: number, private readonly latencyMs = 0) {}

  async autopilot(id: string): Promise<AutopilotSnapshot> {
    this.downloads.push(Date.now());
    this.inFlight += 1;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    const seen = this.version;
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    this.inFlight -= 1;
    return { bookId: id, state: { ...createAutopilotState(new Date(T0)), status: this.status, phase: "write", plan: planOf(longPlan(this.chapters, Math.min(seen, this.chapters))), version: seen, updatedAt: new Date(T0 + seen * 1000).toISOString() }, activities: [], live: null, running: this.status === "running", host: "server" };
  }
}

function summaryOf(server: FakeServer, status: AutopilotStatus): AutopilotStateSummary {
  return { status, phase: "write", message: null, progress: { chapters: server.chapters, chaptersDone: server.version, scenes: 0, scenesWritten: 0, words: 0 }, question: null, lastError: null, runner: null, stats: { ...STATS, aiCalls: server.version }, pendingNotes: 0, constraints: 0, updatedAt: new Date(T0 + server.version * 1000).toISOString() };
}

type Door = "server" | "tab";

function newBook(server: FakeServer, host: "server" = "server") {
  bookCount += 1;
  bookId = `book-${bookCount}`;
  mocks.client = server;
  const book: BookEntry = { id: bookId, owner: "local", repo: bookId, name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: new Date(T0).toISOString(), autopilotHost: host };
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [bookId]: emptyView(bookId) }, summaries: {}, live: {}, feed: [] });
}

/** Everything a run does, as events: `steps` steps of `stepMs` each, then the end of the run. Returns how many events were sent. */
async function simulateRun(server: FakeServer, options: { steps: number; stepMs: number; door?: Door }): Promise<number> {
  const door = options.door ?? "server";
  let seq = 0;
  const emit = (body: Record<string, unknown>) => {
    seq += 1;
    const event = { bookId, at: new Date().toISOString(), seq, ...body } as AutopilotEvent;
    if (door === "server") runtime.onServerMessage({ event: "autopilot", data: event });
    else runtime.afterEvent(bookId, event, false);
  };
  const activity = (status: "running" | "succeeded") => ({ id: "activity-1", runId: "run-1", task: "write", phase: "write", title: "Writing a scene", reason: "", next: "", status, startedAt: new Date(T0).toISOString() });

  emit({ type: "run-started", runId: "run-1", host: "server" });
  emit({ type: "state", state: summaryOf(server, "running") });
  for (let step = 1; step <= options.steps; step += 1) {
    emit({ type: "task-started", activity: activity("running") });
    for (let chunk = 1; chunk <= 5; chunk += 1) emit({ type: "task-progress", activityId: "activity-1", characters: chunk * 100, preview: "text" });
    server.version = step;
    emit({ type: "task-finished", activity: activity("succeeded") });
    emit({ type: "state", state: summaryOf(server, "running") });
    await vi.advanceTimersByTimeAsync(options.stepMs);
  }
  server.status = "paused";
  server.version += 1;
  emit({ type: "state", state: summaryOf(server, "paused") });
  emit({ type: "run-ended", runId: "run-1", status: "paused", message: null });
  return seq;
}

const viewState = () => useAutopilotStore.getState().views[bookId]?.snapshot?.state ?? null;
const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  vi.spyOn(autopilotRuntime, "syncWithServer").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
});

describe("a run of 300 events on a book of 500 chapters hosted on the personal server", () => {
  it.each<Door>(["server", "tab"])("downloads the whole state no more than every four seconds (events from the %s)", async (door) => {
    const server = new FakeServer(500);
    newBook(server);
    const events = await simulateRun(server, { steps: 37, stepMs: 1500, door });
    expect(events).toBe(300);
    await vi.advanceTimersByTimeAsync(5000);

    // 55 seconds of run: before, one download for every step and for the start and the end.
    expect(server.downloads.length).toBeLessThanOrEqual(17);
    expect(server.downloads.length).toBeGreaterThanOrEqual(10);
    expect(Math.min(...gaps(server.downloads.slice(0, -1)))).toBeGreaterThanOrEqual(4000);
    expect(server.mostInFlight).toBe(1);
  });

  it("ends with the state the run ended in, whatever was in flight or waiting", async () => {
    const server = new FakeServer(500);
    newBook(server);
    await simulateRun(server, { steps: 37, stepMs: 1500 });
    const endedAt = Date.now();
    await vi.advanceTimersByTimeAsync(1000);

    expect(server.downloads[server.downloads.length - 1]).toBeGreaterThanOrEqual(endedAt);
    expect(viewState()?.status).toBe("paused");
    expect(viewState()?.version).toBe(38);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(viewState()?.version).toBe(38);
  });

  it("never has two downloads at once when the server is slower than the interval", async () => {
    const server = new FakeServer(500, 6000);
    newBook(server);
    await simulateRun(server, { steps: 37, stepMs: 1500 });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.mostInFlight).toBe(1);
    expect(viewState()?.version).toBe(38);
    expect(server.downloads.length).toBeLessThan(10);
  });

  it("does not download for 300 state events of a running book, and still shows what they carry", async () => {
    const server = new FakeServer(500);
    newBook(server);
    for (let index = 1; index <= 300; index += 1) {
      server.version = index;
      runtime.onServerMessage({ event: "autopilot", data: { bookId, at: new Date().toISOString(), seq: index, type: "state", state: summaryOf(server, "running") } });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.downloads).toHaveLength(0);
    expect(useAutopilotStore.getState().summaries[bookId]?.stats.aiCalls).toBe(300);
  });
});

describe("what else makes the page download the state", () => {
  it("is a state event that says the book is not running any more, once", async () => {
    const server = new FakeServer(500);
    newBook(server);
    server.status = "waiting-author";
    server.version = 3;
    for (let index = 0; index < 5; index += 1) runtime.onServerMessage({ event: "autopilot", data: { bookId, at: new Date().toISOString(), seq: index, type: "state", state: summaryOf(server, "waiting-author") } });
    await vi.advanceTimersByTimeAsync(499);
    expect(server.downloads).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(server.downloads).toHaveLength(1);
    expect(viewState()?.status).toBe("waiting-author");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.downloads).toHaveLength(1);
  });

  it("is the start of a run", async () => {
    const server = new FakeServer(500);
    newBook(server);
    runtime.onServerMessage({ event: "autopilot", data: { bookId, at: new Date().toISOString(), seq: 1, type: "run-started", runId: "run-1", host: "server" } });
    runtime.onServerMessage({ event: "autopilot", data: { bookId, at: new Date().toISOString(), seq: 2, type: "state", state: summaryOf(server, "running") } });
    await vi.advanceTimersByTimeAsync(600);
    expect(server.downloads).toHaveLength(1);
  });

  it("is not a streamed preview, a step that starts, or a remark", async () => {
    const server = new FakeServer(500);
    newBook(server);
    const send = (body: Record<string, unknown>, seq: number) => runtime.onServerMessage({ event: "autopilot", data: { bookId, at: new Date().toISOString(), seq, ...body } as AutopilotEvent });
    send({ type: "task-started", activity: { id: "a", runId: "r", task: "write", phase: "write", title: "Writing", reason: "", next: "", status: "running", startedAt: new Date().toISOString() } }, 1);
    send({ type: "task-progress", activityId: "a", characters: 5, preview: "text" }, 2);
    send({ type: "insight", tone: "info", title: "A remark" }, 3);
    send({ type: "sync", tone: "ok", title: "Published" }, 4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.downloads).toHaveLength(0);
  });
});

describe("a small book", () => {
  it.each<Door>(["server", "tab"])("is downloaded after every step, as it always was (events from the %s)", async (door) => {
    const server = new FakeServer(12);
    newBook(server);
    await simulateRun(server, { steps: 37, stepMs: 1500, door });
    await vi.advanceTimersByTimeAsync(2000);

    expect(server.downloads.length).toBeGreaterThanOrEqual(37);
    expect(server.downloads.length).toBeLessThanOrEqual(40);
    expect(server.mostInFlight).toBe(1);
    expect(viewState()?.version).toBe(38);
  });
});

describe("the page asking for the state", () => {
  it("shares a download that is already on its way when it only wants to look", async () => {
    const server = new FakeServer(500, 1000);
    newBook(server);
    const first = runtime.refresh(bookId, { join: true });
    const second = runtime.refresh(bookId, { join: true });
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([first, second]);
    expect(server.downloads).toHaveLength(1);
  });

  it("downloads again, once, for those who changed something and want to see it, whoever else is waiting", async () => {
    const server = new FakeServer(500, 1000);
    newBook(server);
    const first = runtime.refresh(bookId);
    const waiting = [runtime.refresh(bookId), runtime.refresh(bookId)];
    server.version = 4;
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, ...waiting]);
    expect(server.downloads).toHaveLength(2);
    expect(viewState()?.version).toBe(4);
  });
});
