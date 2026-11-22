import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutopilotState, type AutopilotEvent, type AutopilotState, type AutopilotStateSummary, type ServerBookSummary } from "narrarium-engine";
import { selectFocusBook, useFocusBook, type FocusInput } from "@/autopilot/useFocusBook";
import { emptyView, useAutopilotStore } from "@/autopilot/store";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type BookEntry } from "@/types/settings";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const book = (id: string, name = `Book ${id}`): BookEntry => ({ id, owner: "local", repo: id, name, tokenIndex: null, storageMode: "local-only", addedAt: "2026-11-21T00:00:00.000Z" });
const BOOKS = [book("a", "Alpha"), book("b", "Beta"), book("c", "Gamma")];

function input(patch: Partial<FocusInput> = {}): FocusInput {
  return { routeBookId: undefined, books: BOOKS, running: new Set(), recent: [], chosen: null, ...patch };
}

describe("which book the live panel commands", () => {
  it("is the book of the page you are in, even when another one is running", () => {
    const choice = selectFocusBook(input({ routeBookId: "a", running: new Set(["b"]), recent: ["b", "a"] }));
    expect(choice.focus).toMatchObject({ id: "a", name: "Alpha" });
    expect(choice.why).toBe("route");
  });

  it("is the only book that runs, wherever it runs, when you are not in a book", () => {
    const choice = selectFocusBook(input({ running: new Set(["c"]), recent: ["a", "c"] }));
    expect(choice.focus).toMatchObject({ id: "c", running: true });
    expect(choice.why).toBe("only-running");
  });

  it("is the book that was active most recently when none runs", () => {
    const choice = selectFocusBook(input({ recent: ["b", "a"] }));
    expect(choice.focus?.id).toBe("b");
    expect(choice.why).toBe("recent");
  });

  it("is the one that was active most recently among those that run, when several do", () => {
    const choice = selectFocusBook(input({ running: new Set(["a", "c"]), recent: ["b", "c", "a"] }));
    expect(choice.focus?.id).toBe("c");
    expect(choice.why).toBe("recent");
    expect(choice.candidates.map((candidate) => candidate.id)).toEqual(["c", "a"]);
  });

  it("is none, and so there is no bar, when you are not in a book and nothing ever ran", () => {
    expect(selectFocusBook(input()).focus).toBeNull();
    expect(selectFocusBook(input()).candidates).toEqual([]);
  });

  it("ignores a book that is not in the library any more", () => {
    expect(selectFocusBook(input({ routeBookId: "gone" })).focus).toBeNull();
    expect(selectFocusBook(input({ routeBookId: "gone", running: new Set(["b"]) })).focus?.id).toBe("b");
    expect(selectFocusBook(input({ recent: ["gone", "a"] })).focus?.id).toBe("a");
    expect(selectFocusBook(input({ running: new Set(["gone"]) })).focus).toBeNull();
  });

  it("is the book the author chose, while it is in the library, over what the page and the runs say", () => {
    const choice = selectFocusBook(input({ routeBookId: "a", running: new Set(["b", "c"]), chosen: "c" }));
    expect(choice.focus?.id).toBe("c");
    expect(choice.why).toBe("chosen");
    expect(selectFocusBook(input({ routeBookId: "a", chosen: "gone" })).focus?.id).toBe("a");
  });

  it("offers the page's book, the running ones and the chosen one, once each, each with its name and whether it runs", () => {
    const choice = selectFocusBook(input({ routeBookId: "a", running: new Set(["a", "b"]), chosen: "c", recent: ["b"] }));
    expect(choice.candidates).toEqual([
      { id: "a", name: "Alpha", running: true },
      { id: "b", name: "Beta", running: true },
      { id: "c", name: "Gamma", running: false },
    ]);
  });

  it("offers nothing to choose from when there is one book to command", () => {
    expect(selectFocusBook(input({ running: new Set(["a"]) })).candidates).toHaveLength(1);
    expect(selectFocusBook(input({ routeBookId: "a" })).candidates).toHaveLength(1);
  });
});

function Wrapper({ path, children }: { path: string; children: ReactNode }) {
  return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
}

const summaryOf = (patch: Partial<AutopilotStateSummary> = {}): AutopilotStateSummary => ({
  status: "paused",
  phase: "write",
  message: null,
  progress: { chapters: 1, chaptersDone: 0, scenes: 0, scenesWritten: 0, words: 0 },
  question: null,
  lastError: null,
  runner: null,
  stats: { tasks: 0, aiCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, failures: 0 },
  pendingNotes: 0,
  constraints: 0,
  updatedAt: new Date(T0).toISOString(),
  ...patch,
});

const runnerOf = (heartbeatAt: number) => ({ host: "server" as const, label: "Home server", hostId: "server-1", runId: "run-1", startedAt: new Date(T0 - 3_600_000).toISOString(), heartbeatAt: new Date(heartbeatAt).toISOString() });
const stateEvent = (bookId: string, summary: AutopilotStateSummary, seq: number) => ({ bookId, at: summary.updatedAt, seq, type: "state", state: summary }) as AutopilotEvent;
const serverBook = (bookId: string, running: boolean): ServerBookSummary => ({ bookId, title: bookId, storage: { kind: "local" }, hasGithubToken: false, ready: true, revision: "r1", autopilot: null, running, lastSync: null });

