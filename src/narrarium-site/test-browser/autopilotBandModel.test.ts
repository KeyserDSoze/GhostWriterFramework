import { describe, expect, it } from "vitest";
import { createAutopilotState, type AutopilotActivity, type AutopilotFinalReview, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { bandPhases, budgetUse, chapterCycle, closedChapterToRead, cycleItems, finalReviewOf, finalVerdict, stageOfTask, stepSpendOf, workedSince, workedTime } from "@/autopilot/bandModel";
import { chapter, planOf } from "./helpers/autopilotFixtures";

const T0 = "2026-11-21T10:00:00.000Z";

function stateOf(chapters: PlannedChapter[], patch: Partial<AutopilotState> = {}): AutopilotState {
  return { ...createAutopilotState(new Date(T0)), status: "running", phase: "write", plan: planOf(chapters), ...patch };
}

const review = (patch: Record<string, unknown> = {}) => ({
  chapterNumber: 2,
  round: 1,
  readersPending: [] as string[],
  readerScores: [] as unknown[],
  readersSummaryDone: false,
  findings: [],
  specialistsDone: false,
  directorDone: false,
  decisions: [],
  repairQueue: [] as number[],
  previousFixes: [],
  history: [],
  ...patch,
}) as unknown as AutopilotState["review"];

function activityOf(task: AutopilotActivity["task"], patch: Partial<AutopilotActivity> = {}): AutopilotActivity {
  return { id: `a-${task}-${Math.random()}`, runId: "run-1", task, phase: "write", title: task, reason: "", next: "", status: "succeeded", startedAt: T0, endedAt: "2026-11-21T10:01:00.000Z", ...patch };
}

describe("which step of the cycle of a chapter a task belongs to", () => {
  it.each([
    ["scenes", "write"],
    ["write", "write"],
    ["revise", "write"],
    ["reader", "readers"],
    ["readers-summary", "readers"],
    ["specialists", "specialists"],
    ["director-review", "director"],
    ["repair", "fix"],
    ["consolidate", "close"],
  ] as const)("%s is %s", (task, stage) => {
    expect(stageOfTask(task)).toBe(stage);
  });

  it.each(["concept", "summarize-imported", "plan", "plan-reader", "plan-review", "impact", "final"] as const)("%s is not part of the cycle of a chapter", (task) => {
    expect(stageOfTask(task)).toBeNull();
  });

  it("does not know a step of a newer engine: it is not part of the cycle either", () => {
    expect(stageOfTask("a-step-from-the-future" as never)).toBeNull();
    expect(stageOfTask(undefined)).toBeNull();
  });
});

describe("the chapter in progress and where it is in its cycle", () => {
  const chapters = [chapter(1, "done"), chapter(2, "writing"), chapter(3, "planned")];

  it("follows the step that runs now: it is more recent than the saved state", () => {
    const state = stateOf(chapters);
    expect(chapterCycle(state, { task: "reader", chapterNumber: 2 })).toEqual({ chapterNumber: 2, stage: "readers", round: null });
    expect(chapterCycle(state, { task: "director-review", chapterNumber: 2 })).toEqual({ chapterNumber: 2, stage: "director", round: null });
    expect(chapterCycle(state, { task: "consolidate", chapterNumber: 2 })).toEqual({ chapterNumber: 2, stage: "close", round: null });
  });

  it("says nothing of a cycle while the run does something else (the concept, the plan, the final review)", () => {
    expect(chapterCycle(stateOf(chapters), { task: "plan", chapterNumber: undefined })).toBeNull();
    expect(chapterCycle(stateOf(chapters), { task: "final", chapterNumber: undefined })).toBeNull();
  });

  it("reads the stage from the saved state when no step runs: still writing while scenes are missing", () => {
    expect(chapterCycle(stateOf(chapters), null)).toEqual({ chapterNumber: 2, stage: "write", round: null });
    expect(chapterCycle(stateOf([chapter(1, "done"), chapter(2, "planned")]), null)).toEqual({ chapterNumber: 2, stage: "write", round: null });
  });

  it("reads the stage of a chapter under review in the order the engine asks for the steps", () => {
    const reviewing = [chapter(1, "done"), chapter(2, "review")];
    const stage = (patch: Record<string, unknown>) => chapterCycle(stateOf(reviewing, { review: review(patch) }), null)?.stage;
    expect(stage({ readersPending: ["ada"] })).toBe("readers");
    expect(stage({ readerScores: [{ slug: "ada" }], readersSummaryDone: false })).toBe("readers");
    expect(stage({ readerScores: [{ slug: "ada" }], readersSummaryDone: true, specialistsDone: false })).toBe("specialists");
    expect(stage({ readersSummaryDone: true, specialistsDone: true, directorDone: false })).toBe("director");
    expect(stage({ readersSummaryDone: true, specialistsDone: true, directorDone: true, repairQueue: [2] })).toBe("fix");
    expect(stage({ readersSummaryDone: true, specialistsDone: true, directorDone: true, repairQueue: [] })).toBe("close");
  });

  it("says which round of the review it is", () => {
    const reviewing = [chapter(1, "done"), chapter(2, "review")];
    expect(chapterCycle(stateOf(reviewing, { review: review({ round: 2, specialistsDone: false }) }), null)).toEqual({ chapterNumber: 2, stage: "specialists", round: 2 });
    expect(chapterCycle(stateOf(reviewing, { review: review({ round: 2 }) }), { task: "director-review", chapterNumber: 2 })).toEqual({ chapterNumber: 2, stage: "director", round: 2 });
  });

  it("starts a review at the readers when they are on, and at the specialists when they are not", () => {
    const reviewing = [chapter(1, "done"), chapter(2, "review")];
    const withReaders = stateOf(reviewing);
    expect(chapterCycle({ ...withReaders, options: { ...withReaders.options, readers: true }, review: null }, null)?.stage).toBe("readers");
    expect(chapterCycle({ ...withReaders, options: { ...withReaders.options, readers: false }, review: null }, null)?.stage).toBe("specialists");
  });

  it("has no chapter in progress before the plan is approved, while it waits for the author, when every chapter is done, or without a state", () => {
    expect(chapterCycle(null, null)).toBeNull();
    expect(chapterCycle(stateOf([chapter(1, "done")]), null)).toBeNull();
    expect(chapterCycle(stateOf(chapters, { plan: { ...planOf(chapters), approved: false } }), null)).toBeNull();
    expect(chapterCycle(stateOf(chapters, { plan: { ...planOf(chapters), awaitingAuthor: true } }), null)).toBeNull();
    expect(chapterCycle(stateOf(chapters, { plan: null }), null)).toBeNull();
  });

  it("marks what is behind the current step as done and what is ahead as still to do", () => {
    const states = (current: Parameters<typeof cycleItems>[0]["stage"]) => cycleItems({ chapterNumber: 2, stage: current, round: null }).map((item) => `${item.stage}:${item.state}`);
    expect(states("readers")).toEqual(["write:done", "readers:current", "specialists:todo", "director:todo", "fix:todo"]);
    expect(states("fix")).toEqual(["write:done", "readers:done", "specialists:done", "director:done", "fix:current"]);
    expect(states("close")).toEqual(["write:done", "readers:done", "specialists:done", "director:done", "fix:done"]);
  });
});

describe("the phases of the book, as the compact indicator shows them", () => {
  const states = (phase: Parameters<typeof bandPhases>[0]) => bandPhases(phase).map((step) => `${step.key}:${step.state}`);

  it("shows the concept, the plan, the chapters and the final review, with the current one marked", () => {
    expect(states("concept")).toEqual(["concept:current", "plan:todo", "chapters:todo", "final:todo"]);
    expect(states("plan")).toEqual(["concept:done", "plan:current", "chapters:todo", "final:todo"]);
    expect(states("final")).toEqual(["concept:done", "plan:done", "chapters:done", "final:current"]);
  });

  it("puts writing and reviewing a chapter under the same step: the chapters", () => {
    expect(states("write")).toEqual(["concept:done", "plan:done", "chapters:current", "final:todo"]);
    expect(states("review")).toEqual(states("write"));
  });

  it("has everything done once the book is complete", () => {
    expect(states("completed")).toEqual(["concept:done", "plan:done", "chapters:done", "final:done"]);
  });
});

describe("the chapter that was just closed and can be read now", () => {
  const chapters = [chapter(1, "done"), chapter(2, "done"), chapter(3, "planned")];
  const state = stateOf(chapters, { status: "paused" });

  it("is the one the last step closed, for a run that paused at the end of the chapter", () => {
    const log = [activityOf("director-review", { chapterNumber: 2 }), activityOf("consolidate", { chapterNumber: 2 })];
    expect(closedChapterToRead(state, log, "paused")).toEqual({ number: 2, slug: "002-chapter-2" });
  });

  it("is none when the last step is something else, when the run goes on, or when it failed", () => {
    expect(closedChapterToRead(state, [activityOf("consolidate", { chapterNumber: 2 }), activityOf("write", { chapterNumber: 3 })], "paused")).toBeNull();
    expect(closedChapterToRead(state, [activityOf("consolidate", { chapterNumber: 2 })], "running")).toBeNull();
    expect(closedChapterToRead(state, [activityOf("consolidate", { chapterNumber: 2, status: "failed" })], "paused")).toBeNull();
    expect(closedChapterToRead(state, [], "paused")).toBeNull();
    expect(closedChapterToRead(null, [activityOf("consolidate", { chapterNumber: 2 })], "paused")).toBeNull();
  });

  it("is none while the plan waits for the author: there is nothing to read yet", () => {
    const waiting = stateOf(chapters, { status: "paused", plan: { ...planOf(chapters), awaitingAuthor: true } });
    expect(closedChapterToRead(waiting, [activityOf("consolidate", { chapterNumber: 2 })], "paused")).toBeNull();
  });

  it("has no link when the chapter is not in the plan any more", () => {
    expect(closedChapterToRead(state, [activityOf("consolidate", { chapterNumber: 9 })], "paused")).toEqual({ number: 9, slug: undefined });
  });
});

describe("the verdict of the director on the whole book", () => {
  it("reads the verdict, the score and the words of the last final review", () => {
    const log = [activityOf("final", { summary: "revise 6/10 — Too long." }), activityOf("final", { summary: "approve 8/10 — The arc holds.\nSecond line." })];
    expect(finalVerdict(log)).toEqual({ verdict: "approve", score: 8, text: "The arc holds.\nSecond line." });
  });

  it("reads a score with a decimal part, with a point or a comma", () => {
    expect(finalVerdict([activityOf("final", { summary: "rewrite 4.5/10 — Start again." })])).toEqual({ verdict: "rewrite", score: 4.5, text: "Start again." });
    expect(finalVerdict([activityOf("final", { summary: "revise 7,5/10 — Almost." })])).toEqual({ verdict: "revise", score: 7.5, text: "Almost." });
  });

  it("keeps the whole text when it is not written the way the engine writes it", () => {
    expect(finalVerdict([activityOf("final", { summary: "The book is good." })])).toEqual({ text: "The book is good." });
  });

  it("is none without a final review that worked, or without words", () => {
    expect(finalVerdict([])).toBeNull();
    expect(finalVerdict([activityOf("write")])).toBeNull();
    expect(finalVerdict([activityOf("final", { status: "failed", summary: "approve 8/10 — No." })])).toBeNull();
    expect(finalVerdict([activityOf("final", { summary: undefined })])).toBeNull();
  });
});

describe("the verdict of the director on the whole book, when the engine says it as data", () => {
  const given = (patch: Partial<AutopilotFinalReview> = {}): AutopilotFinalReview => ({ verdict: "approve", score: 8.5, text: "The arc holds: the ledger pays off.", at: "2026-11-21T10:30:00.000Z", ...patch });

  it("is the verdict, the score and the words of the review the engine saved, before anything the log says", () => {
    const log = [activityOf("final", { summary: "revise 6/10 — Too long." })];
    expect(finalVerdict(log, given())).toEqual({ verdict: "approve", score: 8.5, text: "The arc holds: the ledger pays off." });
  });

  it("is there when the log has no final review any more: it is not in the last 200 steps", () => {
    expect(finalVerdict([], given({ verdict: "revise", score: 7 }))).toEqual({ verdict: "revise", score: 7, text: "The arc holds: the ledger pays off." });
  });

  it("keeps a verdict that asks for a revision a revision: nothing is approved by default", () => {
    expect(finalVerdict([activityOf("final", { summary: "approve 9/10 — Fine." })], given({ verdict: "revise", score: 6.5 }))).toMatchObject({ verdict: "revise", score: 6.5 });
  });

  it("is what the log says when the engine did not say (a state that an older engine wrote), as it always was", () => {
    const log = [activityOf("final", { summary: "approve 8/10 — The arc holds." })];
    expect(finalVerdict(log, null)).toEqual(finalVerdict(log));
    expect(finalVerdict(log, undefined)).toEqual({ verdict: "approve", score: 8, text: "The arc holds." });
    expect(finalVerdict([], null)).toBeNull();
  });

  describe("the review of the summary and the one of the saved state", () => {
    const summaryOf = (review?: AutopilotFinalReview) => ({ finalReview: review });
    const longer = (patch: Partial<AutopilotFinalReview> = {}) => given({ text: "The arc holds: the ledger pays off. The middle drags a little and the epilogue is rushed; a longer epilogue would earn the ending.", ...patch });

    it("is the review of the summary, the one that is newest", () => {
      const review = given();
      expect(finalReviewOf(summaryOf(review), null)).toEqual(review);
    });

    it("takes the longer words of the saved state when it is the same review: the summary has them cut", () => {
      expect(finalReviewOf(summaryOf(given({ text: "The arc holds: the ledger pays off. The middle…" })), { finalReview: longer() })).toEqual(longer());
    });

    it("does not take the words of another review: a book that was finished again has a new verdict, and the old words are not its", () => {
      const newer = given({ at: "2026-11-21T12:00:00.000Z", score: 9, text: "Now it is tight." });
      expect(finalReviewOf(summaryOf(newer), { finalReview: longer() })).toEqual(newer);
    });

    it("is none when the summary has none: the book was reopened, and nobody has judged it as it is now, whatever an older download says", () => {
      expect(finalReviewOf(summaryOf(undefined), { finalReview: longer() })).toBeNull();
      expect(finalReviewOf(null, null)).toBeNull();
      expect(finalReviewOf(undefined, undefined)).toBeNull();
    });
  });
});

describe("since when the working time is counted", () => {
  const BEGUN = T0;
  const later = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

  it("is the moment the engine says, for a book that is older than the count: the time before it was never counted, and the card says so", () => {
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(72) }, BEGUN)).toBe(later(72));
  });

  it("is nothing for a book whose count began with the book: there is nothing to say, the whole of it is counted", () => {
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(0) }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(0.5) }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(1) }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(1.01) }, BEGUN)).toBe(later(1.01));
  });

  it("is nothing when the engine did not say it: a count that began before the moment was written has no moment, and none is made up", () => {
    expect(workedSince({ workedMs: 7_200_000 }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: undefined }, BEGUN)).toBeNull();
  });

  it.each([["words", "yesterday"], ["an empty text", ""], ["a number", 5], ["a date that is no date", "2026-13-45T99:00:00.000Z"]])("is nothing for %s: it is not a moment", (_name, value) => {
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: value as never }, BEGUN)).toBeNull();
  });

  it("is nothing without a count to say it of, and nothing when the book's own start is not known: the moment is not compared with what is not there", () => {
    expect(workedSince({ workedMsSince: later(72) }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 0, workedMsSince: later(72) }, BEGUN)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(72) }, undefined)).toBeNull();
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(72) }, "not a date")).toBeNull();
  });

  it("is nothing when the moment is before the start of the book: it cannot be, and it is not shown as if it were", () => {
    expect(workedSince({ workedMs: 7_200_000, workedMsSince: later(-5) }, BEGUN)).toBeNull();
  });
});

