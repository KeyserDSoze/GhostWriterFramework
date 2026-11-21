import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, ServerBookSummary } from "narrarium-engine";
import { FakeStreamServer } from "./helpers/fakeStreamServer";
import { FakeLockRegistry } from "./helpers/fakeWebLocks";
import { FakeBroadcastBus, type FakeChannel } from "./helpers/fakeBroadcastChannel";

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { BrowserAutopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PIN = "f".repeat(64);
const IDLE: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };
const SERVER_BOOK: BookEntry = { id: "book-server", owner: "local", repo: "book-server", name: "On the server", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const SUMMARY = { bookId: SERVER_BOOK.id, title: SERVER_BOOK.name, running: false, autopilot: null } as unknown as ServerBookSummary;
const settle = async () => { for (let turn = 0; turn < 12; turn += 1) await vi.advanceTimersByTimeAsync(0); };

let server: FakeStreamServer;
let locks: FakeLockRegistry;
let bus: FakeBroadcastBus;
let tabs: Map<string, BrowserAutopilotRuntime>;
let channels: Map<string, FakeChannel>;
/** How many times each tab handled a message of the server, whether it came from the stream or from the leader tab. */
let handled: Map<string, number>;

function openTab(name: string, options: { withLocks?: boolean } = {}): BrowserAutopilotRuntime {
  const channel = bus.channel(name);
  channels.set(name, channel);
  const runtime = new BrowserAutopilotRuntime({
    locks: options.withLocks === false ? () => undefined : () => locks.forTab(name) as never,
    channel: () => channel as never,
    connect: server.connector(name) as never,
  });
  const original = runtime.onServerMessage.bind(runtime);
  runtime.onServerMessage = ((...args: Parameters<typeof original>) => {
    handled.set(name, (handled.get(name) ?? 0) + 1);
    return original(...args);
  }) as typeof runtime.onServerMessage;
  tabs.set(name, runtime);
  return runtime;
}

function closeTab(name: string) {
  locks.closeTab(name);
  bus.closeTab(name);
  server.dropTab(name);
}

const status = () => useAutopilotStore.getState().server.status;
const task = { id: "activity-1", runId: "run-1", task: "write", phase: "write", title: "Writing a scene", reason: "", next: "", status: "running", startedAt: new Date(T0).toISOString() } as AutopilotActivity;
const preview = { activity: task, characters: 120, preview: "The tide was out." };

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  server = new FakeStreamServer();
  server.books = [SUMMARY];
  locks = new FakeLockRegistry();
  bus = new FakeBroadcastBus();
  tabs = new Map();
  channels = new Map();
  handled = new Map();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_shared_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ server: { ...IDLE }, views: { [SERVER_BOOK.id]: emptyView(SERVER_BOOK.id) }, live: {}, summaries: {}, feed: [] });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  for (const runtime of tabs.values()) runtime.ensureServerStream();
  useAutopilotStore.setState({ server: { ...IDLE }, views: {}, live: {}, summaries: {}, feed: [] });
  vi.useRealTimers();
});

describe("one live connection for the whole browser", () => {
  it("is shared by twenty tabs, though the server accepts only ten streams for the token", async () => {
    for (let index = 0; index < 20; index += 1) openTab(`tab-${index}`).ensureServerStream();
    await settle();

    expect(server.streams).toHaveLength(1);
    expect(server.open).toHaveLength(1);
    expect(status()).toBe("online");
  });

  it("is kept by the tab that was first, and the others wait their turn for it", async () => {
    openTab("A").ensureServerStream();
    await settle();
    openTab("B").ensureServerStream();
    openTab("C").ensureServerStream();
    await settle();

    expect(server.open.map((stream) => stream.tab)).toEqual(["A"]);
    expect(locks.holderOf([...locks.held()][0])).toBe("A");
    expect(locks.pending([...locks.held()][0])).toBe(2);
  });

  it("does not put the token in the name of a lock or in a message to the other tabs", async () => {
    openTab("A").ensureServerStream();
    openTab("B").ensureServerStream();
    await settle();
    server.push({ event: "book", data: SUMMARY });
    await settle();

    expect(JSON.stringify(locks.held())).not.toContain("nrs_shared_token");
    expect(JSON.stringify(bus.posted)).not.toContain("nrs_shared_token");
  });

  it("takes every message of the server to every tab, once", async () => {
    for (const name of ["A", "B", "C"]) openTab(name).ensureServerStream();
    await settle();
    handled.clear();

    server.push({ event: "autopilot", data: { bookId: SERVER_BOOK.id, at: new Date().toISOString(), seq: 1, type: "run-started", runId: "run-1", host: "server" } });
    server.push({ event: "book", data: SUMMARY });
    await settle();

    expect([...handled.entries()].sort()).toEqual([["A", 2], ["B", 2], ["C", 2]]);
  });

  it("shows the state of the connection in a tab that opens later, without connecting for itself", async () => {
    openTab("A").ensureServerStream();
    await settle();
    expect(status()).toBe("online");

    openTab("B").ensureServerStream();
    // Right after the tab is set up it knows nothing yet, whatever the other tabs showed.
    expect(status()).toBe("connecting");
    await settle();
    expect(status()).toBe("online");
    expect(useAutopilotStore.getState().server.books.map((book) => book.bookId)).toEqual([SERVER_BOOK.id]);
    expect(server.streams).toHaveLength(1);
  });

  it("makes the other tabs show what the leader is going through", async () => {
    openTab("A").ensureServerStream();
    await settle();
    openTab("B").ensureServerStream();
    await settle();
    expect(status()).toBe("online");

    // The leader reconnects: its tab and the other one say so.
    server.open[0].end();
    await settle();
    expect(bus.posted.some((entry) => entry.from === "A" && (entry.data as { kind?: string }).kind === "server-state" && (entry.data as { state: { status: string } }).state.status === "reconnecting")).toBe(true);
  });
});

