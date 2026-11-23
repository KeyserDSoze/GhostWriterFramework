import "fake-indexeddb/auto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAiCallStore, ServerRequestError, aiCallIdOf } from "narrarium-engine";
import { CALLS_SERVER_FEATURE, CallsUnavailableError, serverKeepsCalls, unavailableCallsSource } from "@/autopilot/calls/source";
import { LOCAL_POLL_MS, localCallsSource } from "@/autopilot/calls/sourceLocal";
import { SERVER_POLL_MS, serverCallsSource, type CallsClient } from "@/autopilot/calls/sourceServer";
import { hostCallsSource, provideCallsSources, useCallsSource } from "@/autopilot/calls/sourceHook";
import { callsStoreState, getAiCallStore, resetAiCallStoreForTests } from "@/autopilot/calls/wire";
import { resetRecordingForTests, setRecording } from "@/autopilot/calls/recording";
import { POLL_BACKOFF_MAX_MS, pollWhileVisible } from "@/autopilot/calls/sourcePoll";
import { useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BOOK, STEP, at, beginRecord, recordCall, saveTask } from "./helpers/aiCalls";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  provideCallsSources(null);
  window.localStorage.clear();
  resetRecordingForTests();
  (await getAiCallStore())?.close();
  resetAiCallStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-ai-calls");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  resetAiCallStoreForTests();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutopilotStore.setState({ server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("the records of a book that runs in this browser", () => {
  it("are read from its store: the tasks newest first a page at a time, a task with its calls in order, and a text from a byte with where it ends", async () => {
    const store = new MemoryAiCallStore();
    const source = localCallsSource(store);
    expect(source.available).toBe(true);
    expect(source.reason).toBeNull();
    expect(source.pollMs).toBe(LOCAL_POLL_MS);
    for (const [index, id] of ["activity_a", "activity_b", "activity_c"].entries()) {
      await store.saveTask({ bookId: BOOK, activityId: id, title: id, kind: "write", chapter: 1, scene: null, status: "done", startedAt: at(index * 100), endedAt: at(index * 100 + 50) });
    }
    const first = await source.listTasks(BOOK, { limit: 2 });
    expect(first.tasks.map((task) => task.activityId)).toEqual(["activity_c", "activity_b"]);
    const second = await source.listTasks(BOOK, { before: first.next!, limit: 2 });
    expect(second.tasks.map((task) => task.activityId)).toEqual(["activity_a"]);
    expect(second.next).toBeNull();

    await recordCall(store, STEP, { seq: 2, texts: ["second"] });
    await recordCall(store, STEP, { seq: 1, texts: ["first"] });
    const task = await source.readTask(BOOK, STEP);
    expect(task!.calls.map((call) => call.seq)).toEqual([1, 2]);
    expect(await source.readTask(BOOK, "activity_none")).toBeNull();
  });

  it("answer the text of a running response from a byte, and say when it is whole", async () => {
    const store = new MemoryAiCallStore();
    const source = localCallsSource(store);
    const { record, system, user } = beginRecord(STEP);
    await store.begin({ record, system, user });
    await store.append(record.callId, 1, 0, "Città ");
    const first = await source.readText(BOOK, record.callId, "response");
    expect(first).toEqual({ text: "Città ", from: 0, next: 7, done: false });
    await store.append(record.callId, 1, 7, "di vetro");
    // From the byte it had: only what was added. A byte inside a character starts at the character.
    expect(await source.readText(BOOK, record.callId, "response", { from: 7 })).toEqual({ text: "di vetro", from: 7, next: 15, done: false });
    expect((await source.readText(BOOK, record.callId, "response", { from: 5 }))!.from).toBe(4);
    expect((await source.readText(BOOK, record.callId, "system"))!.text).toBe(system);
    expect(await source.readText(BOOK, aiCallIdOf(STEP, 9), "response")).toBeNull();
  });

  it("keep a task, and delete every record of the book", async () => {
    const store = new MemoryAiCallStore();
    const source = localCallsSource(store);
    await recordCall(store, STEP);
    await saveTask(store, STEP);
    await source.keep(BOOK, STEP, true);
    expect((await source.readTask(BOOK, STEP))!.header.pinned).toBe(true);
    await source.deleteAll(BOOK);
    expect(await source.readTask(BOOK, STEP)).toBeNull();
    expect((await source.listTasks(BOOK)).tasks).toEqual([]);
  });
});