describe("how long the autopilot worked", () => {
  const step = (seconds: number, patch: Partial<AutopilotActivity> = {}) => activityOf("write", { startedAt: T0, endedAt: new Date(Date.parse(T0) + seconds * 1000).toISOString(), ...patch });

  it("adds up the time of the steps that ended", () => {
    expect(workedTime([step(60), step(90), step(30, { endedAt: undefined })])).toEqual({ milliseconds: 150_000, complete: true });
  });

  it("does not count a step that ends before it starts", () => {
    expect(workedTime([step(60), step(-5)])).toEqual({ milliseconds: 60_000, complete: true });
  });

  it("says the total is a minimum when the log is full: the oldest steps are no longer in it", () => {
    const full = Array.from({ length: 200 }, () => step(10));
    expect(workedTime(full)).toEqual({ milliseconds: 2_000_000, complete: false });
  });

  describe("when the engine counts it", () => {
    it("is the time the engine counted, whole, whatever the log holds: it outlives the 200 steps of the log", () => {
      const full = Array.from({ length: 200 }, () => step(10));
      expect(workedTime(full, 13_260_000)).toEqual({ milliseconds: 13_260_000, complete: true });
      expect(workedTime([], 90_000)).toEqual({ milliseconds: 90_000, complete: true });
    });

    it("is not the engine's number for a state that has none, nor for one that is zero or nonsense: the log says it, as it always did", () => {
      const full = Array.from({ length: 200 }, () => step(10));
      for (const absent of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(workedTime(full, absent as number | undefined), String(absent)).toEqual({ milliseconds: 2_000_000, complete: false });
      }
      expect(workedTime([step(60)], undefined)).toEqual({ milliseconds: 60_000, complete: true });
    });
  });
});

