import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBookStore } from "narrarium-engine/testing";
import type { AutopilotEvent } from "narrarium-engine";

const mocks = vi.hoisted(() => ({ server: null as unknown as { verified: () => unknown }, local: null as unknown, toast: vi.fn() }));

vi.mock("@/autopilot/serverIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/serverIdentity")>()),
  verifiedServer: async () => mocks.server.verified(),
}));
vi.mock("@/autopilot/browserStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/autopilot/browserStore")>()),
  createBrowserBookStore: () => mocks.local,
}));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }), toast: mocks.toast }));

import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { autopilotRuntime } from "@/autopilot/runtime";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAuthStore } from "@/store/authStore";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";
import { FakeBookServer, PIN } from "./helpers/fakeBookServer";
import { FakeLockRegistry, installNavigatorLocks } from "./helpers/fakeWebLocks";

useAuthStore.setState({ user: { provider: "google", providerAccountId: "sub-writer", name: "Writer", email: "writer@example.com", picture: "" } });

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", activeBranch: "main", addedAt: "2026-11-21T00:00:00.000Z" };
const OTHER: BookEntry = { ...BOOK, id: "book-2", repo: "book-2", name: "Another book" };
const CONSENT = { sendAiConfiguration: false, sendGitHubToken: false };
const BOOK_LOCK = `narrarium:autopilot:${BOOK.id}`;

