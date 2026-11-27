import { describe, expect, it } from "vitest";
import type { ChapterRound } from "narrarium-engine";
import { RESULT_ROWS, chapterScores, initialRows, moreRows, readFirst, scoreSeries, scoreSummary, sortScores, type ChapterScore } from "@/autopilot/resultModel";

const pad = (number: number) => String(number).padStart(3, "0");
const chapter = (number: number, score?: number, rounds?: ChapterRound[]) => ({ number, slug: `${pad(number)}-chapter-${number}`, ...(score !== undefined ? { score } : {}), ...(rounds ? { rounds } : {}) });
const round = (director?: number, readers?: number, accepted = 0, rejected = 0): ChapterRound => ({ ...(director !== undefined ? { director } : {}), ...(readers !== undefined ? { readers } : {}), accepted, rejected });
const scoreOf = (number: number, final: number | null, rounds: Array<number | null> = [], readers: number | null = null): ChapterScore => ({ number, slug: `${pad(number)}-chapter-${number}`, final, rounds, readers, roundCount: rounds.length });

describe("the scores of the chapters, read from the plan", () => {
  it("takes the final score of a chapter, and the vote of each round, oldest first, with the readers' last vote and whether it is of the chapter as it is now", () => {
    const [first] = chapterScores([chapter(1, 8, [round(6, 7.2, 3, 1), round(8, undefined, 0, 0)])]);
    // They read it in the first round, and the round after changed it: the vote is of an earlier text.
    expect(first).toEqual({ number: 1, slug: "001-chapter-1", final: 8, rounds: [6, 8], readers: 7.2, readersReading: { current: false }, roundCount: 2 });
  });

  it("shows the readers' LAST vote, not the first: the vote the readers gave after the corrections, with its round, and the reading of their own is no round of review", () => {
    const [entry] = chapterScores([chapter(1, 9, [
      { director: 6, readers: 5.8, readerVotes: { a: 5.6, b: 6 }, round: 1, verdict: "revise", accepted: 2, rejected: 0 },
      { director: 9, verdict: "approve", accepted: 0, rejected: 0 },
      { readers: 7, readerVotes: { a: 6, b: 8 }, round: 2, reading: "end" },
    ])]);
    expect(entry.rounds, "the reading is not one of the rounds of the director").toEqual([6, 9]);
    expect(entry.roundCount).toBe(2);
    expect(entry.readers).toBe(7);
    expect(entry.readersReading).toEqual({ round: 2, current: true, reading: "end", votes: { a: 6, b: 8 } });
  });

  it("makes the average of the readers that count when their votes are known, and the one the round says when they are not", () => {
    const rounds = [{ readers: 6.5, readerVotes: { a: 9, b: 4 }, round: 1, accepted: 0, rejected: 0, director: 8 }];
    expect(chapterScores([chapter(1, 8, rounds)])[0].readers).toBe(6.5);
    expect(chapterScores([chapter(1, 8, rounds)], new Set(["b"]))[0].readers, "without the reader that does not count").toBe(9);
    expect(chapterScores([chapter(1, 8, [round(8, 7.1)])], new Set(["b"]))[0].readers, "an older round has only the average of them all").toBe(7.1);
  });

  it("takes the verdict of each round when the plan says it, in the order of the votes: what the round decided is data, and no longer a text of the log", () => {
    const [recorded] = chapterScores([chapter(1, 8, [{ director: 6, verdict: "revise", accepted: 1, rejected: 0 }, { director: 8, verdict: "approve", accepted: 0, rejected: 0 }])]);
    expect(recorded).toMatchObject({ rounds: [6, 8], verdicts: ["revise", "approve"] });
  });

  it("has no list of verdicts for a plan that records none (an older state): none is made up", () => {
    const [older] = chapterScores([chapter(1, 8, [round(6, 7.2, 3, 1), round(8)])]);
    expect(older).not.toHaveProperty("verdicts");
    expect(older).toEqual({ number: 1, slug: "001-chapter-1", final: 8, rounds: [6, 8], readers: 7.2, readersReading: { current: false }, roundCount: 2 });
  });

  it("says null for a round that has no verdict among the ones that do, and for a word that is not one of the two", () => {
    const [mixed] = chapterScores([chapter(1, 8, [{ director: 6 }, { director: 7, verdict: "rewrite" as never }, { director: 8, verdict: "approve" }])]);
    expect(mixed.verdicts).toEqual([null, null, "approve"]);
  });

  it("takes the vote of the last round for a chapter whose final score is not there (a chapter closed by an older engine has one, but not the other)", () => {
    expect(chapterScores([chapter(2, undefined, [round(5), round(7)])])[0]).toMatchObject({ final: 7, rounds: [5, 7] });
  });

  it("has no final score for a chapter that has none and no round, and leaves such a chapter out: nothing is made up for it", () => {
    const imported = { ...chapter(3), imported: true };
    const scores = chapterScores([chapter(1), chapter(2, 7), imported, chapter(4, undefined, [round(undefined, 6.5)])]);
    expect(scores.map((entry) => entry.number)).toEqual([2, 4]);
    expect(scores[1]).toMatchObject({ final: null, rounds: [null], readers: 6.5, readersReading: { current: true } });
  });

  it("keeps the order of the chapters and counts the rounds of the record", () => {
    const scores = chapterScores([chapter(3, 9), chapter(1, 6, [round(6)]), chapter(2, 7, [round(5), round(6), round(7)])]);
    expect(scores.map((entry) => [entry.number, entry.roundCount])).toEqual([[3, 0], [1, 1], [2, 3]]);
  });

  it("drops a vote that is not a number instead of showing it", () => {
    const [entry] = chapterScores([chapter(1, Number.NaN, [{ director: Number.NaN, readers: Number.POSITIVE_INFINITY }, round(7)])]);
    expect(entry).toMatchObject({ final: 7, rounds: [null, 7], readers: null });
  });

  it("does not read the title of a chapter: a plan has no maximum number of chapters", () => {
    const guarded = Array.from({ length: 50 }, (_, index) => Object.defineProperty({ ...chapter(index + 1, 7) }, "title", { get: () => { throw new Error("the title was read"); } }));
    expect(() => chapterScores(guarded)).not.toThrow();
  });
});