describe("the records of a book that runs on the personal server", () => {
  const client = () => ({
    listCalls: vi.fn(async () => ({ tasks: [], next: null })),
    readCallTask: vi.fn(async () => null as never),
    readCallText: vi.fn(async () => ({ text: "abc", from: 3, next: 6, size: 6, attempt: 2, done: true })),
    keepCallTask: vi.fn(async () => undefined),
    deleteCalls: vi.fn(async () => ({ deleted: true as const, tasks: 0, calls: 0, bytes: 0 })),
  }) satisfies CallsClient;

  it("are read through the client's routes, with its own signatures, and asked once a second while a call runs", async () => {
    const calls = client();
    const source = serverCallsSource(calls);
    expect(source.pollMs).toBe(SERVER_POLL_MS);
    expect(SERVER_POLL_MS).toBe(1000);
    await source.listTasks(BOOK, { before: "cursor", limit: 20 });
    expect(calls.listCalls).toHaveBeenCalledWith(BOOK, { before: "cursor", limit: 20 });
    await source.listTasks(BOOK);
    expect(calls.listCalls).toHaveBeenLastCalledWith(BOOK, { limit: 50 });
    await source.readTask(BOOK, STEP);
    expect(calls.readCallTask).toHaveBeenCalledWith(BOOK, STEP);
    expect(await source.readText(BOOK, "call-1", "response", { from: 3, attempt: 2 })).toEqual({ text: "abc", from: 3, next: 6, done: true });
    expect(calls.readCallText).toHaveBeenCalledWith(BOOK, "call-1", { field: "response", from: 3, attempt: 2 });
    await source.readText(BOOK, "call-1", "user");
    expect(calls.readCallText).toHaveBeenLastCalledWith(BOOK, "call-1", { field: "user", from: 0 });
    await source.keep(BOOK, STEP, false);
    expect(calls.keepCallTask).toHaveBeenCalledWith(BOOK, STEP, false);
    await source.deleteAll(BOOK);
    expect(calls.deleteCalls).toHaveBeenCalledWith(BOOK);
  });

  it("take a 404 of the server for a task or a call that is not there, and any other answer for what it is", async () => {
    const calls = client();
    calls.readCallTask.mockRejectedValueOnce(new ServerRequestError("none", 404, "call_task_not_found")).mockRejectedValueOnce(new ServerRequestError("down", 503, "maintenance"));
    calls.readCallText.mockRejectedValueOnce(new ServerRequestError("none", 404, "call_not_found")).mockRejectedValueOnce(new ServerRequestError("down", 502, "bad_gateway"));
    const source = serverCallsSource(calls);
    expect(await source.readTask(BOOK, STEP)).toBeNull();
    await expect(source.readTask(BOOK, STEP)).rejects.toMatchObject({ status: 503 });
    expect(await source.readText(BOOK, "call-1", "system")).toBeNull();
    await expect(source.readText(BOOK, "call-1", "system")).rejects.toMatchObject({ status: 502 });
  });

  it("delete on the server first, and then what this device kept of it: the two go together, and a server that says no leaves both", async () => {
    const calls = client();
    const here = vi.fn(async () => undefined);
    const source = serverCallsSource(calls, { alsoDelete: here });
    await source.deleteAll(BOOK);
    expect(calls.deleteCalls).toHaveBeenCalledWith(BOOK);
    expect(here).toHaveBeenCalledWith(BOOK);
    here.mockClear();
    calls.deleteCalls.mockRejectedValueOnce(new ServerRequestError("down", 503, "maintenance"));
    await expect(source.deleteAll(BOOK)).rejects.toMatchObject({ status: 503 });
    expect(here, "nothing is deleted here when the server could not delete").not.toHaveBeenCalled();
  });
});

describe("a source that is not available", () => {
  it("says why, and refuses every question with that reason", async () => {
    const source = unavailableCallsSource("no-store");
    expect(source).toMatchObject({ available: false, reason: "no-store" });
    await expect(source.readTask(BOOK, STEP)).rejects.toBeInstanceOf(CallsUnavailableError);
    await expect(source.listTasks(BOOK)).rejects.toMatchObject({ reason: "no-store" });
  });

  it("is what a personal server older than the records gives, or one that is not connected, and a browser that keeps no store", () => {
    expect(serverKeepsCalls({ features: [CALLS_SERVER_FEATURE] })).toBe(true);
    expect(serverKeepsCalls({ features: ["autopilot-controls"] })).toBe(false);
    expect(serverKeepsCalls({ features: "autopilot-calls" })).toBe(false);
    expect(serverKeepsCalls(null)).toBe(false);
    expect(hostCallsSource("server", { online: false, info: { features: [CALLS_SERVER_FEATURE] } }).reason).toBe("server-offline");
    expect(hostCallsSource("server", { online: true, info: { features: [] } }).reason).toBe("server-outdated");
    expect(hostCallsSource("browser", { online: false, info: null }, { store: null })).toMatchObject({ available: false, reason: "no-store" });
  });
});