let server: FakeBookServer;

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const operation = (bookId = BOOK.id) => useAutopilotStore.getState().views[bookId]?.operation ?? null;
const moveToServer = (bookId = BOOK.id) => autopilotRuntime.moveToServer(bookId, CONSENT);

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  server = new FakeBookServer();
  mocks.server = server;
  mocks.local = new MemoryBookStore();
  mocks.toast.mockReset();
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK, OTHER], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
  useAutopilotStore.setState({ views: { [BOOK.id]: emptyView(BOOK.id), [OTHER.id]: emptyView(OTHER.id) }, server: { status: "online", info: null, message: null, books: [], updates: null, connection: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (navigator as { locks?: unknown }).locks;
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  autopilotRuntime.ensureServerStream();
  useAutopilotStore.setState({ views: {}, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
});

describe("one operation at a time on a book", () => {
  it("refuses Resume while the book is being moved to the server, saying what is going on", async () => {
    const gate = deferred();
    server.gates.registerBook = gate.promise;
    const moving = moveToServer();
    await waitFor(() => expect(server.count("registerBook")).toBe(1));

    const refused = await autopilotRuntime.start(BOOK.id).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).name).toBe("AutopilotOperationBusyError");
    expect((refused as Error).message).toBe(i18n.t("autopilot.errors.busyWith.moveToServer"));
    expect((refused as Error).message).not.toBe("autopilot.errors.busyWith.moveToServer");

    gate.resolve();
    await moving;
    // Once it is over the book accepts operations again.
    await expect(autopilotRuntime.configure(BOOK.id, { brief: { idea: "A harbor built on glass." } })).resolves.toBeUndefined();
  });

  it.each<[string, () => Promise<unknown>]>([
    ["Reset", () => autopilotRuntime.reset(BOOK.id)],
    ["a new brief", () => autopilotRuntime.configure(BOOK.id, { brief: { idea: "Another idea." } })],
    ["an answer", () => autopilotRuntime.answer(BOOK.id, { questionId: "q", answer: "yes" })],
    ["an intervention", () => autopilotRuntime.intervene(BOOK.id, { text: "Keep it short.", scope: "next_step" } as never)],
    ["bringing the book back", () => autopilotRuntime.moveToBrowser(BOOK.id)],
    ["another sync", () => autopilotRuntime.syncWithServer(BOOK.id)],
    ["a second move", () => moveToServer()],
  ])("refuses %s while a sync is in progress", async (_name, action) => {
    const gate = deferred();
    server.gates.manifest = gate.promise;
    const syncing = autopilotRuntime.syncWithServer(BOOK.id);
    await waitFor(() => expect(server.count("manifest")).toBeGreaterThan(0));

    const refused = await Promise.resolve().then(action).catch((error: unknown) => error);
    expect((refused as Error | undefined)?.name).toBe("AutopilotOperationBusyError");
    expect((refused as Error).message).toBe(i18n.t("autopilot.errors.busyWith.sync"));

    gate.resolve();
    await syncing;
    expect(operation()).toBeNull();
  });

  it("shows the operation in the book's view while it lasts, and clears it when it ends", async () => {
    const gate = deferred();
    server.gates.registerBook = gate.promise;
    const moving = moveToServer();
    await waitFor(() => expect(operation()?.kind).toBe("moveToServer"));
    expect(Date.parse(operation()!.since)).not.toBeNaN();
    expect(operation(OTHER.id)).toBeNull();

    gate.resolve();
    await moving;
    expect(operation()).toBeNull();
  });

  it("clears the operation when it fails, so the book is not left locked", async () => {
    server.failures.registerBook = new Error("The server is on fire.");
    await expect(moveToServer()).rejects.toThrow("The server is on fire.");
    expect(operation()).toBeNull();

    server.failures.registerBook = undefined;
    await expect(moveToServer()).resolves.toBeUndefined();
    expect(operation()).toBeNull();
  });

  it("clears the operation even when the work throws before it starts anything", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [BOOK] } });
    await expect(moveToServer()).rejects.toMatchObject({ code: "no-server" });
    expect(operation()).toBeNull();
  });

  it("does not stop another book, which has its own turn", async () => {
    const gate = deferred();
    server.gates.registerBook = gate.promise;
    const moving = moveToServer();
    await waitFor(() => expect(server.count("registerBook")).toBe(1));

    await expect(autopilotRuntime.configure(OTHER.id, { brief: { idea: "Another idea." } })).resolves.toBeUndefined();
    gate.resolve();
    await moving;
  });

  it("never stands in the way of Pause and Stop, nor of looking at the book", async () => {
    const gate = deferred();
    server.gates.registerBook = gate.promise;
    const moving = moveToServer();
    await waitFor(() => expect(server.count("registerBook")).toBe(1));

    await expect(autopilotRuntime.pause(BOOK.id, "after-step")).resolves.toBeUndefined();
    await expect(autopilotRuntime.pause(BOOK.id, "now")).resolves.toBeUndefined();
    await expect(autopilotRuntime.refresh(BOOK.id)).resolves.toMatchObject({ bookId: BOOK.id });
    gate.resolve();
    await moving;
  });

  it("lets a background sync give way instead of failing or queueing behind an operation", async () => {
    // Only the clock is faked: the local database the sync reads and writes needs real turns of the event loop.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ ...BOOK, autopilotHost: "server" }], personalServer: { url: "http://127.0.0.1:24242", token: "nrs_token", fingerprint: PIN } } });
    const gate = deferred();
    server.gates.manifest = gate.promise;
    const runtime = autopilotRuntime as unknown as { onServerMessage(message: { event: "autopilot"; data: AutopilotEvent }): void };
    const syncing = autopilotRuntime.syncWithServer(BOOK.id);
    await vi.advanceTimersByTimeAsync(10);
    const manifests = server.count("manifest");

    runtime.onServerMessage({ event: "autopilot", data: { bookId: BOOK.id, at: new Date().toISOString(), seq: 1, type: "run-ended", runId: "run-1", status: "paused", message: null } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.count("manifest")).toBe(manifests);

    gate.resolve();
    await syncing;
    expect(operation()).toBeNull();
  });
});

