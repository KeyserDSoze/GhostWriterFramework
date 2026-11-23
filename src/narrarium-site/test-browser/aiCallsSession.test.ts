import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotSession, parseAutopilotState, type AutopilotEvent } from "narrarium-engine";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "narrarium-engine/testing";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { presentFeedEvent } from "@/autopilot/format";
import { ensureCallsHost, resetCallsHostForTests } from "@/autopilot/calls/host";
import { resetRecordingForTests, setRecording } from "@/autopilot/calls/recording";
import { callsWritesSettled, getAiCallStore, resetAiCallStoreForTests, wireBrowserCalls } from "@/autopilot/calls/wire";
import { resetCopyServicesForTests } from "@/autopilot/calls/copies/services";
import { stopCopiesRuntimeForTests } from "@/autopilot/calls/copies/runtime";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/types/settings";

// The engine's own session, configured as the browser's runtime configures it (`...wireBrowserCalls`), against the browser's IndexedDB store: what is recorded, what the run does
// when there is no store, when the recording is off, and when the store fails in the middle.

const ME = "workspace:session-a";
const BOOK_ID = "book-1";
const STATE = "autopilot/state.json";
const START = { brief: { idea: "A harbor town.", targetChapters: 1, scenesPerChapter: 1, wordsPerScene: 300 }, options: { readers: false, readersOnPlan: false, specialists: false, pauseAfterPlan: false } };
const CALL_EVENTS = new Set(["call-started", "call-ended"]);

async function run(extra: Record<string, unknown> = {}) {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 1 }));
  const events: AutopilotEvent[] = [];
  const session = new AutopilotSession({
    bookId: BOOK_ID,
    store,
    ai: createFakeAutopilotAi({ reviewVerdict: () => "approve", scenes: 1, words: 200 }),
    host: "browser",
    hostLabel: "test browser",
    retryDelayMs: 0,
    ...wireBrowserCalls({ bookId: BOOK_ID }),
    ...extra,
  });
  session.subscribe((event) => events.push(event));
  await session.start(START);
  await session.waitForIdle();
  // The engine does not wait for the store: a run can be over before its records are.
  await callsWritesSettled();
  return { events, state: parseAutopilotState(store.files.get(STATE)) };
}

async function forget(): Promise<void> {
  (await getAiCallStore())?.close();
  resetAiCallStoreForTests();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("narrarium-ai-calls");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  resetAiCallStoreForTests();
}

beforeAll(async () => {
  await loadAutopilotTranslations();
});

