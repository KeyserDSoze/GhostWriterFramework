import { beforeEach, expect, test } from "vitest";
import type { AutopilotActivity, AutopilotEvent, AutopilotStateSummary } from "narrarium-engine";
import { latestFeedEntry, useAutopilotStore } from "@/autopilot/store";
import { autopilotSummaryLine, formatDuration, presentFeedEvent, syncStatusText } from "@/autopilot/format";

const at = "2026-11-21T10:00:00.000Z";
const activity = {
  id: "activity-1",
  runId: "run-1",
  task: "write",
  phase: "write",
  title: "Writing scene 1 of chapter 1",
  reason: "The scene plan is ready.",
  next: "Write scene 2.",
  status: "running",
  startedAt: at,
} as AutopilotActivity;

function event(body: Record<string, unknown>, seq: number): AutopilotEvent {
  return { bookId: "book-1", at, seq, ...body } as AutopilotEvent;
}

const t = ((key: string, options?: { defaultValue?: string; [name: string]: unknown }) => `t:${key}${options && "status" in options ? `:${String(options.status)}` : ""}`) as never;

beforeEach(() => {
  useAutopilotStore.setState({ feed: [], live: {}, summaries: {} });
});

test("live previews follow the running step and the feed keeps meaningful events only", () => {
  const { ingest } = useAutopilotStore.getState();
  ingest(event({ type: "task-started", activity }, 1), "Book");
  ingest(event({ type: "task-progress", activityId: "activity-1", characters: 9, preview: "Once upon" }, 2), "Book");
  expect(useAutopilotStore.getState().live["book-1"]?.preview).toBe("Once upon");
  ingest(event({ type: "task-progress", activityId: "another-activity", characters: 3, preview: "nope" }, 3), "Book");
  expect(useAutopilotStore.getState().live["book-1"]?.characters).toBe(9);

  ingest(event({ type: "state", state: { status: "running", updatedAt: at } as AutopilotStateSummary }, 4), "Book");
  expect(useAutopilotStore.getState().summaries["book-1"].status).toBe("running");

  const finished = event({ type: "task-finished", activity: { ...activity, status: "succeeded", summary: "420 words" } }, 5);
  ingest(finished, "Book");
  ingest(finished, "Book");
  const state = useAutopilotStore.getState();
  expect(state.live["book-1"]).toBeNull();
  expect(state.feed.map((entry) => entry.event.type)).toEqual(["task-started", "task-finished"]);
  expect(latestFeedEntry(state.feed, "book-1")?.event.seq).toBe(5);
  expect(latestFeedEntry(state.feed, "missing")).toBeUndefined();
});

test("runner messages use their codes for the UI language, task results keep the book language", () => {
  expect(presentFeedEvent(t, event({ type: "insight", tone: "warning", code: "failureRetry", title: "The step failed: retrying once." }, 1))?.text).toBe("t:autopilot.insight.failureRetry");
  expect(presentFeedEvent(t, event({ type: "insight", tone: "ok", title: "Capitolo 1 approvato (8/10)" }, 2))?.text).toBe("Capitolo 1 approvato (8/10)");
  expect(presentFeedEvent(t, event({ type: "run-ended", runId: "run-1", status: "completed", message: "The book is complete." }, 3))).toMatchObject({ tone: "ok", text: "t:autopilot.feed.runEnded:t:autopilot.status.completed", detail: "The book is complete." });
  const failed = presentFeedEvent(t, event({ type: "task-finished", activity: { ...activity, status: "failed", error: "HTTP 401" } }, 4));
  expect(failed).toMatchObject({ tone: "critical", detail: "HTTP 401" });
  expect(presentFeedEvent(t, event({ type: "task-started", activity }, 5))).toBeNull();
  expect(syncStatusText(t, { at, ok: false, message: "conflicts:2" })).toBe("t:autopilot.where.conflicts");
  expect(syncStatusText(t, { at, ok: false, message: "HTTP 500" })).toBe("HTTP 500");
  expect(syncStatusText(t, null)).toBeNull();
});

test("the summary line leaves out the phase once the book is completed", () => {
  const plain = ((key: string) => key) as never;
  const summary = { phase: "write", progress: { chaptersDone: 1, chapters: 3, words: 4200 } } as AutopilotStateSummary;
  expect(autopilotSummaryLine(plain, summary)).toMatch(/^autopilot\.phase\.write · autopilot\.progress\.chapters: 1\/3 · autopilot\.progress\.words: 4[,.]?200$/);
  expect(autopilotSummaryLine(plain, { ...summary, phase: "completed" })).toMatch(/^autopilot\.progress\.chapters: 1\/3 · /);
});

test("the feed is kept for the next visit, even when the page closes before the delayed save", () => {
  const key = "narrarium-autopilot-feed-v1";
  window.dispatchEvent(new Event("pagehide"));
  localStorage.removeItem(key);
  useAutopilotStore.getState().ingest(event({ type: "insight", tone: "ok", title: "Chapter 1 approved" }, 7), "Book");
  expect(localStorage.getItem(key)).toBeNull();
  window.dispatchEvent(new Event("pagehide"));
  const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ event: { title?: string } }>;
  expect(saved[saved.length - 1]?.event.title).toBe("Chapter 1 approved");
});

test("durations read naturally", () => {
  expect(formatDuration(4_200)).toBe("4s");
  expect(formatDuration(65_000)).toBe("1m 05s");
  expect(formatDuration(3_780_000)).toBe("1h 03m");
  expect(formatDuration(Number.NaN)).toBe("—");
});
