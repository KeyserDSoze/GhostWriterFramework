import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAutopilotState, type AutopilotSnapshot, type AutopilotState } from "narrarium-engine";
import i18n from "@/i18n";
import { loadAutopilotTranslations } from "@/i18n/autopilot";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const BOOK: BookEntry = { id: "book-1", owner: "local", repo: "book-1", name: "The Glass Harbor", tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" };
const SERVER_BOOK: BookEntry = { ...BOOK, autopilotHost: "server" };
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function runnerOf(host: "browser" | "server", label: string, heartbeatAt = minutesAgo(4)) {
  return { host, label, hostId: `${host}-other`, runId: "run-1", startedAt: minutesAgo(30), heartbeatAt };
}

function seed(options: { book?: BookEntry; status?: AutopilotState["status"]; runner?: AutopilotState["runner"]; running?: boolean; busyInAnotherTab?: boolean }) {
  const book = options.book ?? BOOK;
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [book] } });
  const state: AutopilotState = { ...createAutopilotState(new Date()), status: options.status ?? "running", phase: "write", runner: options.runner ?? null, updatedAt: new Date().toISOString() };
  const snapshot: AutopilotSnapshot = { bookId: book.id, state, activities: [], live: null, running: options.running ?? false, host: null };
  useAutopilotStore.setState({
    views: { [book.id]: { ...emptyView(book.id), snapshot, busyInAnotherTab: options.busyInAnotherTab ?? false } },
    summaries: {},
    live: {},
    feed: [],
  });
}

function control(options: Parameters<typeof seed>[0]) {
  seed(options);
  return renderHook(() => useAutopilotControl("book-1")).result.current;
}

beforeAll(async () => {
  await loadAutopilotTranslations();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, live: {}, feed: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("what the control hook tells", () => {
  it("says a run of this tab can be commanded", () => {
    expect(control({ running: true, runner: runnerOf("browser", "This browser") })).toMatchObject({ running: true, controllable: true, reason: null, canTakeOver: false });
  });

  it("says a run of another tab can be commanded", () => {
    expect(control({ busyInAnotherTab: true, runner: runnerOf("browser", "This browser") })).toMatchObject({ running: true, controllable: true, canTakeOver: false });
  });

  it("says a run of another device cannot be, and who runs it, and how long ago it was heard of", () => {
    const result = control({ runner: runnerOf("browser", "Browser · Android", minutesAgo(4)) });
    expect(result).toMatchObject({ running: true, controllable: false, reason: "other-host", runnerLabel: "Browser · Android", runnerHost: "browser", canTakeOver: true });
    expect(result.heartbeatAge).toBeGreaterThanOrEqual(4 * 60_000);
    expect(result.heartbeatAge).toBeLessThan(4 * 60_000 + 5_000);
  });

  it("says the same of a run registered by the server when the book is hosted in this browser", () => {
    expect(control({ runner: runnerOf("server", "Home server") })).toMatchObject({ controllable: false, reason: "other-host", runnerHost: "server", canTakeOver: true });
  });

  it("counts the age from the freshest signal: an event received later than the heartbeat", () => {
    seed({ runner: runnerOf("server", "Home server", minutesAgo(10)) });
    useAutopilotStore.getState().ingest({ bookId: "book-1", at: new Date().toISOString(), seq: 1, type: "task-progress", activityId: "a", characters: 3, preview: "…" }, "The Glass Harbor");
    const result = renderHook(() => useAutopilotControl("book-1")).result.current;
    expect(result.heartbeatAge).toBeLessThan(5_000);
  });

  it("takes no stand when nothing runs", () => {
    expect(control({ status: "paused", runner: null })).toMatchObject({ running: false, controllable: false, reason: null, canTakeOver: false, heartbeatAge: null, runnerLabel: null });
  });

  it("still says it runs elsewhere when the stored state does not say who runs", () => {
    expect(control({ runner: null })).toMatchObject({ running: true, controllable: false, reason: "other-host", runnerLabel: null, canTakeOver: true });
  });

  it("lets the snapshot decide whether the server's run can be commanded: while it says the book is not running here, it is another host's", () => {
    expect(control({ book: SERVER_BOOK, running: true, runner: runnerOf("server", "Home server", new Date().toISOString()) })).toMatchObject({ controllable: true, canTakeOver: false });
    expect(control({ book: SERVER_BOOK, running: false, runner: runnerOf("server", "Home server", new Date().toISOString()) })).toMatchObject({ controllable: false, reason: "other-host", canTakeOver: true });
  });

  it("keeps up with the store", () => {
    seed({ status: "paused", runner: null });
    const { result } = renderHook(() => useAutopilotControl("book-1"));
    expect(result.current.running).toBe(false);
    act(() => {
      useAutopilotStore.setState((state) => {
        const view = state.views["book-1"];
        const running = { ...view.snapshot!.state!, status: "running" as const, runner: runnerOf("browser", "This browser") };
        return { views: { ...state.views, "book-1": { ...view, busyInAnotherTab: true, snapshot: { ...view.snapshot!, state: running } } } };
      });
    });
    expect(result.current).toMatchObject({ running: true, controllable: true });
  });

  it("follows a status that only the live events know", () => {
    seed({ status: "paused", runner: null });
    const { result } = renderHook(() => useAutopilotControl("book-1"));
    act(() => {
      useAutopilotStore.getState().ingest({
        bookId: "book-1",
        at: new Date(Date.now() + 1_000).toISOString(),
        seq: 2,
        type: "state",
        state: { status: "running", phase: "write", message: null, progress: { chapters: 1, chaptersDone: 0, scenes: 0, scenesWritten: 0, words: 0 }, question: null, lastError: null, runner: runnerOf("server", "Home server"), stats: { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 }, pendingNotes: 0, constraints: 0, updatedAt: new Date(Date.now() + 1_000).toISOString() },
      }, "The Glass Harbor");
    });
    expect(result.current).toMatchObject({ running: true, controllable: false, runnerLabel: "Home server", canTakeOver: true });
  });
});

describe("the texts of the control", () => {
  const KEYS = ["runningElsewhere", "pauseElsewhere", "lastSignal", "takeOver", "takeOverTitle", "takeOverBody", "takeOverEffect", "takeOverAdvice", "takeOverConfirm", "anotherHost"];
  it.each(["en", "it"])("exist in %s", (lng) => {
    for (const key of KEYS) expect(i18n.exists(`autopilot.control.${key}`, { lng }), key).toBe(true);
  });
});

