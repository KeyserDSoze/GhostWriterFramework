import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCallBegin, AiCallEnd, AiCallRecord } from "narrarium-engine";
import { ENGINE_RECORDS_CALLS, browserCallsSecrets, callsStoreState, getAiCallStore, resetAiCallStoreForTests, subscribeCallsStore, wireBrowserCalls } from "@/autopilot/calls/wire";
import { copyServerCalls, resetCallsHostForTests } from "@/autopilot/calls/host";
import { resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { resetRecordingForTests, setRecording } from "@/autopilot/calls/recording";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { BOOK, FakeServer, day, recordOf } from "./helpers/fakeServerCalls";

// Where the store meets the rest of the site: the fields the session takes, opened once and lazily, a browser that does not let it open, and the keys that no record may keep.

const T0 = "2026-11-20T10:00:00.000Z";

const finalOf = (): AiCallEnd => ({ status: "ok", response: { text: null, partial: false }, attempts: [], timing: { startedAt: T0, firstTextAt: T0, endedAt: T0 }, storedBytes: 6, dropped: null });
const begin = (callId: string, activityId: string, system = "sys"): AiCallBegin => ({ record: recordOf(callId, activityId, 1, BOOK, T0) as AiCallRecord, system, user: "usr" });

async function forget(): Promise<void> {
  const store = await getAiCallStore();
  store?.close();
  resetAiCallStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-ai-calls");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  resetAiCallStoreForTests();
}

beforeEach(() => {
  window.localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ accountIdentity: "workspace:wire-a", settings: DEFAULT_SETTINGS });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  resetCallsHostForTests();
  await forget();
  window.localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ accountIdentity: null, settings: DEFAULT_SETTINGS });
});

describe("the fields for the session of the browser", () => {
  it("are the engine's own fields of the session, for the account the page is in, now that the engine records the calls", () => {
    expect(ENGINE_RECORDS_CALLS).toBe(true);
    for (const fields of [wireBrowserCalls(), wireBrowserCalls({ bookId: BOOK })]) {
      expect(Object.keys(fields).sort()).toEqual(["calls", "callsAccountScope", "callsSecrets"]);
      expect(fields.callsAccountScope).toBe("workspace:wire-a");
    }
  });

  it("are none when they are turned off: the autopilot runs as it did before the records", () => {
    expect(wireBrowserCalls({ enabled: false })).toEqual({});
  });

  it("are none for a book whose recording is turned off on this device, and come back with it, for that book only", () => {
    setRecording(BOOK, false);
    expect(wireBrowserCalls({ bookId: BOOK })).toEqual({});
    expect(Object.keys(wireBrowserCalls({ bookId: "another-book" })).sort()).toEqual(["calls", "callsAccountScope", "callsSecrets"]);
    expect(Object.keys(wireBrowserCalls()).sort(), "a session of no book in particular is not a book's choice").toEqual(["calls", "callsAccountScope", "callsSecrets"]);
    setRecording(BOOK, true);
    expect(Object.keys(wireBrowserCalls({ bookId: BOOK })).sort()).toEqual(["calls", "callsAccountScope", "callsSecrets"]);
  });

  it("are the store and the secrets when they are asked for, and opening the database waits for the first call that is written", async () => {
    const open = vi.spyOn(indexedDB, "open");
    const fields = wireBrowserCalls({ bookId: BOOK, enabled: true });
    expect(Object.keys(fields).sort()).toEqual(["calls", "callsAccountScope", "callsSecrets"]);
    expect(open, "nothing is opened by building the fields").not.toHaveBeenCalled();
    await fields.calls!.begin(begin("activity_1-0001", "activity_1"));
    expect(open).toHaveBeenCalledTimes(1);
    await Promise.all([fields.calls!.append("activity_1-0001", 1, 0, "Hel"), fields.calls!.append("activity_1-0001", 1, 3, "lo"), wireBrowserCalls({ enabled: true }).calls!.saveTask({ bookId: BOOK, activityId: "activity_1", title: "t", kind: "write", chapter: 1, scene: null, status: "running", startedAt: T0, endedAt: null })]);
    await fields.calls!.end("activity_1-0001", finalOf());
    expect(open, "the database is opened once for the tab").toHaveBeenCalledTimes(1);
    const store = await getAiCallStore();
    expect((await store!.readText(BOOK, "activity_1-0001", "response", 0, 1))?.text).toBe("Hello");
    expect((await fields.calls!.readText(BOOK, "activity_1-0001", "system", 0))?.text).toBe("sys");
    expect((await fields.calls!.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId)).toEqual(["activity_1"]);
    expect((await fields.calls!.totals(BOOK)).calls).toBe(1);
  });

  it("are none in a browser that has no IndexedDB", () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(wireBrowserCalls({ enabled: true })).toEqual({});
  });

  it("write for the account of the session: after the page changes account what the session writes is dropped, and what it reads is nothing", async () => {
    const { calls } = wireBrowserCalls({ enabled: true });
    await calls!.begin(begin("activity_a-0001", "activity_a", "private"));
    useSettingsStore.setState({ accountIdentity: "workspace:wire-b" });
    await calls!.append("activity_a-0001", 1, 0, "dropped");
    await calls!.begin(begin("activity_a-0002", "activity_a"));
    expect(await calls!.readText(BOOK, "activity_a-0001", "system", 0)).toBeNull();
    expect(await calls!.listTasks(BOOK, { limit: 5 })).toEqual({ tasks: [], next: null });
    const store = await getAiCallStore();
    expect(store!.fencedWrites).toBe(2);
    expect(await store!.readTask(BOOK, "activity_a"), "the account the page is in sees nothing of it").toBeNull();
    useSettingsStore.setState({ accountIdentity: "workspace:wire-a" });
    expect((await store!.readTask(BOOK, "activity_a"))?.calls).toHaveLength(1);
    expect((await store!.readText(BOOK, "activity_a-0001", "response", 0, 1))?.size).toBe(0);
  });
});

