import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotEvent, ServerBookSummary, ServerInfo } from "narrarium-engine";
import { FakeStreamServer } from "./helpers/fakeStreamServer";

const mocks = vi.hoisted(() => ({ connect: null as null | ((options: unknown) => Promise<unknown>), copy: null as unknown as ((...args: unknown[]) => Promise<unknown>) & { mock: { calls: unknown[][] }; mockClear: () => void } }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: (options: unknown) => mocks.connect!(options),
}));
vi.mock("@/autopilot/calls/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/calls/host")>()),
  copyServerCalls: (...args: unknown[]) => mocks.copy(...args),
}));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore, type ServerConnectionState } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

// The copy of a personal server's records into this browser, as the runtime starts it: when the server is attached, for the books that run there and only when the server
// announces the records; and when a run of such a book ends.

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const PIN = "f".repeat(64);
const IDLE: ServerConnectionState = { status: "disabled", info: null, message: null, books: [], updates: null, connection: null };
const SERVER_BOOK: BookEntry = { id: "book-server", owner: "local", repo: "book-server", name: "On the server", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z", autopilotHost: "server" };
const LOCAL_BOOK: BookEntry = { ...SERVER_BOOK, id: "book-local", repo: "book-local", name: "In this browser", autopilotHost: undefined };

let server: FakeStreamServer;
let client: unknown;
let features: string[];

const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await vi.advanceTimersByTimeAsync(0); };

function connect() {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [SERVER_BOOK, LOCAL_BOOK], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  autopilotRuntime.ensureServerStream();
}

const runEnded = (bookId: string): AutopilotEvent => ({ type: "run-ended", runId: "run-1", status: "completed", bookId, at: new Date(T0).toISOString(), seq: 1 });

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  features = ["autopilot-calls"];
  server = new FakeStreamServer();
  server.books = [{ bookId: SERVER_BOOK.id, title: SERVER_BOOK.name } as ServerBookSummary];
  mocks.copy = vi.fn(async () => ({ state: "done", copied: 0, skipped: 0, marker: null }));
  client = server.client("solo");
  mocks.connect = async () => ({ client, info: { serverId: "server-1", label: "Home server", features } as ServerInfo, fingerprint: PIN });
  useAutopilotStore.setState({ server: { ...IDLE }, views: { [SERVER_BOOK.id]: emptyView(SERVER_BOOK.id), [LOCAL_BOOK.id]: emptyView(LOCAL_BOOK.id) }, live: {}, summaries: {}, feed: [] });
});

afterEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ server: { ...IDLE }, views: {}, live: {}, summaries: {}, feed: [] });
  vi.useRealTimers();
});

describe("the server is attached", () => {
  it("copies the finished tasks of the books that run on it, with the engine's client of the server, once it is connected", async () => {
    connect();
    await settle();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    const [bookId, api, reason] = mocks.copy.mock.calls[0] as [string, unknown, string];
    expect([bookId, reason]).toEqual([SERVER_BOOK.id, "open"]);
    expect(api, "the client the connection verified is the API the copier reads").toBe(client);
  });

  it("copies again when the connection comes back after a gap, so that what ran meanwhile is caught up", async () => {
    connect();
    await settle();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    server.streams[0].end();
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(mocks.copy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.copy.mock.calls.every((call) => call[0] === SERVER_BOOK.id && call[2] === "open")).toBe(true);
  });

  it("copies nothing from a server that does not announce the records: an older server is left alone, and asked nothing", async () => {
    features = ["autopilot-controls"];
    connect();
    await settle();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});

describe("a run of a book on the server ends", () => {
  it("copies that book's tasks once the server has saved them, with the reason `run-ended`, and for that book only", async () => {
    connect();
    await settle();
    mocks.copy.mockClear();
    server.push({ event: "autopilot", data: runEnded(SERVER_BOOK.id) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.copy, "not at once: the server saves its last task first").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    expect(mocks.copy.mock.calls[0][0]).toBe(SERVER_BOOK.id);
    expect(mocks.copy.mock.calls[0][2]).toBe("run-ended");
  });

  it("does not copy for a book that runs in this browser, and a message that another tab relayed is the leader's to act on", async () => {
    connect();
    await settle();
    mocks.copy.mockClear();
    server.push({ event: "autopilot", data: runEnded(LOCAL_BOOK.id) });
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(mocks.copy).not.toHaveBeenCalled();
    autopilotRuntime.onServerMessage({ event: "autopilot", data: runEnded(SERVER_BOOK.id) }, true);
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("asks the server again once, however many messages of the end come together", async () => {
    connect();
    await settle();
    mocks.copy.mockClear();
    server.push({ event: "autopilot", data: runEnded(SERVER_BOOK.id) });
    server.push({ event: "autopilot", data: runEnded(SERVER_BOOK.id) });
    await vi.advanceTimersByTimeAsync(2_500);
    await settle();
    expect(mocks.copy).toHaveBeenCalledTimes(1);
  });
});