describe("the figures of the scores", () => {
  const scores = [scoreOf(1, 8), scoreOf(2, 6), scoreOf(3, 9), scoreOf(4, 5.5), scoreOf(5, 7.5), scoreOf(6, null, [null])];

  it("says how many chapters were scored, the average, the lowest and the highest, and the first and the last chapter that has a final score", () => {
    expect(scoreSummary(scores)).toEqual({ count: 5, average: 7.2, lowest: { number: 4, score: 5.5 }, highest: { number: 3, score: 9 }, first: 1, last: 5 });
  });

  it("has nothing to say when no chapter has a final score", () => {
    expect(scoreSummary([])).toBeNull();
    expect(scoreSummary([scoreOf(1, null, [null])])).toBeNull();
  });

  it("puts the chapters in the order of the book, or the lowest score first with the chapters that have no final score at the end", () => {
    expect(sortScores(scores, "chapter").map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sortScores(scores, "lowest").map((entry) => entry.number)).toEqual([4, 2, 5, 1, 3, 6]);
    expect(sortScores([scoreOf(2, 7), scoreOf(1, 7)], "lowest").map((entry) => entry.number), "the same score: the earlier chapter first").toEqual([1, 2]);
  });

  it("does not change the list it is given", () => {
    const before = scores.map((entry) => entry.number);
    sortScores(scores, "lowest");
    expect(scores.map((entry) => entry.number)).toEqual(before);
  });
});