describe("every component of the same book", () => {
  function twoConsumers() {
    const first = renderHook(() => useAutopilotActions(BOOK.id));
    const second = renderHook(() => useAutopilotActions(BOOK.id));
    return { first, second };
  }

  it("sees what another one is doing and cannot start a conflicting action", async () => {
    const { first, second } = twoConsumers();
    const gate = deferred();
    server.gates.registerBook = gate.promise;

    let moving: Promise<boolean> = Promise.resolve(false);
    act(() => { moving = first.result.current.run("move", (runtime, id) => runtime.moveToServer(id, CONSENT)); });
    await waitFor(() => expect(second.result.current.busy).toBe("move"));
    expect(second.result.current.operation?.kind).toBe("moveToServer");

    let resumed = true;
    await act(async () => { resumed = await second.result.current.run("start", (runtime, id) => runtime.start(id)); });
    expect(resumed).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: i18n.t("autopilot.errors.busyWith.moveToServer"), variant: "destructive" }));

    await act(async () => { gate.resolve(); await moving; });
    await waitFor(() => expect(second.result.current.busy).toBeNull());
    expect(first.result.current.busy).toBeNull();
  });

  it("is not told about the operations of another book", async () => {
    const mine = renderHook(() => useAutopilotActions(OTHER.id));
    const gate = deferred();
    server.gates.registerBook = gate.promise;
    const moving = moveToServer();
    await waitFor(() => expect(operation()?.kind).toBe("moveToServer"));
    expect(mine.result.current.busy).toBeNull();
    gate.resolve();
    await moving;
  });
});

describe("between the tabs of one browser", () => {
  it("holds the book's lock for the whole move, so no other tab can run or move the book meanwhile", async () => {
    const locks = new FakeLockRegistry();
    installNavigatorLocks(locks.forTab("this-tab"));
    const gate = deferred();
    server.gates.registerBook = gate.promise;

    const moving = moveToServer();
    await waitFor(() => expect(server.count("registerBook")).toBe(1));
    expect(locks.holderOf(BOOK_LOCK)).toBe("this-tab");

    // Another tab that wants to start the autopilot of this book now finds the lock taken.
    const taken = await locks.forTab("other-tab").request(BOOK_LOCK, { ifAvailable: true }, (lock) => lock);
    expect(taken).toBeNull();

    gate.resolve();
    await moving;
    expect(locks.holderOf(BOOK_LOCK)).toBeNull();
  });

  it("refuses to move a book that another tab runs or moves, with an error that says so", async () => {
    const locks = new FakeLockRegistry();
    installNavigatorLocks(locks.forTab("this-tab"));
    const never = new Promise<void>(() => undefined);
    void locks.forTab("other-tab").request(BOOK_LOCK, () => never);

    const refused = await moveToServer().catch((error: unknown) => error);
    expect((refused as Error).name).toBe("AutopilotOperationBusyError");
    expect((refused as Error).message).toBe(i18n.t("autopilot.errors.busyWith.otherTab"));
    expect(server.count("registerBook")).toBe(0);
    expect(operation()).toBeNull();

    const back = await autopilotRuntime.moveToBrowser(BOOK.id).catch((error: unknown) => error);
    expect((back as Error).name).toBe("AutopilotOperationBusyError");
  });

  it("moves the book all the same where the browser has no Web Locks", async () => {
    await expect(moveToServer()).resolves.toBeUndefined();
    expect(server.count("registerBook")).toBe(1);
  });
});

describe("the texts of the operations", () => {
  const KINDS = ["start", "answer", "configure", "reset", "intervene", "moveToServer", "moveToBrowser", "sync", "frozen"];

  it.each(["en", "it"])("has, in %s, a line to show for each operation and an explanation for each refusal", (lng) => {
    for (const kind of KINDS) {
      expect(i18n.exists(`autopilot.operation.${kind}`, { lng }), `operation.${kind}`).toBe(true);
      expect(i18n.exists(`autopilot.errors.busyWith.${kind}`, { lng }), `busyWith.${kind}`).toBe(true);
    }
    expect(i18n.exists("autopilot.errors.busyWith.otherTab", { lng })).toBe(true);
  });
});
