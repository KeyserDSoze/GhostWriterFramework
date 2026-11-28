import { beforeEach, describe, expect, it } from "vitest";
import type { AutopilotActivity, ChapterRound } from "narrarium-engine";
import {
  GROUP_ROWS,
  MAX_MARKERS,
  MAX_ROWS,
  ROW_STEP,
  TIMELINE_FILTERS,
  buildTimeline,
  categoryOf,
  filterCounts,
  filterTimeline,
  nextLimit,
  roundResultOf,
  type Timeline,
  type TimelineGroup,
  type TimelineStep,
} from "@/autopilot/timelineModel";
import { START, chapterFlow, eventAt, finishedEvent, insightFor, resetIds, resetSeq, retryNotice, runEnded, runStarted, sec, stepOf } from "./helpers/autopilotTimeline";

beforeEach(() => {
  resetIds();
  resetSeq();
});

const stepsOf = (timeline: Timeline): TimelineStep[] => timeline.groups.flatMap((group) => group.rows.filter((row): row is TimelineStep => row.kind === "step"));
const group = (timeline: Timeline, key: string): TimelineGroup => {
  const found = timeline.groups.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no group ${key} in ${timeline.groups.map((candidate) => candidate.key).join(", ")}`);
  return found;
};
const titles = (target: TimelineGroup) => target.rows.map((row) => (row.kind === "step" ? row.last.title : `[${row.event.type}]`));

describe("what a step is about", () => {
  it.each([
    ["director-review", "director"], ["plan-review", "director"], ["final", "director"], ["book-corrections", "director"], ["impact", "director"],
    ["reader", "readers"], ["readers-summary", "readers"], ["plan-reader", "readers"],
    ["specialists", "specialists"],
    ["concept", "writing"], ["plan", "writing"], ["scenes", "writing"], ["write", "writing"], ["repair", "writing"], ["revise", "writing"], ["consolidate", "writing"], ["summarize-imported", "writing"],
  ] as const)("calls %s a step of the %s", (task, category) => {
    expect(categoryOf(task)).toBe(category);
  });

  it("does not guess about a kind of step this version does not know", () => {
    expect(categoryOf("something-new" as never)).toBe("other");
  });
});

describe("the attempts of a step", () => {
  it("makes one step of a failed attempt and of the attempt that repeated it, and says how many failed", () => {
    const failed = stepOf("write", { from: 0, length: 10, chapterNumber: 1, sceneNumber: 1, status: "failed", error: "429", cost: 0.01 });
    const worked = stepOf("write", { from: 40, length: 50, chapterNumber: 1, sceneNumber: 1, cost: 0.03, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 } });
    const [step, ...others] = stepsOf(buildTimeline({ activities: [failed, worked], events: [] }));
    expect(others).toEqual([]);
    expect(step.attempts.map((attempt) => attempt.activity.id)).toEqual([failed.id, worked.id]);
    expect(step.last).toBe(worked);
    expect(step.status).toBe("succeeded");
    expect(step.failedAttempts).toBe(1);
    expect(step.durationMs).toBe(60_000);
    expect(step.cost).toBeCloseTo(0.04, 5);
    expect(step.tokens).toEqual({ input: 100, output: 50, cached: 10 });
    expect(step.problem, "a step that needed a retry is worth a look").toBe(true);
    expect(step.key).toBe(failed.id);
  });

  it("keeps the step failed when every attempt failed and the run ended", () => {
    const attempts = [0, 40, 100].map((from) => stepOf("write", { from, length: 10, chapterNumber: 5, sceneNumber: 2, status: "failed", error: "429" }));
    const [step] = stepsOf(buildTimeline({ activities: attempts, events: [] }));
    expect(step.attempts).toHaveLength(3);
    expect(step.status).toBe("failed");
    expect(step.failedAttempts).toBe(2);
    expect(step.problem).toBe(true);
  });

  it("counts a cancelled attempt that was repeated as an attempt, too", () => {
    const cancelled = stepOf("reader", { from: 0, length: 5, chapterNumber: 2, reader: "ada", status: "cancelled" });
    const worked = stepOf("reader", { from: 20, chapterNumber: 2, reader: "ada" });
    const [step] = stepsOf(buildTimeline({ activities: [cancelled, worked], events: [] }));
    expect(step.attempts).toHaveLength(2);
    expect(step.status).toBe("succeeded");
  });

  it("does not take the same step done again after it worked for a retry: it is a new step", () => {
    const first = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1 });
    const again = stepOf("write", { from: 500, chapterNumber: 1, sceneNumber: 1 });
    expect(stepsOf(buildTimeline({ activities: [first, again], events: [] }))).toHaveLength(2);
  });

  it("tells steps of the same kind apart by the scene and by the reader", () => {
    const list = [
      stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1, status: "failed" }),
      stepOf("write", { from: 40, chapterNumber: 1, sceneNumber: 2 }),
      stepOf("reader", { from: 80, chapterNumber: 1, reader: "ada", status: "failed" }),
      stepOf("reader", { from: 120, chapterNumber: 1, reader: "bruno" }),
    ];
    expect(stepsOf(buildTimeline({ activities: list, events: [] }))).toHaveLength(4);
  });

  it("shows no cost or tokens for a step that spent none", () => {
    const [step] = stepsOf(buildTimeline({ activities: [stepOf("consolidate", { from: 0, chapterNumber: 1 })], events: [] }));
    expect(step.cost).toBe(0);
    expect(step.tokens).toBeNull();
    expect(step.problem).toBe(false);
  });
});

describe("the groups: a chapter, and in it a round of the review", () => {
  const flow = (chapter: number, options: Parameters<typeof chapterFlow>[1] = {}) => chapterFlow(chapter, options);

  it("derives the round by counting the reviews of the director in the order they came", () => {
    const { activities } = flow(4);
    const timeline = buildTimeline({ activities, events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1"]);
    expect(group(timeline, "chapter:4:1").steps).toBe(10);
    expect(titles(group(timeline, "chapter:4:1")).slice(0, 2)).toEqual(["The director judges chapter 4 (round 1)", "Specialists review chapter 4 (round 1)"]);
    // The fixes, the second review and the closing are the second round; the closing stays with the review that approved.
    expect(titles(group(timeline, "chapter:4:2"))).toEqual(["Closing chapter 4", "The director judges chapter 4 (round 2)", "Specialists review chapter 4 (round 2)", "Applying the director's fixes to scene 2 of chapter 4"]);
  });

  it("keeps a chapter that the director approved at the first review in one round, closing included", () => {
    const timeline = buildTimeline({ activities: flow(3, { rounds: 1 }).activities, events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:3:1"]);
    expect(group(timeline, "chapter:3:1").rows[0]).toMatchObject({ kind: "step", last: { task: "consolidate" } });
  });

  it("counts a review of the director that was retried once, and one that never worked not at all", () => {
    const { activities } = flow(4, { rounds: 1, closed: false });
    const review = activities.find((activity) => activity.task === "director-review") as AutopilotActivity;
    const failed = stepOf("director-review", { from: (Date.parse(review.startedAt) - START) / 1000 - 30, length: 10, chapterNumber: 4, status: "failed", error: "429" });
    const timeline = buildTimeline({ activities: [...activities.filter((activity) => activity !== review), failed, review].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:1"]);

    // A review that only ever failed does not begin a new round.
    const never = buildTimeline({ activities: [...activities.filter((activity) => activity.task !== "director-review"), failed].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), events: [] });
    expect(never.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:1"]);
  });

  it("puts the newest chapter first, and the groups of a chapter from the last round to the first", () => {
    const first = flow(3);
    const second = flow(4, { from: first.end + 10 });
    const timeline = buildTimeline({ activities: [...first.activities, ...second.activities], events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1", "chapter:3:2", "chapter:3:1"]);
    expect(timeline.steps).toBe(28);
  });

  it("puts the steps of a group from the newest to the oldest", () => {
    const timeline = buildTimeline({ activities: flow(3, { rounds: 1 }).activities, events: [] });
    const times = group(timeline, "chapter:3:1").rows.map((row) => (row.kind === "step" ? Date.parse(row.last.startedAt) : 0));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("groups what is not about a chapter by what it is: the concept and the plan, the final review, and the rest", () => {
    const list = [
      stepOf("concept", { from: 0 }),
      stepOf("plan", { from: 40 }),
      stepOf("plan-reader", { from: 80, reader: "ada" }),
      stepOf("plan-review", { from: 120 }),
      ...flow(1, { from: 200, rounds: 1 }).activities,
      stepOf("impact", { from: 900 }),
      stepOf("final", { from: 1000, summary: "approve 8/10 — The arc holds." }),
    ];
    const timeline = buildTimeline({ activities: list, events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["final", "other", "chapter:1:1", "plan"]);
    expect(group(timeline, "plan").steps).toBe(4);
    expect(group(timeline, "other").kind).toBe("other");
    expect(group(timeline, "final").kind).toBe("final");
  });

  it("puts the director's corrections of the whole book in the group of the review of the book, whose verdict they do not change", () => {
    const timeline = buildTimeline({ activities: [stepOf("final", { from: 0, summary: "revise 7/10 — The ending is not earned." }), stepOf("book-corrections", { from: 100, summary: "2 corrections — The ending is not earned." })], events: [] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["final"]);
    expect(group(timeline, "final").steps).toBe(2);
    expect(group(timeline, "final").result).toEqual({ verdict: "revise", score: 7 });
  });

  it("reads the verdict and the score of a round from what the director wrote, and says nothing when it cannot", () => {
    const timeline = buildTimeline({ activities: flow(4).activities, events: [] });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6 });
    expect(group(timeline, "chapter:4:2").result).toEqual({ verdict: "approve", score: 8 });
    const odd = buildTimeline({ activities: [stepOf("director-review", { from: 0, chapterNumber: 2, summary: "The chapter is fine." })], events: [] });
    expect(group(odd, "chapter:2:1").result).toBeNull();
    expect(group(buildTimeline({ activities: [stepOf("write", { from: 0, chapterNumber: 2, sceneNumber: 1 })], events: [] }), "chapter:2:1").result).toBeNull();
  });

  it("reads the same from a step on its own, so that a better source can replace the reading in one place", () => {
    const [step] = stepsOf(buildTimeline({ activities: [stepOf("director-review", { from: 0, chapterNumber: 2, summary: "revise 7,5/10 — 1 accepted, 1 rejected." })], events: [] }));
    expect(roundResultOf(step)).toEqual({ verdict: "revise", score: 7.5 });
    expect(roundResultOf({ ...step, last: { ...step.last, task: "write" } })).toBeNull();
  });

  it("adds up what a group holds: its steps, the ones that failed, the ones to look at", () => {
    const list = [
      ...flow(4, { rounds: 1, closed: false }).activities,
      stepOf("write", { from: 5000, chapterNumber: 4, sceneNumber: 9, status: "failed", error: "x" }),
    ];
    const timeline = buildTimeline({ activities: list, events: [] });
    // The failed scene came after the review: it is a step of the next round.
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1"]);
    expect(group(timeline, "chapter:4:1")).toMatchObject({ steps: 10, failed: 0, problems: 0 });
    expect(group(timeline, "chapter:4:2")).toMatchObject({ steps: 1, failed: 1, problems: 1 });
  });
});

describe("the step that runs now and the group that is open", () => {
  it("opens the newest group when nothing runs", () => {
    const first = chapterFlow(3);
    const second = chapterFlow(4, { from: first.end + 10 });
    const timeline = buildTimeline({ activities: [...first.activities, ...second.activities], events: [] });
    expect(timeline.open).toBe("chapter:4:2");
    expect(timeline.groups.filter((candidate) => candidate.running)).toEqual([]);
  });

  it("opens the group of the step that runs, and makes one for it when its chapter has no finished step yet", () => {
    const done = chapterFlow(4, { rounds: 1 });
    const running = stepOf("write", { from: done.end + 5, chapterNumber: 5, sceneNumber: 1, status: "running" });
    const timeline = buildTimeline({ activities: done.activities, events: [], running });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:5:1", "chapter:4:1"]);
    expect(timeline.groups[0]).toMatchObject({ running: true, steps: 0, rows: [] });
    expect(timeline.open).toBe("chapter:5:1");
    expect(timeline.steps, "the running step is not a row: the band says what it is").toBe(done.activities.length);
  });

  it("puts the step that runs in the round it belongs to: a fix after a review that asked for fixes is in the next round", () => {
    const done = chapterFlow(4, { rounds: 2, closed: false });
    const finished = done.activities.slice(0, done.activities.findIndex((activity) => activity.task === "repair") + 1);
    const running = stepOf("specialists", { from: done.end, chapterNumber: 4, status: "running" });
    const timeline = buildTimeline({ activities: finished, events: [], running });
    expect(timeline.open).toBe("chapter:4:2");
    expect(group(timeline, "chapter:4:2").running).toBe(true);
    expect(timeline.groups[0].key).toBe("chapter:4:2");
  });

  it("puts a step that is not about a chapter where its kind goes", () => {
    const timeline = buildTimeline({ activities: [stepOf("concept", { from: 0 })], events: [], running: stepOf("plan", { from: 50, status: "running" }) });
    expect(timeline.open).toBe("plan");
    expect(timeline.groups).toHaveLength(1);
    expect(timeline.groups[0].running).toBe(true);
  });
});

describe("the events of the feed", () => {
  it("adds the steps that the feed finished and the log does not have yet, and counts none twice", () => {
    const logged = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1 });
    const fresh = stepOf("write", { from: 60, chapterNumber: 1, sceneNumber: 2 });
    const timeline = buildTimeline({ activities: [logged], events: [finishedEvent(logged), finishedEvent(fresh), finishedEvent(fresh)] });
    expect(stepsOf(timeline).map((step) => step.key)).toEqual([fresh.id, logged.id]);
  });

  it("shows the insights and the sync notices of a step inline, under it, in the order they came", () => {
    const write = stepOf("write", { from: 0, length: 60, chapterNumber: 1, sceneNumber: 1 });
    const events = [
      insightFor(write, "warning", "second", "later", 50),
      insightFor(write, "ok", "first", undefined, 20),
      eventAt(70, { type: "sync", activityId: write.id, tone: "warning", code: "publishFailed", title: "Publishing the chapter failed.", detail: "502" }),
    ];
    const [step] = stepsOf(buildTimeline({ activities: [write], events }));
    expect(step.notes.map((note) => (note.event.type === "insight" || note.event.type === "sync" ? note.event.title : ""))).toEqual(["first", "second", "Publishing the chapter failed."]);
    expect(step.notes.map((note) => note.tone)).toEqual(["ok", "warning", "warning"]);
    expect(step.problem).toBe(true);
  });

  it("does not call a step a problem for the insights that are good news", () => {
    const write = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1 });
    const [step] = stepsOf(buildTimeline({ activities: [write], events: [insightFor(write, "ok", "Scene written"), insightFor(write, "info", "Fix")] }));
    expect(step.problem).toBe(false);
  });

  it("puts the retry notice on the attempt that failed, and not in a row of its own", () => {
    const failed = stepOf("write", { from: 0, length: 10, chapterNumber: 1, sceneNumber: 1, status: "failed", error: "429" });
    const worked = stepOf("write", { from: 40, length: 20, chapterNumber: 1, sceneNumber: 1 });
    const timeline = buildTimeline({ activities: [failed, worked], events: [finishedEvent(failed), retryNotice(11, 1), finishedEvent(worked)] });
    const [step] = stepsOf(timeline);
    expect(step.attempts[0].retry).toMatchObject({ attempt: 1, retries: 3, waitMs: 20_000 });
    expect(step.attempts[1].retry).toBeNull();
    expect(timeline.groups.flatMap((candidate) => candidate.rows).filter((row) => row.kind === "marker")).toEqual([]);
  });

  it("puts a retry notice on the step that is still waiting to be repeated, the attempt that failed last", () => {
    const failed = stepOf("write", { from: 0, length: 10, chapterNumber: 1, sceneNumber: 1, status: "failed", error: "429" });
    const [step] = stepsOf(buildTimeline({ activities: [failed], events: [retryNotice(11, 2)] }));
    expect(step.attempts).toHaveLength(1);
    expect(step.attempts[0].retry).toMatchObject({ attempt: 2 });
  });

  it("keeps a retry notice that belongs to no step of the log as a note of the run", () => {
    const worked = stepOf("write", { from: 0, length: 10, chapterNumber: 1, sceneNumber: 1 });
    const timeline = buildTimeline({ activities: [worked], events: [retryNotice(11, 1)] });
    expect(group(timeline, "chapter:1:1").rows.filter((row) => row.kind === "marker")).toHaveLength(1);
  });

  it("marks where a run started and how it ended, in the group of the step it came after, and tells what is a problem", () => {
    const flow = chapterFlow(1, { from: 10, rounds: 1 });
    const second = chapterFlow(2, { from: flow.end + 100, rounds: 1 });
    const events = [runStarted(5), runEnded(flow.end + 20, "paused"), runStarted(flow.end + 60), runEnded(second.end + 10, "error", "429")];
    const timeline = buildTimeline({ activities: [...flow.activities, ...second.activities], events });
    const markers = (key: string) => group(timeline, key).rows.filter((row) => row.kind === "marker");
    expect(markers("chapter:2:1")).toHaveLength(2);
    expect(markers("chapter:1:1")).toHaveLength(2);
    // The newest of a group is first: the error that ended the second run is the top row of the newest group.
    expect(timeline.groups[0].rows[0]).toMatchObject({ kind: "marker", problem: true });
    expect(markers("chapter:1:1").every((row) => row.kind === "marker" && !row.problem)).toBe(true);
    // A run that started before the first step is the oldest row of the oldest group.
    const oldest = group(timeline, "chapter:1:1").rows;
    expect(oldest[oldest.length - 1]).toMatchObject({ kind: "marker", event: { type: "run-started" } });
  });

  it("does not show the insights of the step that runs now: they come under it when it is over", () => {
    const done = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1 });
    const running = stepOf("write", { from: 60, chapterNumber: 1, sceneNumber: 2, status: "running" });
    const timeline = buildTimeline({ activities: [done], events: [insightFor(running, "ok", "Scene 1.2 written", undefined, 100)], running });
    expect(group(timeline, "chapter:1:1").rows.filter((row) => row.kind === "marker")).toEqual([]);
  });

  it("leaves out what happened long before the first step of the log: the log forgot it", () => {
    const worked = stepOf("write", { from: 100_000, chapterNumber: 1, sceneNumber: 1 });
    const timeline = buildTimeline({ activities: [worked], events: [runStarted(10), runStarted(99_800)] });
    expect(group(timeline, "chapter:1:1").rows.filter((row) => row.kind === "marker")).toHaveLength(1);
  });

  it("shows the notes of a book that has no step yet in one group of its own", () => {
    const timeline = buildTimeline({ activities: [], events: [runStarted(0), eventAt(5, { type: "insight", tone: "warning", code: "profileProblems", title: "Problems", detail: "x" })] });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["other"]);
    expect(timeline.groups[0].rows).toHaveLength(2);
    expect(timeline.steps).toBe(0);
  });

  it("keeps the newest notes of the run when there are too many", () => {
    const worked = stepOf("write", { from: 0, length: 1000, chapterNumber: 1, sceneNumber: 1 });
    const events = Array.from({ length: MAX_MARKERS + 40 }, (_, index) => runStarted(index + 1));
    const markers = buildTimeline({ activities: [worked], events }).groups[0].rows.filter((row) => row.kind === "marker");
    expect(markers).toHaveLength(MAX_MARKERS);
    expect(markers[0].at).toBe(sec(MAX_MARKERS + 40));
  });
});

describe("hiding what happened until now", () => {
  it("hides the steps and the notes that were over before the moment, and keeps the rounds as they were", () => {
    const flow = chapterFlow(4, { rounds: 2 });
    const cut = flow.activities.find((activity) => activity.task === "director-review")!.endedAt!;
    const timeline = buildTimeline({ activities: flow.activities, events: [runStarted(1), runEnded(flow.end + 5)], since: cut });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2"]);
    expect(timeline.hidden).toBeGreaterThan(8);
    expect(timeline.groups[0].rows.some((row) => row.kind === "marker" && row.event.type === "run-started")).toBe(false);
    expect(timeline.groups[0].rows.some((row) => row.kind === "marker" && row.event.type === "run-ended")).toBe(true);
  });

  it("hides nothing without a moment", () => {
    expect(buildTimeline({ activities: chapterFlow(1).activities, events: [] }).hidden).toBe(0);
  });
});

describe("the filters", () => {
  const list = () => {
    const flow = chapterFlow(4, { rounds: 2 });
    const failed = stepOf("write", { from: flow.end + 10, length: 5, chapterNumber: 5, sceneNumber: 1, status: "failed", error: "x" });
    const specialists = flow.activities.find((activity) => activity.task === "specialists")!;
    return { activities: [...flow.activities, failed], events: [insightFor(specialists, "critical", "continuity: the lamp is lit twice"), runStarted(0), runEnded(flow.end + 30, "error", "x")] };
  };

  it("offers all, the problems, the director, the readers and the writing, in that order", () => {
    expect([...TIMELINE_FILTERS]).toEqual(["all", "problems", "director", "readers", "writing"]);
  });

  it("counts what each filter would show", () => {
    const counts = filterCounts(buildTimeline(list()));
    // 15 steps (14 of the chapter and the scene that failed) and 2 notes of the run; the scenes plan, 3 scenes, the fixes, the closing and the failed scene are writing.
    expect(counts).toEqual({ all: 15 + 2, problems: 3, director: 2, readers: 4, writing: 1 + 3 + 1 + 1 + 1 });
  });

  it("keeps the problems: a step that failed, a step with a warning, a note of the run that is one", () => {
    const shown = filterTimeline(buildTimeline(list()), "problems");
    const rows = shown.groups.flatMap((candidate) => candidate.rows);
    expect(rows.map((row) => (row.kind === "step" ? row.last.task : row.event.type))).toEqual(expect.arrayContaining(["write", "specialists", "run-ended"]));
    expect(rows).toHaveLength(3);
  });

  it("keeps the steps of one kind of work, drops the notes of the run, and leaves no group empty", () => {
    const readers = filterTimeline(buildTimeline(list()), "readers");
    expect(readers.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:1"]);
    expect(readers.groups[0].rows.every((row) => row.kind === "step" && categoryOf(row.last.task) === "readers")).toBe(true);
    expect(readers.groups[0].steps).toBe(4);
    const director = filterTimeline(buildTimeline(list()), "director");
    expect(director.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1"]);
  });

  it("keeps the verdict of a round while only some of its steps are shown", () => {
    const writing = filterTimeline(buildTimeline(list()), "writing");
    expect(writing.groups.find((candidate) => candidate.key === "chapter:4:1")?.result).toEqual({ verdict: "revise", score: 6 });
  });

  it("shows everything under 'all', and the same timeline", () => {
    const timeline = buildTimeline(list());
    expect(filterTimeline(timeline, "all")).toBe(timeline);
  });

  it("keeps the group that runs open even when no step of it is shown", () => {
    const flow = chapterFlow(4, { rounds: 1 });
    const timeline = buildTimeline({ activities: flow.activities, events: [], running: stepOf("write", { from: flow.end + 5, chapterNumber: 5, sceneNumber: 1, status: "running" }) });
    expect(filterTimeline(timeline, "readers").groups.map((candidate) => candidate.key)).toEqual(["chapter:5:1", "chapter:4:1"]);
    expect(filterTimeline(timeline, "readers").open).toBe("chapter:5:1");
  });
});

describe("how many rows are drawn", () => {
  it("starts with a window of rows and gives more of them a step at a time, up to a limit", () => {
    expect(GROUP_ROWS).toBe(40);
    expect(ROW_STEP).toBe(40);
    expect(MAX_ROWS).toBe(200);
    expect(nextLimit(GROUP_ROWS, 150)).toBe(80);
    expect(nextLimit(80, 90)).toBe(90);
    expect(nextLimit(180, 500)).toBe(MAX_ROWS);
    expect(nextLimit(MAX_ROWS, 500)).toBe(MAX_ROWS);
  });
});

describe("a row that shows the same as before", () => {
  it("has the same version when nothing it shows has changed, and another when something has", () => {
    const write = stepOf("write", { from: 0, chapterNumber: 1, sceneNumber: 1 });
    const version = (events: Parameters<typeof buildTimeline>[0]["events"], activity = write) => stepsOf(buildTimeline({ activities: [activity], events }))[0].version;
    const note = insightFor(write, "ok", "Scene written");
    const plain = version([]);
    expect(version([])).toBe(plain);
    expect(version([note])).not.toBe(plain);
    expect(version([], { ...write, status: "failed", error: "x" })).not.toBe(plain);
    // The same event, the next time the feed is read, is the same row.
    expect(version([note])).toBe(version([{ ...note }]));
  });
});

describe("a log written by another version of the engine", () => {
  it("keeps a step of a kind it does not know, with a date it cannot read, in a group of its own and out of every filter but all", () => {
    const odd = { ...stepOf("write", { from: 0 }), task: "something-new" as never, startedAt: "not a date", endedAt: undefined, title: "" };
    const timeline = buildTimeline({ activities: [odd, stepOf("write", { from: 100, chapterNumber: 1, sceneNumber: 1 })], events: [{ ...runStarted(5), at: "also not a date" }] });
    expect(timeline.groups.map((candidate) => candidate.key).sort()).toEqual(["chapter:1:1", "other"]);
    expect(filterCounts(timeline)).toMatchObject({ director: 0, readers: 0 });
    expect(filterTimeline(timeline, "writing").groups.map((candidate) => candidate.key)).toEqual(["chapter:1:1"]);
  });

  it("builds nothing from nothing", () => {
    const timeline = buildTimeline({ activities: [], events: [] });
    expect(timeline).toEqual({ groups: [], steps: 0, hidden: 0, open: null });
    expect(filterCounts(timeline)).toEqual({ all: 0, problems: 0, director: 0, readers: 0, writing: 0 });
  });
});

describe("a long log", () => {
  it("builds a timeline of 200 steps and a few hundred events, and every step has a place", () => {
    const activities: AutopilotActivity[] = [];
    let from = 0;
    for (let chapter = 1; activities.length < 200; chapter += 1) {
      const flow = chapterFlow(chapter, { from, rounds: 2 });
      activities.push(...flow.activities);
      from = flow.end + 5;
    }
    const kept = activities.slice(0, 200);
    const events = kept.flatMap((activity) => [finishedEvent(activity), insightFor(activity, "ok", `Done ${activity.id}`)]);
    const timeline = buildTimeline({ activities: kept, events });
    expect(timeline.steps).toBe(200);
    expect(timeline.groups.reduce((sum, candidate) => sum + candidate.steps, 0)).toBe(200);
    expect(stepsOf(timeline).every((step) => step.notes.length === 1)).toBe(true);
  });
});

describe("the rounds, when the plan records them", () => {
  const record = (...votes: number[]): ChapterRound[] => votes.map((director) => ({ director, accepted: 1, rejected: 0 }));
  const lookup = (rounds: Record<number, ChapterRound[]>) => (chapter: number) => rounds[chapter];
  /** What the log still holds of a chapter of two rounds once its first review has left it (the log keeps the last 200 steps): the fix, the second round, the closing. */
  const withoutFirstReview = (chapter: number) => {
    const { activities } = chapterFlow(chapter, { rounds: 2 });
    return activities.slice(activities.findIndex((activity) => activity.task === "director-review") + 1);
  };

  it("counts the rounds that came before the log: a chapter that the plan says had two rounds is in its second, though the log shows one review", () => {
    const timeline = buildTimeline({ activities: withoutFirstReview(4), events: [], rounds: lookup({ 4: record(6, 8) }) });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2"]);
    expect(group(timeline, "chapter:4:2").steps).toBe(4);
  });

  it("counts by the log when the plan has no record of the chapter (an older state), as it always did", () => {
    const timeline = buildTimeline({ activities: withoutFirstReview(4), events: [], rounds: lookup({}) });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:1"]);
    expect(buildTimeline({ activities: withoutFirstReview(4), events: [] }).groups.map((candidate) => candidate.key)).toEqual(["chapter:4:1"]);
  });

  it("has the same rounds as the log says when the log holds every review of the chapter", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const timeline = buildTimeline({ activities, events: [], rounds: lookup({ 4: record(6, 8) }) });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1"]);
  });

  it("does not use a record that is shorter than the log: the page has a step of the log a moment before it has the plan that records it, and a record may have begun in the middle of the chapter", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    // The second review has just finished, and the plan the page holds knows only the first round.
    const timeline = buildTimeline({ activities, events: [], rounds: lookup({ 4: [{ director: 6.5, readers: 7.2, accepted: 2, rejected: 1 }] }) });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:4:2", "chapter:4:1"]);
    // Each round keeps what its own review wrote: the vote of the first round is not put on the second, and nothing of the record is given to a round it may not belong to.
    expect(group(timeline, "chapter:4:2").result).toEqual({ verdict: "approve", score: 8 });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6 });
  });

  it("uses the record again as soon as the plan has caught up with the log", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const caughtUp = buildTimeline({ activities, events: [], rounds: lookup({ 4: [{ director: 6.5, readers: 7.2, accepted: 2, rejected: 1 }, { director: 8.5, accepted: 0, rejected: 0 }] }) });
    expect(group(caughtUp, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6.5, readers: 7.2, accepted: 2, rejected: 1 });
    expect(group(caughtUp, "chapter:4:2").result).toEqual({ verdict: "approve", score: 8.5, accepted: 0, rejected: 0 });
  });

  it("puts the step that runs in the round after the last one that was recorded, though the log shows no review of the chapter", () => {
    const repair = stepOf("repair", { from: 0, chapterNumber: 4, sceneNumber: 2 });
    const running = stepOf("specialists", { from: 60, chapterNumber: 4, status: "running" });
    const timeline = buildTimeline({ activities: [repair], events: [], running, rounds: lookup({ 4: record(6) }) });
    expect(timeline.open).toBe("chapter:4:2");
    expect(group(timeline, "chapter:4:2")).toMatchObject({ running: true, steps: 1 });
    expect(buildTimeline({ activities: [repair], events: [], running }).open, "by the log alone it would be the first round").toBe("chapter:4:1");
  });

  it("gives a round the vote the plan recorded, and the readers and what the director decided, and keeps the verdict the review wrote", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const rounds = { 4: [{ director: 6.5, readers: 7.2, accepted: 2, rejected: 1 }, { director: 8.5, accepted: 0, rejected: 0 }] };
    const timeline = buildTimeline({ activities, events: [], rounds: lookup(rounds) });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6.5, readers: 7.2, accepted: 2, rejected: 1 });
    expect(group(timeline, "chapter:4:2").result).toEqual({ verdict: "approve", score: 8.5, accepted: 0, rejected: 0 });
  });

  it("gives a round the verdict the plan recorded, before the words of the review: the plan says what it did, and that is not always what the model said", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    // The review of the second round says «approve 8/10»; the plan withheld that approval, because it is under the approval score of the director, and sent the chapter back.
    const rounds = { 4: [{ director: 6.5, verdict: "revise" as const }, { director: 7.1, verdict: "revise" as const }] };
    const timeline = buildTimeline({ activities, events: [], rounds: lookup(rounds) });
    expect(group(timeline, "chapter:4:2").result).toEqual({ verdict: "revise", score: 7.1 });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6.5 });
  });

  it("gives an approval of the plan to a round that the words of the log called a revision: the plan closed the chapter", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const timeline = buildTimeline({ activities, events: [], rounds: lookup({ 4: [{ director: 6.5, verdict: "approve" as const }, { director: 8.5, verdict: "approve" as const }] }) });
    expect(group(timeline, "chapter:4:1").result).toMatchObject({ verdict: "approve", score: 6.5 });
  });

  it("gives the verdict of the plan to a round whose review the log cannot read: it is data, and nothing is guessed", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    const unreadable = activities.map((activity) => (activity.task === "director-review" ? { ...activity, summary: "The chapter is fine." } : activity));
    const timeline = buildTimeline({ activities: unreadable, events: [], rounds: lookup({ 4: [{ director: 7, verdict: "approve" as const, accepted: 1, rejected: 0 }] }) });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "approve", score: 7, accepted: 1, rejected: 0 });
  });

  it("falls back to the words of the log when the plan records no verdict for the round: a state written before the verdict was", () => {
    const { activities } = chapterFlow(4, { rounds: 2 });
    const timeline = buildTimeline({ activities, events: [], rounds: lookup({ 4: [{ director: 6.5 }, { director: 8.5, verdict: "approve" as const }] }) });
    expect(group(timeline, "chapter:4:1").result).toEqual({ verdict: "revise", score: 6.5 });
    expect(group(timeline, "chapter:4:2").result).toEqual({ verdict: "approve", score: 8.5 });
  });

  it("does not take a verdict that is not one of the two for the plan's: it falls back to the log", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    const odd = { director: 8, verdict: "rewrite" } as unknown as ChapterRound;
    expect(group(buildTimeline({ activities, events: [], rounds: lookup({ 4: [odd] }) }), "chapter:4:1").result).toMatchObject({ verdict: "approve", score: 8 });
  });

  it("gives the vote of a round whose review the log cannot read, with no verdict: it is not guessed", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    const unreadable = activities.map((activity) => (activity.task === "director-review" ? { ...activity, summary: "The chapter is fine." } : activity));
    const timeline = buildTimeline({ activities: unreadable, events: [], rounds: lookup({ 4: record(7) }) });
    const result = group(timeline, "chapter:4:1").result;
    expect(result).toEqual({ score: 7, accepted: 1, rejected: 0 });
    expect(result).not.toHaveProperty("verdict");
    expect(group(buildTimeline({ activities: unreadable, events: [] }), "chapter:4:1").result, "without the record there is nothing to say").toBeNull();
  });

  it("gives a round that has no vote of its own what the review wrote", () => {
    const { activities } = chapterFlow(4, { rounds: 1 });
    const timeline = buildTimeline({ activities, events: [], rounds: lookup({ 4: [{ readers: 6, accepted: 1 }] }) });
    expect(group(timeline, "chapter:4:1").result).toMatchObject({ verdict: "approve", score: 8, readers: 6 });
  });

  it("asks the plan only about the chapters the log has, and once for each: a plan has no maximum number of chapters", () => {
    const asked: number[] = [];
    const first = chapterFlow(3, { rounds: 1 });
    const second = chapterFlow(4, { from: first.end + 10, rounds: 1 });
    buildTimeline({ activities: [...first.activities, ...second.activities], events: [], rounds: (chapter) => { asked.push(chapter); return undefined; } });
    expect([...new Set(asked)].sort()).toEqual([3, 4]);
    expect(asked.length).toBeLessThanOrEqual(8);
  });
});

describe("the verdict on the whole book, when the engine says it as data", () => {
  const finalStep = (summary: string | undefined) => stepOf("final", { from: 0, summary });

  it("is in the group of the review of the book: the verdict and the score the engine saved, before what the log says", () => {
    const timeline = buildTimeline({ activities: [finalStep("approve 9/10 — Fine.")], events: [], finalReview: { verdict: "revise", score: 7 } });
    expect(group(timeline, "final").result).toEqual({ verdict: "revise", score: 7 });
  });

  it("is there when the words of the step cannot be read", () => {
    const timeline = buildTimeline({ activities: [finalStep("The book is good.")], events: [], finalReview: { verdict: "approve", score: 8.5 } });
    expect(group(timeline, "final").result).toEqual({ verdict: "approve", score: 8.5 });
  });

  it("is what the log says when the engine did not say (a state that an older engine wrote), as it always was", () => {
    const timeline = buildTimeline({ activities: [finalStep("approve 8/10 — The arc holds.")], events: [] });
    expect(group(timeline, "final").result).toEqual({ verdict: "approve", score: 8 });
    expect(group(buildTimeline({ activities: [finalStep("approve 8/10 — The arc holds.")], events: [], finalReview: null }), "final").result).toEqual({ verdict: "approve", score: 8 });
  });

  it("does not make a group for a review the log no longer has: it has nothing to show in it", () => {
    const timeline = buildTimeline({ activities: chapterFlow(1, { rounds: 1 }).activities, events: [], finalReview: { verdict: "approve", score: 8 } });
    expect(timeline.groups.map((candidate) => candidate.key)).toEqual(["chapter:1:1"]);
  });

  it("does not put the verdict of the book on the groups of the chapters", () => {
    const flow = chapterFlow(1, { rounds: 1 });
    const timeline = buildTimeline({ activities: [...flow.activities, stepOf("final", { from: flow.end + 10 })], events: [], finalReview: { verdict: "revise", score: 5 } });
    expect(group(timeline, "chapter:1:1").result).toEqual({ verdict: "approve", score: 8 });
    expect(group(timeline, "final").result).toEqual({ verdict: "revise", score: 5 });
  });
});