describe("how much of the budget is used", () => {
  const stats = { tasks: 1, aiCalls: 1, inputTokens: 60_000, outputTokens: 15_000, cost: 2.5, failures: 0 };
  const options = { ...createAutopilotState(new Date(T0)).options };

  it("compares the cost and the tokens with their budgets when there are budgets", () => {
    expect(budgetUse(stats, { ...options, budgetLimit: 10, budgetTokens: 150_000 })).toEqual({ cost: { value: 2.5, limit: 10, ratio: 0.25 }, tokens: { value: 75_000, limit: 150_000, ratio: 0.5 } });
  });

  it("has only the values when there is no budget (zero means no limit)", () => {
    expect(budgetUse(stats, { ...options, budgetLimit: 0, budgetTokens: 0 })).toEqual({ cost: { value: 2.5, limit: null, ratio: null }, tokens: { value: 75_000, limit: null, ratio: null } });
    expect(budgetUse(stats, { ...options, budgetLimit: 0, budgetTokens: undefined })).toEqual({ cost: { value: 2.5, limit: null, ratio: null }, tokens: { value: 75_000, limit: null, ratio: null } });
  });

  it("never goes past the whole bar: a budget that was passed is a full bar", () => {
    expect(budgetUse({ ...stats, cost: 12 }, { ...options, budgetLimit: 10 }).cost.ratio).toBe(1);
  });

  it("works without the options of the state (the page has only the summary at first)", () => {
    expect(budgetUse(stats, null)).toEqual({ cost: { value: 2.5, limit: null, ratio: null }, tokens: { value: 75_000, limit: null, ratio: null } });
  });
});

describe("what the step that runs has spent", () => {
  it("is what the activity says, and nothing when it says nothing: a figure is never worked out here (the engine says what a step cost when it ends)", () => {
    expect(stepSpendOf({ cost: 0.0123 })).toEqual({ cost: 0.0123 });
    expect(stepSpendOf({})).toBeNull();
    expect(stepSpendOf({ cost: 0 })).toBeNull();
    expect(stepSpendOf({ cost: Number.NaN })).toBeNull();
    expect(stepSpendOf({ cost: -1 })).toBeNull();
    expect(stepSpendOf(null)).toBeNull();
    expect(stepSpendOf(undefined)).toBeNull();
  });
});