describe("the store of the tab", () => {
  it("is opened once, and is the same for everyone who asks", async () => {
    const first = getAiCallStore();
    const second = getAiCallStore();
    expect(second).toBe(first);
    const store = await first;
    expect(store).not.toBeNull();
    expect(await getAiCallStore()).toBe(store);
  });

  it("tells whoever watches it how it goes: not asked for, opening, open", async () => {
    expect(callsStoreState()).toEqual({ status: "idle", store: null });
    const seen: string[] = [];
    const stop = subscribeCallsStore(() => seen.push(callsStoreState().status));
    const store = await getAiCallStore();
    await getAiCallStore();
    stop();
    expect(seen, "each change once, and nothing when it is asked for again").toEqual(["opening", "ready"]);
    expect(callsStoreState()).toEqual({ status: "ready", store });
  });

  it("is none where this browser does not let it open, and the watchers are told", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
    const seen: string[] = [];
    const stop = subscribeCallsStore(() => seen.push(callsStoreState().status));
    expect(await getAiCallStore()).toBeNull();
    stop();
    expect(seen).toEqual(["opening", "none"]);
    expect(callsStoreState()).toEqual({ status: "none", store: null });
  });

  it("is null in a browser that does not let it open, and nothing throws: the run goes on, the writes are nothing and the reads are empty", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
    expect(await getAiCallStore()).toBeNull();
    const { calls } = wireBrowserCalls({ enabled: true });
    await expect(calls!.begin(begin("activity_x-0001", "activity_x"))).resolves.toBeUndefined();
    await expect(calls!.append("activity_x-0001", 1, 0, "text")).resolves.toBeUndefined();
    await expect(calls!.end("activity_x-0001", finalOf())).resolves.toBeUndefined();
    await expect(calls!.saveTask({ bookId: BOOK, activityId: "activity_x", title: "t", kind: "write", chapter: 1, scene: null, status: "done", startedAt: T0, endedAt: T0 })).resolves.toBeUndefined();
    expect(await calls!.readTask(BOOK, "activity_x")).toBeNull();
    expect(await calls!.readText(BOOK, "activity_x-0001", "system", 0)).toBeNull();
    expect(await calls!.listTasks(BOOK, { limit: 5 })).toEqual({ tasks: [], next: null });
    expect(await calls!.totals(BOOK)).toEqual({ bytes: 0, tasks: 0, calls: 0, pinnedTasks: 0, pinnedBytes: 0 });
    expect((await calls!.prune(BOOK, 0)).dropped).toEqual([]);
    await expect(calls!.keep(BOOK, "activity_x", true)).resolves.toBeUndefined();
    await expect(calls!.deleteBook(BOOK)).resolves.toBeUndefined();
    expect(await copyServerCalls(BOOK, new FakeServer())).toBeNull();
  });

  it("remembers a failure for half a minute, and then tries again", async () => {
    const original = indexedDB.open.bind(indexedDB);
    const open = vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("Not now.", "SecurityError"); });
    expect(await getAiCallStore()).toBeNull();
    expect(await getAiCallStore(), "the failure is remembered").toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    open.mockImplementation(original);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    expect(await getAiCallStore(), "half a minute later it is opened").not.toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("the keys that no record may keep", () => {
  it("are the keys of the AI integrations and the tokens of the site, once each, read when they are asked for", () => {
    expect(browserCallsSecrets()).toEqual([]);
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        defaultGitHubToken: "ghp_defaulttoken0123456789",
        extraGitHubTokens: [{ label: "work", token: "ghp_worktoken0123456789" }, { label: "empty", token: "  " }] as never,
        azureOpenAI: { ...DEFAULT_SETTINGS.azureOpenAI, apiKey: "azure-key-0123456789" },
        aiIntegrations: [
          { id: "i1", name: "Lab", provider: "openai", endpoint: "https://llm.example.com/v1", apiKey: "sk-lab-0123456789", chatModels: [{ id: "m", name: "muse", capabilities: ["default"] }] },
          { id: "i2", name: "Again", provider: "openai", endpoint: "https://other.example.com/v1", apiKey: "sk-lab-0123456789", chatModels: [] },
          { id: "i3", name: "None", provider: "m365_copilot", apiKey: "", chatModels: [] },
        ] as never,
        personalServer: { url: "http://127.0.0.1:24242", token: "server-token-0123456789" },
      },
    });
    const secrets = browserCallsSecrets();
    expect(secrets).toEqual(expect.arrayContaining(["sk-lab-0123456789", "azure-key-0123456789", "ghp_defaulttoken0123456789", "ghp_worktoken0123456789", "server-token-0123456789"]));
    expect(secrets.filter((secret) => secret === "sk-lab-0123456789")).toHaveLength(1);
    expect(secrets.every((secret) => secret.trim().length > 0)).toBe(true);
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, defaultGitHubToken: "ghp_changed0123456789" } }));
    expect(browserCallsSecrets(), "a token the author changes is known to the next call").toContain("ghp_changed0123456789");
  });
});

