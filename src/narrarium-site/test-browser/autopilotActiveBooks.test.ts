import { describe, expect, it } from "vitest";
import { createAutopilotState, runnerActivity, summarizeAutopilotState, type AutopilotActivity, type AutopilotState, type AutopilotStateSummary, type DirectorQuestion } from "narrarium-engine";
import { ACTIVE_RECENT_MS, activeBooks, activeCounts, type ActiveBooksInput } from "@/autopilot/activeBooks";
import { latestSummary } from "@/autopilot/summary";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function stateOf(status: AutopilotState["status"], patch: Partial<AutopilotState> = {}, msAgo = 60_000): AutopilotState {
  const at = iso(msAgo);
  const runner = status === "running" ? { host: "browser" as const, label: "This browser", runId: "run-1", startedAt: at, heartbeatAt: at } : null;
  return { ...createAutopilotState(new Date(at)), status, runner, updatedAt: at, ...patch };
}

const summaryOf = (state: AutopilotState): AutopilotStateSummary => summarizeAutopilotState(state);
const step = (id: string, title: string): AutopilotActivity => ({ id, runId: "run-1", task: "write", phase: "write", title, reason: "", next: "", status: "running", startedAt: iso(30_000) });
const QUESTION: DirectorQuestion = { id: "q-1", kind: "director", question: "Keep the ending open?", context: "", options: [], askedAt: iso(60_000) };

const BOOKS = [
  { id: "glass", name: "The Glass Harbor" },
  { id: "tide", name: "Tide Lines", autopilotHost: "server" },
  { id: "salt", name: "Salt and Silence" },
  { id: "ember", name: "Ember Road" },
  { id: "old", name: "An Old Pause" },
  { id: "done", name: "Finished Book" },
];

function input(patch: Partial<ActiveBooksInput> = {}): ActiveBooksInput {
  const running = stateOf("running");
  const asking = stateOf("waiting-author", { question: QUESTION });
  const paused = stateOf("paused");
  const oldPause = stateOf("paused", {}, ACTIVE_RECENT_MS + 60_000);
  const completed = stateOf("completed");
  return {
    books: BOOKS,
    summaries: { glass: summaryOf(running) },
    views: {
      salt: { snapshot: { state: asking, summary: summaryOf(asking) } },
      ember: { snapshot: { state: paused, summary: summaryOf(paused) } },
      old: { snapshot: { state: oldPause, summary: summaryOf(oldPause) } },
      done: { snapshot: { state: completed, summary: summaryOf(completed) } },
    },
    serverBooks: [{ bookId: "tide", running: true, autopilot: summaryOf(stateOf("running")) }],
    live: { glass: { activity: step("s-glass", "Writing scene 2 of chapter 3") } },
    now: NOW,
    summarize: latestSummary,
    runnerActivity,
    ...patch,
  };
}

describe("the books whose autopilot the author sees at a glance", () => {
  it("are the ones waiting for the author first, then the ones that run (with their host and their step), then the ones paused lately", () => {
    const books = activeBooks(input());
    expect(books.map((book) => [book.id, book.kind, book.state, book.host])).toEqual([
      ["salt", "attention", "question", "browser"],
      ["glass", "running", "running", "browser"],
      ["tide", "running", "running", "server"],
      ["ember", "paused", "paused", "browser"],
    ]);
    expect(books.find((book) => book.id === "glass")?.step?.title).toBe("Writing scene 2 of chapter 3");
    expect(books.find((book) => book.id === "tide")?.step).toBeNull();
  });

  it("leave out a pause of more than a day, a finished book, and a book whose run nobody has heard of for a long time", () => {
    const silent = stateOf("running", {}, 2 * 60 * 60 * 1000);
    const books = activeBooks(input({ summaries: { glass: summaryOf(silent) }, live: {} }));
    expect(books.map((book) => book.id)).toEqual(["salt", "tide", "ember"]);
  });

  it("take a summary that says its book runs at its word until the engine's rule for a runner still alive is there (the launcher, before it loads it)", () => {
    const silent = stateOf("running", {}, 2 * 60 * 60 * 1000);
    const books = activeBooks(input({ summaries: { glass: summaryOf(silent) }, live: {}, runnerActivity: undefined }));
    expect(books.map((book) => book.id)).toEqual(["salt", "glass", "tide", "ember"]);
  });

  it("count a run that another tab or the session itself says goes on, and a retry as a run that waits", () => {
    const retrying: AutopilotStateSummary = { ...summaryOf(stateOf("running")), retry: { attempt: 2, retries: 3, at: iso(-30_000) } as unknown as AutopilotStateSummary["retry"] };
    const books = activeBooks(input({
      books: [BOOKS[0], BOOKS[2]],
      summaries: { glass: retrying },
      views: { salt: { snapshot: { state: stateOf("paused"), running: false }, busyInAnotherTab: true } },
      serverBooks: [],
    }));
    expect(books.map((book) => [book.id, book.kind, book.state])).toEqual([["glass", "running", "retrying"], ["salt", "running", "running"]]);
  });

  it("say how many run and how many wait for the author, with the names of the ones that run", () => {
    expect(activeCounts(activeBooks(input()))).toEqual({ running: 2, attention: 1, names: ["The Glass Harbor", "Tide Lines"] });
    expect(activeCounts([])).toEqual({ running: 0, attention: 0, names: [] });
  });

  it("are none in a library where nothing ever ran", () => {
    expect(activeBooks(input({ summaries: {}, views: {}, serverBooks: [], live: {} }))).toEqual([]);
  });
});