function seedStore(patch: { summaries?: Record<string, AutopilotStateSummary>; snapshots?: Record<string, { running: boolean; state?: Partial<AutopilotState> }>; serverBooks?: ServerBookSummary[]; busyInAnotherTab?: string[] } = {}) {
  const views: Record<string, ReturnType<typeof emptyView>> = {};
  for (const entry of BOOKS) views[entry.id] = emptyView(entry.id);
  for (const [id, snap] of Object.entries(patch.snapshots ?? {})) {
    const state = { ...createAutopilotState(new Date(T0)), updatedAt: new Date(T0).toISOString(), ...snap.state } as AutopilotState;
    views[id] = { ...views[id], snapshot: { bookId: id, state, activities: [], live: null, running: snap.running, host: null } };
  }
  for (const id of patch.busyInAnotherTab ?? []) views[id] = { ...views[id], busyInAnotherTab: true };
  useAutopilotStore.setState({
    views,
    summaries: patch.summaries ?? {},
    feed: [],
    live: {},
    dockFocusBook: null,
    server: { status: "online", info: null, message: null, books: patch.serverBooks ?? [], updates: null, connection: null },
  });
}

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: BOOKS } });
  seedStore();
});

afterEach(() => {
  cleanup();
  useAutopilotStore.setState({ views: {}, summaries: {}, feed: [], live: {}, dockFocusBook: null, server: { status: "disabled", info: null, message: null, books: [], updates: null, connection: null } });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("useFocusBook", () => {
  const focusAt = (path: string) => renderHook(() => useFocusBook(), { wrapper: ({ children }) => <Wrapper path={path}>{children}</Wrapper> });

  it("follows the page: the book of the route is the one", () => {
    const { result } = focusAt("/app/books/b/autopilot");
    expect(result.current.focus).toMatchObject({ id: "b", name: "Beta" });
    expect(result.current.why).toBe("route");
  });

  it("finds a book the server runs from what the connection says of it, though nothing was heard of it yet", () => {
    seedStore({ serverBooks: [serverBook("c", true)] });
    const { result } = focusAt("/app/books");
    expect(result.current.focus).toMatchObject({ id: "c", running: true });
    expect(result.current.why).toBe("only-running");
  });

  it("finds a book that runs in another tab of this browser", () => {
    seedStore({ busyInAnotherTab: ["a"], snapshots: { a: { running: false, state: { status: "running" } } } });
    expect(focusAt("/app/books").result.current.focus?.id).toBe("a");
  });

  it("finds a book whose live summary says it runs", () => {
    seedStore({ summaries: { b: summaryOf({ status: "running", runner: runnerOf(Date.now()) }) } });
    expect(focusAt("/app/autopilot").result.current.focus?.id).toBe("b");
  });

  it("does not take for running a book whose saved state says so but whose runner has been silent for hours", () => {
    seedStore({ snapshots: { a: { running: false, state: { status: "running", runner: runnerOf(Date.now() - 3 * 3_600_000) } } } });
    const { result } = focusAt("/app/books");
    expect(result.current.focus?.running ?? false).toBe(false);
  });

  it("falls back to the book that was active most recently, by what the live events say", () => {
    // These books have not been heard of by any other test: what a tab heard is kept for as long as it lives.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, books: [...BOOKS, book("r1", "First"), book("r2", "Second")] } });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      useAutopilotStore.getState().ingest(stateEvent("r1", summaryOf({ updatedAt: new Date(T0).toISOString() }), 1), "First");
      vi.setSystemTime(T0 + 5000);
      useAutopilotStore.getState().ingest(stateEvent("r2", summaryOf({ updatedAt: new Date(T0 + 5000).toISOString() }), 2), "Second");
    } finally {
      vi.useRealTimers();
    }
    const { result } = focusAt("/app/books");
    expect(result.current.focus).toMatchObject({ id: "r2", name: "Second" });
    expect(result.current.why).toBe("recent");
  });

  it("has no book in focus when nothing has happened and you are not in a book", () => {
    const { result } = focusAt("/app/books");
    expect(result.current.focus).toBeNull();
    expect(result.current.candidates).toEqual([]);
  });

  it("lets the author choose another of the candidates, and take the choice back", () => {
    seedStore({ serverBooks: [serverBook("b", true), serverBook("c", true)] });
    const { result } = focusAt("/app/books/a/autopilot");
    expect(result.current.candidates.map((candidate) => candidate.id).sort()).toEqual(["a", "b", "c"]);
    act(() => result.current.choose("c"));
    expect(result.current.focus).toMatchObject({ id: "c" });
    expect(result.current.why).toBe("chosen");
    act(() => result.current.choose(null));
    expect(result.current.focus?.id).toBe("a");
  });

  it("forgets the choice when the author goes to another book", () => {
    seedStore({ serverBooks: [serverBook("b", true)] });
    const { result } = renderHook(() => ({ focus: useFocusBook(), navigate: useNavigate() }), { wrapper: ({ children }) => <Wrapper path="/app/books/a/autopilot">{children}</Wrapper> });
    act(() => result.current.focus.choose("b"));
    expect(result.current.focus.focus?.id).toBe("b");
    act(() => result.current.navigate("/app/books/c/autopilot"));
    expect(result.current.focus.focus).toMatchObject({ id: "c", name: "Gamma" });
    expect(useAutopilotStore.getState().dockFocusBook).toBeNull();
  });
});