describe("the chapters to read first", () => {
  // Average of the finals: (8 + 6 + 9 + 5.5 + 7.5 + 8.5) / 6 = 7.42
  const list = [scoreOf(1, 8, [8]), scoreOf(2, 6, [4.5, 6]), scoreOf(3, 9, [6, 7, 8, 8.5, 9]), scoreOf(4, 5.5, [4, 5, 5.5]), scoreOf(5, 7.5, [7.5]), scoreOf(6, 8.5, [8.5])];

  it("takes the three that need the most attention: the lowest final scores, and the chapters that needed many rounds of review", () => {
    const picked = readFirst(list);
    expect(picked.map((entry) => entry.chapter.number)).toEqual([4, 2, 3]);
  });

  it("says why, in a reason each can be told in one line: the lowest of the book, below the average, or many rounds, or both", () => {
    const picked = readFirst(list);
    expect(picked.map((entry) => entry.reason)).toEqual(["both", "below", "rounds"]);
    expect(picked[0]).toMatchObject({ rounds: 3, score: 5.5, average: 7.4 });
    expect(readFirst([scoreOf(1, 5, [5]), scoreOf(2, 8, [8]), scoreOf(3, 9, [9])])[0].reason, "the lowest, and a single round").toBe("lowest");
  });

  it("calls a score that is not under the average, on a chapter that needed one round, nothing special", () => {
    const picked = readFirst([scoreOf(1, 9, [9]), scoreOf(2, 9, [9]), scoreOf(3, 9, [9])]);
    expect(picked).toHaveLength(3);
    expect(picked.every((entry) => entry.reason === "lowest" || entry.reason === "plain")).toBe(true);
  });

  it("takes fewer when the book has fewer chapters with a score, and none when no chapter has one", () => {
    expect(readFirst([scoreOf(1, 7, [7]), scoreOf(2, 6, [6])]).map((entry) => entry.chapter.number)).toEqual([2, 1]);
    expect(readFirst([])).toEqual([]);
    expect(readFirst([scoreOf(1, null, [null])])).toEqual([]);
  });

  it("breaks a tie by the earlier chapter, and accepts another number of chapters to take", () => {
    const tie = [scoreOf(5, 6, [6]), scoreOf(2, 6, [6]), scoreOf(9, 6, [6]), scoreOf(1, 9, [9])];
    expect(readFirst(tie).map((entry) => entry.chapter.number)).toEqual([2, 5, 9]);
    expect(readFirst(tie, 1).map((entry) => entry.chapter.number)).toEqual([2]);
  });
});

describe("how many rows of the table are drawn", () => {
  it("draws all of a short book and a window of a long one, and gives the rest with a button", () => {
    expect(RESULT_ROWS).toBe(10);
    expect(initialRows(5)).toBe(5);
    expect(initialRows(12)).toBe(12);
    expect(initialRows(13)).toBe(10);
    expect(initialRows(64)).toBe(10);
  });

  it("gives all the rest when it is not much, and a hundred more at a time when it is a great deal", () => {
    expect(moreRows(10, 64)).toBe(64);
    expect(moreRows(10, 310)).toBe(310);
    expect(moreRows(10, 5000)).toBe(110);
    expect(moreRows(110, 5000)).toBe(210);
    expect(moreRows(4900, 5000)).toBe(5000);
  });
});

describe("the series of the final scores, for the picture", () => {
  it("has a bar for each chapter that has a score, at the height of the score", () => {
    const bars = scoreSeries([scoreOf(1, 8), scoreOf(2, null), scoreOf(3, 6.5)]);
    expect(bars).toEqual([{ from: 1, to: 1, value: 8 }, { from: 3, to: 3, value: 6.5 }]);
  });

  it("makes a long book fit: the chapters are put in groups, each with the average of its scores and the chapters it covers", () => {
    const many = Array.from({ length: 200 }, (_, index) => scoreOf(index + 1, index < 100 ? 6 : 8));
    const bars = scoreSeries(many, 50);
    expect(bars).toHaveLength(50);
    expect(bars[0]).toEqual({ from: 1, to: 4, value: 6 });
    expect(bars[49]).toEqual({ from: 197, to: 200, value: 8 });
    expect(bars.every((bar) => bar.to >= bar.from)).toBe(true);
  });

  it("is empty for a book with no score", () => {
    expect(scoreSeries([])).toEqual([]);
    expect(scoreSeries([scoreOf(1, null)])).toEqual([]);
  });
});