describe("the copy of a server's records, started from the site", () => {
  it("copies into the store of the tab, and answers with how it went", async () => {
    const server = new FakeServer();
    await server.addTask("activity_1", day(1));
    await server.addTask("activity_2", day(2));
    const report = await copyServerCalls(BOOK, server, "open");
    expect(report).toMatchObject({ state: "done", copied: 2 });
    const store = await getAiCallStore();
    expect((await store!.listTasks(BOOK, { limit: 5 })).tasks.map((task) => task.activityId)).toEqual(["activity_2", "activity_1"]);
    await server.addTask("activity_3", day(3));
    expect(await copyServerCalls(BOOK, server, "run-ended")).toMatchObject({ state: "done", copied: 1 });
    expect(server.counts.task).toBe(3);
  });

  it("belongs to the account the page is in when it is called", async () => {
    const server = new FakeServer();
    await server.addTask("activity_1", day(1));
    await copyServerCalls(BOOK, server);
    useSettingsStore.setState({ accountIdentity: "workspace:wire-b" });
    const store = await getAiCallStore();
    expect((await store!.listTasks(BOOK, { limit: 5 })).tasks, "the other account has nothing").toEqual([]);
    expect(await copyServerCalls(BOOK, server)).toMatchObject({ state: "done", copied: 1 });
    expect((await store!.listTasks(BOOK, { limit: 5 })).tasks).toHaveLength(1);
    useSettingsStore.setState({ accountIdentity: "workspace:wire-a" });
    expect((await store!.listTasks(BOOK, { limit: 5 })).tasks).toHaveLength(1);
  });
});
