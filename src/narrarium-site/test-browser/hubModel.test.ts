import { describe, expect, it } from "vitest";
import { createAutopilotState, summarizeAutopilotState, type AutopilotActivity, type AutopilotState, type PlannedChapter } from "narrarium-engine";
import { chapterProgress, filterBooks, hubRank, hubState, hubStateOf, lastStep, lastVote, orderBooks } from "@/autopilot/hubModel";

const T0 = "2026-11-22T09:00:00.000Z";
const T1 = "2026-11-22T10:00:00.000Z";
const state = (patch: Partial<AutopilotState> = {}): AutopilotState => ({ ...createAutopilotState(new Date(T0)), updatedAt: T0, ...patch } as AutopilotState);
const chapter = (number: number, patch: Partial<PlannedChapter> = {}) => ({ number, title: `C${number}`, slug: `${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [], ...patch }) as PlannedChapter;
const plan = (chapters: PlannedChapter[], awaitingAuthor = false) => ({ chapters, approved: true, rounds: 1, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor });
const QUESTION = { id: "q", kind: "director" as const, question: "?", context: "", options: [], askedAt: T0 };

describe("the state a card says", () => {
  it("tells apart what the summary says, the plan that waits and a retry", () => {
    expect(hubState(null, null)).toBe("new");
    expect(hubState(summarizeAutopilotState(state({ status: "idle" })), null)).toBe("new");
    expect(hubState({ ...summarizeAutopilotState(state({ status: "running" })), retry: { at: T1, attempt: 1, retries: 3 } }, null)).toBe("retrying");
    expect(hubState(summarizeAutopilotState(state({ status: "paused" })), state({ plan: plan([], true) }))).toBe("plan");
    expect(hubState(summarizeAutopilotState(state({ status: "waiting-author", question: QUESTION })), null)).toBe("question");
    expect(hubState(summarizeAutopilotState(state({ status: "waiting-author" })), null)).toBe("profiles");
  });

  it("says a design that waits for the author's choice of a pitch waits for an answer, and not for profile files, from the summary and from the saved state", () => {
    const waiting = state({
      status: "waiting-author",
      design: { startedAt: T0, chapters: 6, rounds: [], workflow: { alternatives: 3, pitchChoice: "author" }, alternatives: { pitches: [{ id: "p1" }, { id: "p2" }] as never, evaluations: {}, recommended: { id: "p2", reason: "Sharper." } } },
    });
    expect(hubState(summarizeAutopilotState(waiting), null)).toBe("question");
    expect(hubStateOf(waiting, undefined)).toBe("question");
    // The same wait with the pitch chosen, or with no pitches, is what it always was.
    const chosen = { ...waiting, design: { ...waiting.design!, alternatives: { ...waiting.design!.alternatives!, selected: { id: "p1", by: "author" as const, reason: "", at: T0 } } } };
    expect(hubState(summarizeAutopilotState(chosen), null)).toBe("profiles");
    expect(hubStateOf(chosen, undefined)).toBe("profiles");
    expect(hubRank("question")).toBe(0);
  });

  it("for the order, follows the newest of what was heard and what was read, as the page's summary does", () => {
    const saved = state({ status: "paused" });
    const heard = { ...summarizeAutopilotState(saved), status: "waiting-author" as const, question: QUESTION, updatedAt: T1 };
    expect(hubStateOf(saved, undefined)).toBe("paused");
    expect(hubStateOf(saved, heard)).toBe("question");
    expect(hubStateOf(state({ status: "running", updatedAt: "2026-11-22T11:00:00.000Z" }), heard), "a summary older than the state it was read with is not the newest").toBe("running");
    expect(hubStateOf(null, heard)).toBe("new");
  });
});

describe("the order of the cards", () => {
  it("is: what asks the author something, then what runs, then the rest; the order of the library within each", () => {
    expect([hubRank("question"), hubRank("plan"), hubRank("profiles"), hubRank("error")]).toEqual([0, 0, 0, 0]);
    expect(hubRank("paused", 2), "frozen chapters that changed wait for the author").toBe(0);
    expect([hubRank("running"), hubRank("retrying")]).toEqual([1, 1]);
    expect([hubRank("paused"), hubRank("completed"), hubRank("new")]).toEqual([2, 2, 2]);
    const books = ["a", "b", "c", "d"].map((id) => ({ id }));
    const ranks: Record<string, 0 | 1 | 2> = { a: 2, b: 0, c: 1, d: 0 };
    expect(orderBooks(books, (id) => ranks[id]).map((book) => book.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("can be filtered by title, whatever the case, the accents and the script", () => {
    const books = [{ name: "Città di vetro" }, { name: "The Glass Harbor" }, { name: "Стеклянная гавань" }, { name: "玻璃港" }];
    expect(filterBooks(books, "CITTA").map((book) => book.name)).toEqual(["Città di vetro"]);
    expect(filterBooks(books, "гавань").map((book) => book.name)).toEqual(["Стеклянная гавань"]);
    expect(filterBooks(books, "玻璃").map((book) => book.name)).toEqual(["玻璃港"]);
    expect(filterBooks(books, "  ")).toHaveLength(4);
  });
});

describe("what a card says of a book", () => {
  it("counts the chapters closed out of the ones planned, and nothing before a plan", () => {
    expect(chapterProgress(summarizeAutopilotState(state({ plan: plan([chapter(1), chapter(2, { status: "writing" }), chapter(3, { status: "planned" })]) })))).toEqual({ done: 1, total: 3, ratio: 1 / 3 });
    expect(chapterProgress(summarizeAutopilotState(state()))).toBeNull();
    expect(chapterProgress(null)).toBeNull();
  });

  it("gives the director's last vote: the whole book's once it is judged, else the last chapter he voted, with the readers of its first round", () => {
    expect(lastVote(null)).toBeNull();
    expect(lastVote(state())).toBeNull();
    const chapters = [chapter(1, { rounds: [{ director: 8, readers: 7, verdict: "approve" }] }), chapter(2, { rounds: [{ director: 6, readers: 6.8, verdict: "revise" }, { director: 7.5, verdict: "approve" }] }), chapter(3, { status: "writing" })];
    expect(lastVote(state({ plan: plan(chapters) }))).toEqual({ kind: "chapter", number: 2, director: 7.5, readers: 6.8 });
    expect(lastVote(state({ plan: plan([chapter(1, { score: 7 })]) })), "a chapter of an older engine has its final score only").toEqual({ kind: "chapter", number: 1, director: 7, readers: null });
    expect(lastVote(state({ plan: plan(chapters), finalReview: { verdict: "approve", score: 8.5, text: "", at: T1 } }))).toEqual({ kind: "book", director: 8.5 });
  });

  it("gives the step that runs, else the last one of the log with when it ended", () => {
    const step = (patch: Partial<AutopilotActivity>) => ({ id: "s", runId: "r", task: "write", phase: "write", title: "Write", reason: "", next: "", status: "succeeded", startedAt: T0, ...patch }) as AutopilotActivity;
    expect(lastStep([], null)).toBeNull();
    expect(lastStep([step({ endedAt: T1 })], null)).toMatchObject({ now: false, at: T1 });
    expect(lastStep([step({ endedAt: T1 })], step({ id: "live", status: "running", startedAt: T1 }))).toMatchObject({ now: true, activity: { id: "live" } });
    expect(lastStep([step({ status: "running" })], null, true)).toMatchObject({ now: true });
    expect(lastStep([step({ status: "running" })], null, false), "a step an interrupted run left behind is not going on").toMatchObject({ now: false, at: T0 });
  });
});