describe("a connection test in a tab that only follows", () => {
  it("makes the tab that holds the connection open it again, since that is the only one that can", async () => {
    const leader = openTab("A");
    const follower = openTab("B");
    leader.ensureServerStream();
    await settle();
    follower.ensureServerStream();
    await settle();
    expect(server.streams).toHaveLength(1);

    follower.reconnectServer();
    await settle();
    expect(server.streams).toHaveLength(2);
    expect(server.streams[0].state).toBe("ended");
    expect(server.open).toHaveLength(1);
    expect(status()).toBe("online");
  });
});

describe("when the tab that holds the connection goes away", () => {
  it("another tab takes it over, and only one stream is open", async () => {
    for (const name of ["A", "B", "C"]) openTab(name).ensureServerStream();
    await settle();
    expect(server.open.map((stream) => stream.tab)).toEqual(["A"]);

    closeTab("A");
    await settle();
    expect(server.open.map((stream) => stream.tab)).toEqual(["B"]);
    expect(status()).toBe("online");

    closeTab("B");
    await settle();
    expect(server.open.map((stream) => stream.tab)).toEqual(["C"]);
  });

  it("downloads the hosted books once and clears the previews, since events were missed in the handover", async () => {
    for (const name of ["A", "B"]) openTab(name).ensureServerStream();
    await settle();
    expect(server.snapshotRequests).toEqual([]);
    useAutopilotStore.setState({ live: { [SERVER_BOOK.id]: preview } });

    closeTab("A");
    await settle();
    expect(server.snapshotRequests).toEqual([SERVER_BOOK.id]);
    expect(useAutopilotStore.getState().live[SERVER_BOOK.id]).toBeNull();
  });

  it("the tabs that stayed refresh their own views when the leader reconnects after a quiet connection", async () => {
    for (const name of ["A", "B", "C"]) openTab(name).ensureServerStream();
    await settle();
    useAutopilotStore.setState({ live: { [SERVER_BOOK.id]: preview } });

    await vi.advanceTimersByTimeAsync(46_000);
    await settle();
    expect(server.streams).toHaveLength(2);
    expect(server.open.map((stream) => stream.tab)).toEqual(["A"]);
    // Every tab has its own view of the book: each downloads it once.
    expect(server.snapshotRequests).toEqual([SERVER_BOOK.id, SERVER_BOOK.id, SERVER_BOOK.id]);
    expect(useAutopilotStore.getState().live[SERVER_BOOK.id]).toBeNull();
  });

  it("does not leave a tab connecting for itself behind the leader's back when the server is unreachable", async () => {
    server.listFailure = new Error("unreachable");
    for (const name of ["A", "B", "C"]) openTab(name).ensureServerStream();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(server.streams).toHaveLength(0);
    // Only the leader asks the server, and with growing pauses between its attempts.
    expect(server.listBooksCalls).toBeLessThanOrEqual(6);
    expect(["offline", "connecting"]).toContain(status());
  });
});

describe("where Web Locks do not exist", () => {
  it("every tab opens its own stream, as it always did", async () => {
    for (const name of ["A", "B", "C"]) openTab(name, { withLocks: false }).ensureServerStream();
    await settle();
    expect(server.open.map((stream) => stream.tab).sort()).toEqual(["A", "B", "C"]);
  });

  it("a tab whose browser refuses the lock (a sandboxed page) connects by itself instead of waiting for ever", async () => {
    const refusing = new BrowserAutopilotRuntime({
      locks: () => ({ request: () => Promise.reject(new DOMException("Locks are not available here.", "SecurityError")), query: async () => ({ held: [], pending: [] }) }) as never,
      channel: () => bus.channel("sandboxed") as never,
      connect: server.connector("sandboxed") as never,
    });
    tabs.set("sandboxed", refusing);
    refusing.ensureServerStream();
    await settle();
    expect(server.open.map((stream) => stream.tab)).toEqual(["sandboxed"]);
    expect(status()).toBe("online");
  });
});