beforeEach(() => {
  window.localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ accountIdentity: ME, settings: { ...DEFAULT_SETTINGS, aiIntegrations: [{ id: "i1", name: "Lab", provider: "openai", endpoint: "https://llm.example.com/v1", apiKey: "sk-session-SECRET-0123456789", chatModels: [] }] as never } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  stopCopiesRuntimeForTests();
  resetCopyServicesForTests();
  resetCallsHostForTests();
  await forget();
  window.localStorage.clear();
  resetRecordingForTests();
  useSettingsStore.setState({ accountIdentity: null, settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("a run of the browser's session with the records wired in", () => {
  it("keeps every AI call of every task in the browser's store, for the account, and tells the store when each task is finished", async () => {
    const store = (await ensureCallsHost())!;
    const finished: string[] = [];
    store.onTaskFinished((event) => finished.push(`${event.scope}|${event.activityId}`));
    const { events, state } = await run();
    expect(state?.status, state?.lastError?.message).toBe("completed");
    const started = events.filter((event) => event.type === "call-started");
    expect(started.length).toBeGreaterThanOrEqual(3);
    expect(events.filter((event) => event.type === "call-ended")).toHaveLength(started.length);

    const mine = store.bind(ME);
    const page = await mine.listTasks(BOOK_ID, { limit: 200 });
    const ids = events.filter((event) => event.type === "task-finished").map((event) => (event as { activity: { id: string } }).activity.id);
    expect(page.tasks.map((task) => task.activityId).sort()).toEqual([...ids].sort());
    expect(page.tasks.every((task) => task.status !== "running")).toBe(true);
    expect(new Set(finished)).toEqual(new Set(ids.map((id) => `${ME}|${id}`)));

    const task = (await mine.readTask(BOOK_ID, page.tasks[page.tasks.length - 1].activityId))!;
    expect(task.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of task.calls) {
      expect(call.accountScope, "the records say which account they belong to").toBe(ME);
      expect(call.host).toBe("browser");
      const system = await mine.readText(BOOK_ID, call.callId, "system", 0);
      const user = await mine.readText(BOOK_ID, call.callId, "user", 0);
      expect(system?.text.length).toBeGreaterThan(0);
      expect(user?.text.length).toBeGreaterThan(0);
    }
    expect(await (await getAiCallStore())!.bind("workspace:other").listTasks(BOOK_ID, { limit: 5 }), "another account sees nothing").toEqual({ tasks: [], next: null });
    expect(JSON.stringify(await mine.readTask(BOOK_ID, task.header.activityId)), "no key is kept in a record").not.toContain("sk-session-SECRET");
  });

  it("goes on exactly as it did without the records when this browser keeps no store: the same run, no failure said", async () => {
    const without = await run({ calls: undefined, callsSecrets: undefined, callsAccountScope: undefined });
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("A private window.", "SecurityError"); });
    const unavailable = await run();
    expect(unavailable.state?.status, unavailable.state?.lastError?.message).toBe("completed");
    expect(unavailable.events.some((event) => event.type === "insight" && event.code === "callsStoreFailed")).toBe(false);
    const names = (events: AutopilotEvent[]) => events.filter((event) => event.type === "task-finished").map((event) => (event as { activity: { task: string } }).activity.task);
    expect(names(unavailable.events), "the steps are the same").toEqual(names(without.events));
    expect(unavailable.state?.status).toBe(without.state?.status);
  });

  it("goes on exactly as it did without the records when the book's recording is off on this device, and records nothing at all", async () => {
    setRecording(BOOK_ID, false);
    expect(wireBrowserCalls({ bookId: BOOK_ID })).toEqual({});
    const { events, state } = await run();
    expect(state?.status, state?.lastError?.message).toBe("completed");
    expect(events.some((event) => CALL_EVENTS.has(event.type))).toBe(false);
    const store = await getAiCallStore();
    expect(store === null || (await store.bind(ME).listTasks(BOOK_ID, { limit: 5 })).tasks.length === 0).toBe(true);
  });

  it("says once that the records could not be kept, in the words of the author, when the store fails in the middle, and the run goes on", async () => {
    await ensureCallsHost();
    const put = IDBObjectStore.prototype.put;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "calls" && (calls += 1) > 2) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    });
    const { events, state } = await run();
    expect(state?.status, state?.lastError?.message).toBe("completed");
    const failures = events.filter((event) => event.type === "insight" && event.code === "callsStoreFailed");
    expect(failures).toHaveLength(1);
    const failure = failures[0] as Extract<AutopilotEvent, { type: "insight" }>;
    expect(failure.tone).toBe("warning");

    const english = presentFeedEvent(i18n.t.bind(i18n), failure);
    expect(english?.text).toMatch(/^The messages of this run could not be saved \(.+\)\. The run goes on, but they will not be kept\.$/);
    expect(english?.detail, "the reason is in the sentence, said once").toBeUndefined();
    await i18n.changeLanguage("it");
    const italian = presentFeedEvent(i18n.t.bind(i18n), failure);
    expect(italian?.text).toMatch(/^Non è stato possibile salvare i messaggi di questa esecuzione \(.+\)\. L'esecuzione prosegue, ma i messaggi non verranno conservati\.$/);
  });
});

describe("the notice that the records could not be kept", () => {
  const notice = (patch: Record<string, unknown>) => ({ type: "insight", tone: "warning", code: "callsStoreFailed", title: "The AI call records could not be kept: recording stops for this run.", ...patch }) as AutopilotEvent;

  it("is said with its reason in the sentence when the engine gives one, and without when it gives none, in both languages", async () => {
    for (const [language, withReason, without] of [
      ["en", "The messages of this run could not be saved (disk full). The run goes on, but they will not be kept.", "The messages of this run could not be saved. The run goes on, but they will not be kept."],
      ["it", "Non è stato possibile salvare i messaggi di questa esecuzione (disk full). L'esecuzione prosegue, ma i messaggi non verranno conservati.", "Non è stato possibile salvare i messaggi di questa esecuzione. L'esecuzione prosegue, ma i messaggi non verranno conservati."],
    ] as const) {
      await i18n.changeLanguage(language);
      expect(presentFeedEvent(i18n.t.bind(i18n), notice({ detail: "disk full" }))).toMatchObject({ tone: "warning", text: withReason, detail: undefined });
      expect(presentFeedEvent(i18n.t.bind(i18n), notice({})), language).toMatchObject({ text: without });
      expect(presentFeedEvent(i18n.t.bind(i18n), notice({ detail: "   " })), language).toMatchObject({ text: without });
    }
  });
});
