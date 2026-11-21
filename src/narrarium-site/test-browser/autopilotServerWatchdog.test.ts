import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotActivity, ServerBookSummary } from "narrarium-engine";
import { FakeStreamServer } from "./helpers/fakeStreamServer";

const mocks = vi.hoisted(() => ({ connect: null as null | ((options: unknown) => Promise<unknown>) }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: (options: unknown) => mocks.connect!(options),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PIN = "f".repeat(64);
const IDLE: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };
const SERVER_BOOK: BookEntry = { id: "book-server", owner: "local", repo: "book-server", name: "On the server", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const LOCAL_BOOK: BookEntry = { ...SERVER_BOOK, id: "book-local", repo: "book-local", name: "In this browser", autopilotHost: undefined };

let server: FakeStreamServer;

const status = () => useAutopilotStore.getState().server.status;
const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await vi.advanceTimersByTimeAsync(0); };
const task = { id: "activity-1", runId: "run-1", task: "write", phase: "write", title: "Writing a scene", reason: "", next: "", status: "running", startedAt: new Date(T0).toISOString() } as AutopilotActivity;
const preview = { activity: task, characters: 120, preview: "The tide was out." };

function connect() {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK, LOCAL_BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  autopilotRuntime.ensureServerStream();
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  server = new FakeStreamServer();
  server.books = [{ bookId: SERVER_BOOK.id, title: SERVER_BOOK.name } as ServerBookSummary];
  mocks.connect = async () => ({ client: server.client("solo"), info: { serverId: "server-1", label: "Home server" }, fingerprint: PIN });
  useAutopilotStore.setState({ server: { ...IDLE }, views: { [SERVER_BOOK.id]: emptyView(SERVER_BOOK.id), [LOCAL_BOOK.id]: emptyView(LOCAL_BOOK.id) }, live: {}, summaries: {}, feed: [] });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ server: { ...IDLE }, views: {}, live: {}, summaries: {}, feed: [] });
  vi.useRealTimers();
});

describe("a live connection that went quiet", () => {
  it("stays connected for as long as the server's heartbeats arrive", async () => {
    server.startHeartbeats(15_000);
    connect();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(status()).toBe("online");
    expect(server.streams).toHaveLength(1);
    expect(server.streams[0].state).toBe("open");
  });

  it("is given up after 45 seconds without any message, and opened again", async () => {
    connect();
    await settle();
    expect(status()).toBe("online");
    expect(server.streams).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(44_000);
    expect(server.streams).toHaveLength(1);
    expect(server.streams[0].state).toBe("open");

    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(server.streams[0].state).toBe("ended");
    expect(server.streams).toHaveLength(2);
    expect(server.streams[1].state).toBe("open");
    expect(status()).toBe("online");
  });

  it("says it is reconnecting while the server cannot be reached again, not that it is offline", async () => {
    connect();
    await settle();
    let answer: (value: unknown) => void = () => undefined;
    const normal = mocks.connect!;
    // Only the connection that is being reopened waits: whoever asks next gets the server at once.
    mocks.connect = () => {
      mocks.connect = normal;
      return new Promise((resolve) => { answer = resolve; });
    };

    await vi.advanceTimersByTimeAsync(46_000);
    await settle();
    expect(status()).toBe("reconnecting");
    expect(useAutopilotStore.getState().server.message).toBeNull();

    answer({ client: server.client("solo"), info: { serverId: "server-1", label: "Home server" }, fingerprint: PIN });
    await settle();
    expect(status()).toBe("online");
  });

  it("is kept alive by any message, not only by heartbeats", async () => {
    connect();
    await settle();
    await vi.advanceTimersByTimeAsync(40_000);
    server.push({ event: "book", data: { bookId: SERVER_BOOK.id, title: "On the server" } as ServerBookSummary });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(server.streams).toHaveLength(1);
    expect(server.streams[0].state).toBe("open");

    await vi.advanceTimersByTimeAsync(6_000);
    await settle();
    expect(server.streams).toHaveLength(2);
  });

  it("is noticed at once when the tab comes back after the timers were frozen in the background", async () => {
    connect();
    await settle();
    vi.setSystemTime(Date.now() + 5 * 60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(server.streams[0].state).toBe("ended");
    expect(server.streams).toHaveLength(2);
  });

  it("is not opened again behind the author's back once the connection was switched off", async () => {
    connect();
    await settle();
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK, LOCAL_BOOK] } });
    autopilotRuntime.ensureServerStream();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(server.streams).toHaveLength(1);
    expect(status()).toBe("disabled");
  });
});

describe("after the connection came back", () => {
  it("downloads the books hosted on the server once, and clears the previews that may have ended meanwhile", async () => {
    connect();
    await settle();
    expect(server.snapshotRequests).toEqual([]);
    useAutopilotStore.setState({ live: { [SERVER_BOOK.id]: preview, [LOCAL_BOOK.id]: preview } });

    await vi.advanceTimersByTimeAsync(46_000);
    await settle();
    expect(server.streams).toHaveLength(2);
    expect(server.snapshotRequests).toEqual([SERVER_BOOK.id]);
    const live = useAutopilotStore.getState().live;
    expect(live[SERVER_BOOK.id]).toBeNull();
    // A step running in this very browser is not the server's to clear.
    expect(live[LOCAL_BOOK.id]).toEqual(preview);
  });

  it("downloads once even when events pour in right after the reconnection", async () => {
    connect();
    await settle();
    await vi.advanceTimersByTimeAsync(46_000);
    await settle();
    for (let seq = 1; seq <= 5; seq += 1) {
      server.push({ event: "autopilot", data: { bookId: SERVER_BOOK.id, at: new Date().toISOString(), seq, type: "run-started", runId: "run-1", host: "server" } });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.snapshotRequests.length).toBeLessThanOrEqual(3);
    const requestsAfterReconnect = server.snapshotRequests.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.snapshotRequests).toHaveLength(requestsAfterReconnect);
  });

  it("does the same when the server closes the stream", async () => {
    connect();
    await settle();
    useAutopilotStore.setState({ live: { [SERVER_BOOK.id]: preview } });
    server.open[0].end();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(server.streams).toHaveLength(2);
    expect(useAutopilotStore.getState().live[SERVER_BOOK.id]).toBeNull();
    expect(server.snapshotRequests).toEqual([SERVER_BOOK.id]);
  });

  it("does nothing special for the very first connection: the pages ask for their own books", async () => {
    useAutopilotStore.setState({ live: { [SERVER_BOOK.id]: preview } });
    connect();
    await settle();
    expect(server.snapshotRequests).toEqual([]);
    expect(useAutopilotStore.getState().live[SERVER_BOOK.id]).toEqual(preview);
  });
});

describe("the texts of the connection", () => {
  it.each(["en", "it"])("has a name for the reconnecting state in %s", (lng) => {
    expect(i18n.exists("personalServer.status.reconnecting", { lng })).toBe(true);
    expect(i18n.exists("autopilot.serverReconnecting", { lng })).toBe(true);
  });
});
