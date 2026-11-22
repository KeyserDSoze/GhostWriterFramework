import type { AutopilotActivity, AutopilotEvent, AutopilotTaskKind } from "narrarium-engine";

/** The moment the fake log starts at; `sec(n)` is n seconds later. */
export const START = Date.parse("2026-11-21T09:00:00.000Z");
export const sec = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

let counter = 0;
export const resetIds = () => { counter = 0; };

export interface StepSeed extends Partial<AutopilotActivity> {
  /** Seconds after START that the step starts, and how long it takes. */
  from: number;
  length?: number;
}

/** A finished step of the log (or any other status with `status`). */
export function stepOf(task: AutopilotTaskKind, seed: StepSeed): AutopilotActivity {
  counter += 1;
  const { from, length = 30, ...patch } = seed;
  const status = patch.status ?? "succeeded";
  return {
    id: `a${counter}`,
    runId: "run-1",
    task,
    phase: task === "write" || task === "scenes" ? "write" : "review",
    title: `${task} ${patch.chapterNumber ?? ""} ${patch.sceneNumber ?? ""} ${patch.reader ?? ""}`.replace(/\s+/g, " ").trim(),
    reason: "",
    next: "",
    status,
    startedAt: sec(from),
    ...(status === "running" ? {} : { endedAt: sec(from + length) }),
    ...patch,
  };
}

export interface ChapterFlow {
  activities: AutopilotActivity[];
  /** Where the flow ended, in seconds after START: the next one starts there. */
  end: number;
}

/**
 * A chapter the way the autopilot works through it: the plan of its scenes, three scenes, three readers and their summary, then rounds of the
 * specialists and the director (each round but the last asks for fixes), and the closing. `rounds` is how many times the director judges.
 */
export function chapterFlow(chapter: number, options: { from?: number; rounds?: number; scenes?: number; approved?: boolean; closed?: boolean } = {}): ChapterFlow {
  const { from = 0, rounds = 2, scenes = 3, approved = true, closed = true } = options;
  const list: AutopilotActivity[] = [];
  let at = from;
  const push = (task: AutopilotTaskKind, patch: Partial<AutopilotActivity> = {}, length = 40) => {
    list.push(stepOf(task, { from: at, length, chapterNumber: chapter, title: `${task} of chapter ${chapter}${patch.sceneNumber ? ` scene ${patch.sceneNumber}` : ""}${patch.reader ? ` by ${patch.reader}` : ""}`, ...patch }));
    at += length + 3;
  };
  push("scenes");
  for (let scene = 1; scene <= scenes; scene += 1) push("write", { sceneNumber: scene, summary: `${600 + scene * 20} words — what happens in scene ${scene}`, model: "fake-model", provider: "openai", usage: { inputTokens: 4000 + scene, outputTokens: 900, cachedInputTokens: 100 }, cost: 0.03 });
  for (const reader of ["ada", "bruno", "chiara"]) push("reader", { reader });
  push("readers-summary");
  for (let round = 1; round <= rounds; round += 1) {
    push("specialists", { title: `Specialists review chapter ${chapter} (round ${round})` });
    const last = round === rounds;
    push("director-review", { title: `The director judges chapter ${chapter} (round ${round})`, summary: last && approved ? `approve 8/10 — 2 accepted, 0 rejected. The pace holds.` : `revise 6/10 — 2 accepted, 1 rejected. The middle drags.` });
    if (!last) push("repair", { sceneNumber: 2, title: `Applying the director's fixes to scene 2 of chapter ${chapter}` });
  }
  if (closed) push("consolidate", { title: `Closing chapter ${chapter}` });
  return { activities: list, end: at };
}

const base = { bookId: "book-1" };
let seq = 0;
export const resetSeq = () => { seq = 0; };

/** An event of the book at a given moment (seconds after START). */
export function eventAt(seconds: number, body: Record<string, unknown>): AutopilotEvent {
  seq += 1;
  return { ...base, at: sec(seconds), seq, ...body } as AutopilotEvent;
}

export const insightFor = (activity: AutopilotActivity, tone: "ok" | "info" | "warning" | "critical", title: string, detail?: string, seconds?: number) =>
  eventAt(seconds ?? Date.parse(activity.endedAt ?? activity.startedAt) / 1000 - START / 1000 - 1, { type: "insight", activityId: activity.id, tone, title, ...(detail ? { detail } : {}) });

export const finishedEvent = (activity: AutopilotActivity) => eventAt((Date.parse(activity.endedAt ?? activity.startedAt) - START) / 1000, { type: "task-finished", activity });

export const retryNotice = (seconds: number, attempt: number, retries = 3, waitMs = 20_000) =>
  eventAt(seconds, { type: "insight", tone: "warning", code: "failureRetry", title: `The step failed: retry ${attempt} of ${retries} in ${waitMs / 1000} s.`, detail: "The AI provider answered 429.", attempt, retries, waitMs });

export const runStarted = (seconds: number) => eventAt(seconds, { type: "run-started", runId: "run-1", host: "browser" });
export const runEnded = (seconds: number, status: "paused" | "error" | "completed" | "waiting-author" = "paused", message: string | null = null) => eventAt(seconds, { type: "run-ended", runId: "run-1", status, message });

/**
 * A log with what a real run leaves in it, and the feed that went with it: two chapters (the second still in its first round), a step that
 * failed and was retried, the notes of the readers, the specialists and the director under their steps, the start of a run and the way it ended.
 */
export function richHistory(): { activities: AutopilotActivity[]; feed: AutopilotEvent[] } {
  resetIds();
  resetSeq();
  const first = chapterFlow(3, { from: 0 });
  const second = chapterFlow(4, { from: first.end + 10, rounds: 1, closed: false });
  const retried = second.activities.find((activity) => activity.task === "write") as AutopilotActivity;
  const failed = stepOf("write", { from: (Date.parse(retried.startedAt) - START) / 1000 - 20, length: 10, chapterNumber: 4, sceneNumber: 1, title: retried.title, status: "failed", error: "The provider answered 429 (rate limit exceeded)." });
  const activities = [...first.activities, failed, ...second.activities];
  const lastEnd = (Date.parse(second.activities[second.activities.length - 1].endedAt!) - START) / 1000;
  const feed = [
    runStarted(1),
    ...activities.flatMap((activity) => [finishedEvent(activity), insightFor(activity, activity.task === "specialists" ? "warning" : "ok", `Note about ${activity.title}`, `What it says about ${activity.title}.`)]),
    retryNotice((Date.parse(failed.endedAt!) - START) / 1000 + 1, 1),
    runEnded(lastEnd + 5, "paused", "Chapter 4 approved: read it and resume."),
  ];
  return { activities, feed };
}

/** The same steps, but every read of a title is counted: a row of the timeline reads the title of its step each time it is drawn. */
export function countActivityReads(activities: readonly AutopilotActivity[], reads: Map<string, number>): AutopilotActivity[] {
  return activities.map((activity) => {
    const title = activity.title;
    return Object.defineProperty({ ...activity }, "title", { enumerable: true, configurable: true, get: () => { reads.set(activity.id, (reads.get(activity.id) ?? 0) + 1); return title; } }) as AutopilotActivity;
  });
}