describe("hostCallsSource, wired", () => {
  const online = { online: true, info: { features: [CALLS_SERVER_FEATURE] } };

  it("reads a book of the server through the client it is given, and deletes here what it deletes there", async () => {
    const calls = { listCalls: vi.fn(async () => ({ tasks: [], next: null })), readCallTask: vi.fn(async () => null), readCallText: vi.fn(async () => null), keepCallTask: vi.fn(async () => undefined), deleteCalls: vi.fn(async () => undefined) };
    const source = hostCallsSource("server", online, { client: calls });
    expect(source).toMatchObject({ available: true, reason: null, pollMs: SERVER_POLL_MS });
    await source.keep(BOOK, STEP, true);
    expect(calls.keepCallTask).toHaveBeenCalledWith(BOOK, STEP, true);
  });

  it("reads a book of this browser from the store it is given: the records, and not a word of the recording being off unless it is", async () => {
    const store = new MemoryAiCallStore();
    await recordCall(store, STEP);
    await saveTask(store, STEP);
    const on = hostCallsSource("browser", { online: false, info: null }, { store, recording: true });
    expect(on).toMatchObject({ available: true, reason: null, pollMs: LOCAL_POLL_MS });
    expect(on.notRecording).toBeUndefined();
    expect((await on.readTask(BOOK, STEP))?.calls).toHaveLength(1);
    const off = hostCallsSource("browser", { online: false, info: null }, { store, recording: false });
    expect(off.available, "what was kept is read all the same").toBe(true);
    expect(off.notRecording).toBe(true);
    expect((await off.readTask(BOOK, STEP))?.calls).toHaveLength(1);
  });

  it("waits for a store that is still opening: it reads through the facade of the browser's store, which answers when it is open", async () => {
    const source = hostCallsSource("browser", { online: false, info: null }, { identity: "workspace:wired" });
    expect(source.available).toBe(true);
    expect(await source.listTasks(BOOK)).toEqual({ tasks: [], next: null });
    expect(callsStoreState().status, "reading it asked the browser to open it").toBe("ready");
  });
});

describe("useCallsSource", () => {
  const bookOn = (host: "browser" | "server") => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [{ id: BOOK, owner: "local", repo: BOOK, name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", autopilotHost: host, addedAt: at(0) }] as typeof DEFAULT_SETTINGS.books } });

  it("picks the source of the book by where it runs, and says why there is none", () => {
    bookOn("server");
    const { result } = renderHook(() => useCallsSource(BOOK));
    expect(result.current.reason).toBe("server-offline");
    act(() => {
      useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, personalServer: { url: "https://server.test", token: "token" } as typeof DEFAULT_SETTINGS.personalServer } });
      useAutopilotStore.setState({ server: { status: "online", info: { features: ["autopilot-controls"] } as never, message: null, books: [], updates: null, connection: { url: "https://server.test", token: "token" } as never } });
    });
    expect(result.current.reason).toBe("server-outdated");
  });

  it("gives the source the tests and the checks in a real browser put in place, to every view that is open, and gives it back", () => {
    bookOn("browser");
    const { result } = renderHook(() => useCallsSource(BOOK));
    expect(result.current.available).toBe(true);
    const provided = localCallsSource(new MemoryAiCallStore());
    const factory = vi.fn(() => provided);
    act(() => provideCallsSources(factory));
    expect(result.current).toBe(provided);
    expect(factory).toHaveBeenCalledWith(BOOK, "browser");
    act(() => provideCallsSources(null));
    expect(result.current).not.toBe(provided);
    expect(result.current.available).toBe(true);
  });

  it("reads a book of this browser from its store once it is open, and says so when this browser keeps none", async () => {
    bookOn("browser");
    const { result } = renderHook(() => useCallsSource(BOOK));
    await waitFor(() => expect(callsStoreState().status).toBe("ready"));
    await waitFor(() => expect(result.current).toMatchObject({ available: true, reason: null, pollMs: LOCAL_POLL_MS }));
    await act(async () => {
      (await getAiCallStore())?.close();
      resetAiCallStoreForTests();
      vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
      await getAiCallStore();
    });
    await waitFor(() => expect(result.current).toMatchObject({ available: false, reason: "no-store" }));
  });

  it("follows the recording switch of the book on this device: the records are read, and the source says nothing more is kept", async () => {
    bookOn("browser");
    const { result } = renderHook(() => useCallsSource(BOOK));
    await waitFor(() => expect(callsStoreState().status).toBe("ready"));
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.notRecording).toBeUndefined();
    act(() => setRecording(BOOK, false));
    expect(result.current).toMatchObject({ available: true, notRecording: true });
    act(() => setRecording(BOOK, true));
    expect(result.current.notRecording).toBeUndefined();
  });
});

describe("asking again while a call runs", () => {
  const settle = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("asks at once and then every interval, and stops when the answer says the call is over", async () => {
    vi.useFakeTimers();
    let answers = 0;
    const tick = vi.fn(async () => {
      answers += 1;
      return answers < 3;
    });
    const stop = pollWhileVisible(tick, 1000);
    await settle(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await settle(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await settle(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    await settle(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("asks nothing while the page is hidden, and asks at once when it is shown again", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => true);
    const stop = pollWhileVisible(tick, 1000);
    await settle(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await settle(30_000);
    expect(tick).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(0);
    expect(tick).toHaveBeenCalledTimes(2);
    await settle(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    await settle(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("asks a server that does not answer again, more and more slowly", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {
      throw new Error("offline");
    });
    const stop = pollWhileVisible(tick, 1000);
    await settle(0);
    await settle(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    await settle(3999);
    expect(tick).toHaveBeenCalledTimes(2);
    await settle(1);
    expect(tick).toHaveBeenCalledTimes(3);
    await settle(POLL_BACKOFF_MAX_MS * 3);
    expect(tick.mock.calls.length).toBeLessThanOrEqual(6);
    stop();
  });
});
