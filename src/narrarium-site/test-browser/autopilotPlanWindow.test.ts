import { describe, expect, it } from "vitest";
import { PLAN_FULL_LIST_LIMIT, chapterInProgress, countRun, mergeRanges, nextReveal, planSegments, type PlanSegment } from "@/autopilot/planWindow";

type Status = "planned" | "writing" | "review" | "done";

const chapters = (count: number, done: number, tail: Status = "planned"): Array<{ status: Status }> =>
  Array.from({ length: count }, (_, index) => ({ status: index < done ? "done" : index === done ? "writing" : tail }));

const shape = (segments: PlanSegment[]) => segments.map((segment) => `${segment.kind === "shown" ? "+" : "-"}${segment.from}..${segment.to}`);

describe("the chapter in progress", () => {
  it("is the first chapter that is not approved", () => {
    expect(chapterInProgress(chapters(10, 0))).toBe(0);
    expect(chapterInProgress(chapters(10, 3))).toBe(3);
    expect(chapterInProgress([{ status: "done" }, { status: "review" }, { status: "writing" }])).toBe(1);
    expect(chapterInProgress([{ status: "done" }, { status: "planned" }, { status: "done" }])).toBe(1);
  });

  it("does not exist once every chapter is approved, or in an empty plan", () => {
    expect(chapterInProgress([{ status: "done" }, { status: "done" }])).toBe(-1);
    expect(chapterInProgress([])).toBe(-1);
  });
});

describe("the window on a long plan", () => {
  it("shows the first and last five chapters and five around the chapter in progress, hiding what lies between", () => {
    expect(shape(planSegments(2000, 999, []))).toEqual(["+0..4", "-5..993", "+994..1004", "-1005..1994", "+1995..1999"]);
  });

  it("joins the blocks that touch or overlap", () => {
    expect(shape(planSegments(2000, 0, []))).toEqual(["+0..5", "-6..1994", "+1995..1999"]);
    expect(shape(planSegments(2000, 8, []))).toEqual(["+0..13", "-14..1994", "+1995..1999"]);
    expect(shape(planSegments(2000, 1990, []))).toEqual(["+0..4", "-5..1984", "+1985..1999"]);
    expect(shape(planSegments(2000, 1999, []))).toEqual(["+0..4", "-5..1993", "+1994..1999"]);
  });

  it("shows only the two ends when every chapter is approved", () => {
    expect(shape(planSegments(2000, -1, []))).toEqual(["+0..4", "-5..1994", "+1995..1999"]);
  });

  it("starts at one chapter more than the limit for a full list", () => {
    expect(PLAN_FULL_LIST_LIMIT).toBe(40);
    expect(shape(planSegments(41, 0, []))).toEqual(["+0..5", "-6..35", "+36..40"]);
    expect(shape(planSegments(41, 20, []))).toEqual(["+0..4", "-5..14", "+15..25", "-26..35", "+36..40"]);
  });

  it("has nothing to hide in a short plan, and nothing at all in an empty one", () => {
    expect(shape(planSegments(11, 5, []))).toEqual(["+0..10"]);
    expect(shape(planSegments(3, 1, []))).toEqual(["+0..2"]);
    expect(planSegments(0, -1, [])).toEqual([]);
  });

  it("keeps what the author opened, even when the chapter in progress moves on", () => {
    const opened = [{ from: 5, to: 54 }];
    expect(shape(planSegments(2000, 999, opened))).toEqual(["+0..54", "-55..993", "+994..1004", "-1005..1994", "+1995..1999"]);
    expect(shape(planSegments(2000, 1000, opened))).toEqual(["+0..54", "-55..994", "+995..1005", "-1006..1994", "+1995..1999"]);
    expect(shape(planSegments(2000, 999, [{ from: 1005, to: 1054 }]))).toEqual(["+0..4", "-5..993", "+994..1054", "-1055..1994", "+1995..1999"]);
  });

  it("never lets opened ranges leave the plan", () => {
    expect(shape(planSegments(100, 50, [{ from: -20, to: 3 }, { from: 90, to: 400 }, { from: 300, to: 400 }]))).toEqual(["+0..4", "-5..44", "+45..55", "-56..89", "+90..99"]);
  });

  it("is computed without walking through the chapters", () => {
    const started = performance.now();
    for (let round = 0; round < 1000; round += 1) planSegments(100_000, 50_000 + round, [{ from: 5, to: 54 }]);
    expect(performance.now() - started).toBeLessThan(250);
    expect(shape(planSegments(100_000, 50_000, []))).toEqual(["+0..4", "-5..49994", "+49995..50005", "-50006..99994", "+99995..99999"]);
  });
});

describe("opening a hidden run", () => {
  it("shows fifty chapters at a time, or all of it when it is at most a hundred", () => {
    expect(nextReveal({ from: 5, to: 1304 })).toEqual({ from: 5, to: 54 });
    expect(nextReveal({ from: 5, to: 104 })).toEqual({ from: 5, to: 104 });
    expect(nextReveal({ from: 5, to: 105 })).toEqual({ from: 5, to: 54 });
    expect(nextReveal({ from: 7, to: 7 })).toEqual({ from: 7, to: 7 });
    expect(nextReveal({ from: 10, to: 60 })).toEqual({ from: 10, to: 60 });
  });

  it("ends with all of it, however long the run is", () => {
    let hidden = shape(planSegments(2000, 999, [])).filter((entry) => entry.startsWith("-")).length;
    let opened: Array<{ from: number; to: number }> = [];
    let clicks = 0;
    while (hidden > 0 && clicks < 100) {
      const run = planSegments(2000, 999, opened).find((segment) => segment.kind === "hidden");
      if (!run) break;
      opened = mergeRanges([...opened, nextReveal(run)]);
      hidden = planSegments(2000, 999, opened).filter((segment) => segment.kind === "hidden").length;
      clicks += 1;
    }
    expect(hidden).toBe(0);
    expect(clicks).toBeLessThanOrEqual(40);
  });
});

describe("ranges", () => {
  it("are sorted and joined when they overlap or touch", () => {
    expect(mergeRanges([{ from: 10, to: 12 }, { from: 0, to: 4 }, { from: 5, to: 6 }, { from: 11, to: 20 }])).toEqual([{ from: 0, to: 6 }, { from: 10, to: 20 }]);
    expect(mergeRanges([])).toEqual([]);
  });
});

describe("what a hidden run holds", () => {
  it("counts the chapters written by the author, approved, in progress and only planned", () => {
    const list: Array<{ status: Status; imported?: boolean }> = [{ status: "done", imported: true }, { status: "done", imported: true }, { status: "done" }, { status: "planned" }, { status: "review" }, { status: "writing" }, { status: "planned" }];
    expect(countRun(list, { from: 0, to: 1 })).toEqual({ imported: 2, approved: 0, active: 0, planned: 0 });
    expect(countRun(list, { from: 2, to: 2 })).toEqual({ imported: 0, approved: 1, active: 0, planned: 0 });
    expect(countRun(list, { from: 3, to: 6 })).toEqual({ imported: 0, approved: 0, active: 2, planned: 2 });
    expect(countRun(list, { from: 0, to: 6 })).toEqual({ imported: 2, approved: 1, active: 2, planned: 2 });
  });
});
