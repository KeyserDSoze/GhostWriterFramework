import { describe, expect, it } from "vitest";
import type { ChapterReview, RevisionRequest } from "narrarium-engine";
import { MAP_PAGE_SIZE, SCENE_STATES, chapterMatches, chapterStateOf, mapContext, moveInGrid, pageStart, progressIndex, sceneCounts, sceneStateOf } from "@/autopilot/chapterMapModel";
import { chapter, longPlan, scene } from "./helpers/autopilotFixtures";

const NOTHING = mapContext(null, null, new Set());
const reviewOf = (chapterNumber: number, patch: Partial<ChapterReview> = {}) => ({ chapterNumber, round: 1, readersPending: [], readerScores: [], readersSummaryDone: true, findings: [], specialistsDone: true, directorDone: false, decisions: [], repairQueue: [], previousFixes: [], history: [], ...patch }) as ChapterReview;
const revisionOf = (targets: RevisionRequest["targets"], cursor = 0) => ({ id: "revision-1", instruction: "Make Orrin kinder.", createdAt: "2026-11-21T10:00:00.000Z", targets, cursor }) as RevisionRequest;

describe("the state of a scene", () => {
  it("has seven words, always in the same order", () => {
    expect(SCENE_STATES).toEqual(["todo", "writing", "written", "review", "approved", "rewrite", "frozen"]);
  });

  it("is to write, being written or written while its chapter is being written", () => {
    const writing = chapter(5, "writing", { scenes: [scene(1, "written", 900), scene(2, "planned"), scene(3, "planned")] });
    const live = mapContext(null, { task: "write", chapterNumber: 5, sceneNumber: 2 }, new Set());
    expect(writing.scenes.map((entry) => sceneStateOf(writing, entry, live))).toEqual(["written", "writing", "todo"]);
    expect(writing.scenes.map((entry) => sceneStateOf(writing, entry, NOTHING))).toEqual(["written", "todo", "todo"]);
  });

  it("is in review while its chapter is, and to rewrite when the director sent it back for fixes, until the fix is being written", () => {
    const review = chapter(4, "review", { scenes: [scene(1, "written", 900), scene(2, "written", 880)] });
    const sentBack = mapContext({ review: reviewOf(4, { directorDone: true, verdict: "revise", repairQueue: [2] }), revision: null }, null, new Set());
    expect(review.scenes.map((entry) => sceneStateOf(review, entry, sentBack))).toEqual(["review", "rewrite"]);
    const fixing = mapContext({ review: reviewOf(4, { repairQueue: [2] }), revision: null }, { task: "repair", chapterNumber: 4, sceneNumber: 2 }, new Set());
    expect(sceneStateOf(review, review.scenes[1], fixing)).toBe("writing");
  });

  it("is approved, frozen, or written for a chapter the author wrote", () => {
    const done = chapter(2, "done", { scenes: [scene(1, "reviewed", 900)] });
    expect(sceneStateOf(done, done.scenes[0], NOTHING)).toBe("approved");
    expect(sceneStateOf(done, done.scenes[0], mapContext(null, null, new Set([done.slug])))).toBe("frozen");
    const imported = chapter(1, "done", { imported: true, scenes: [scene(1, "reviewed", 1200)] });
    expect(sceneStateOf(imported, imported.scenes[0], NOTHING)).toBe("written");
    expect(sceneStateOf(imported, imported.scenes[0], mapContext(null, null, new Set([imported.slug])))).toBe("frozen");
  });

  it("is to rewrite when a revision of the book will rewrite it, and not once the revision went past it", () => {
    const done = chapter(2, "done", { scenes: [scene(1, "reviewed", 900), scene(2, "reviewed", 900)] });
    const targets = [{ chapterNumber: 2, sceneNumber: 1, instruction: "Kinder." }, { chapterNumber: 2, sceneNumber: 2, instruction: "Kinder." }];
    const pending = mapContext({ review: null, revision: revisionOf(targets, 1) }, null, new Set([done.slug]));
    expect(done.scenes.map((entry) => sceneStateOf(done, entry, pending))).toEqual(["frozen", "rewrite"]);
    // A revision whose impact the director has not judged yet names no scene.
    expect(sceneStateOf(done, done.scenes[0], mapContext({ review: null, revision: revisionOf(null) }, null, new Set()))).toBe("approved");
  });
});

describe("the state of a chapter", () => {
  it("follows the plan, the revision and the step that runs", () => {
    expect(chapterStateOf(chapter(9, "planned"), NOTHING)).toBe("planned");
    expect(chapterStateOf(chapter(5, "writing"), NOTHING)).toBe("writing");
    expect(chapterStateOf(chapter(4, "review"), NOTHING)).toBe("review");
    expect(chapterStateOf(chapter(2, "done"), NOTHING)).toBe("approved");
    expect(chapterStateOf(chapter(1, "done", { imported: true }), NOTHING)).toBe("imported");
    const revising = mapContext({ review: null, revision: revisionOf([{ chapterNumber: 2, sceneNumber: 1, instruction: "Kinder." }]) }, null, new Set());
    expect(chapterStateOf(chapter(2, "done", { scenes: [scene(1, "reviewed")] }), revising)).toBe("rewrite");
    expect(chapterStateOf(chapter(2, "done", { scenes: [scene(1, "reviewed")] }), mapContext(null, { task: "revise", chapterNumber: 2, sceneNumber: 1 }, new Set()))).toBe("writing");
  });

  it("counts its scenes by state, for the table", () => {
    const review = chapter(4, "review", { scenes: [scene(1, "written"), scene(2, "written"), scene(3, "written")] });
    expect(sceneCounts(review, mapContext({ review: reviewOf(4, { repairQueue: [3] }), revision: null }, null, new Set()))).toEqual({ review: 2, rewrite: 1 });
    expect(sceneCounts(chapter(9, "planned"), NOTHING)).toEqual({});
  });
});

describe("moving in the map with the keys", () => {
  // Three rows: a chapter with three scenes, one whose scenes are not planned, one with two.
  const cells = [4, 1, 3];
  const page = { ctrl: false, page: 10 };

  it("goes right and left inside a row, and stops at its ends", () => {
    expect(moveInGrid({ row: 0, col: 0 }, "ArrowRight", cells, page)).toEqual({ row: 0, col: 1 });
    expect(moveInGrid({ row: 0, col: 3 }, "ArrowRight", cells, page)).toBeNull();
    expect(moveInGrid({ row: 0, col: 2 }, "ArrowLeft", cells, page)).toEqual({ row: 0, col: 1 });
    expect(moveInGrid({ row: 0, col: 0 }, "ArrowLeft", cells, page)).toBeNull();
  });

  it("goes up and down to the same column, or to the last cell of a shorter row", () => {
    expect(moveInGrid({ row: 0, col: 3 }, "ArrowDown", cells, page)).toEqual({ row: 1, col: 0 });
    expect(moveInGrid({ row: 1, col: 0 }, "ArrowDown", cells, page)).toEqual({ row: 2, col: 0 });
    expect(moveInGrid({ row: 2, col: 2 }, "ArrowUp", cells, page)).toEqual({ row: 1, col: 0 });
    expect(moveInGrid({ row: 2, col: 2 }, "ArrowDown", cells, page)).toBeNull();
    expect(moveInGrid({ row: 0, col: 1 }, "ArrowUp", cells, page)).toBeNull();
  });

  it("goes to the ends of a row with Home and End, of the map with Control, and by pages", () => {
    expect(moveInGrid({ row: 2, col: 1 }, "Home", cells, page)).toEqual({ row: 2, col: 0 });
    expect(moveInGrid({ row: 0, col: 1 }, "End", cells, page)).toEqual({ row: 0, col: 3 });
    expect(moveInGrid({ row: 2, col: 1 }, "Home", cells, { ...page, ctrl: true })).toEqual({ row: 0, col: 0 });
    expect(moveInGrid({ row: 0, col: 1 }, "End", cells, { ...page, ctrl: true })).toEqual({ row: 2, col: 2 });
    expect(moveInGrid({ row: 0, col: 3 }, "PageDown", cells, { ...page, page: 2 })).toEqual({ row: 2, col: 2 });
    expect(moveInGrid({ row: 2, col: 2 }, "PageUp", cells, page)).toEqual({ row: 0, col: 2 });
    expect(moveInGrid({ row: 0, col: 0 }, "a", cells, page)).toBeNull();
  });
});

describe("the window of a long book", () => {
  it("is fifty chapters, the one with the chapter in progress first", () => {
    expect(MAP_PAGE_SIZE).toBe(50);
    expect(progressIndex(longPlan(3000, 1234))).toBe(1234);
    expect(progressIndex(longPlan(12, 12))).toBe(-1);
    expect(pageStart(1234, MAP_PAGE_SIZE)).toBe(1200);
    expect(pageStart(-1, MAP_PAGE_SIZE)).toBe(0);
  });

  it("finds chapters by number or by words of their title, in any alphabet, and reads no title when there is nothing to find", () => {
    const chapters = longPlan(3000, 10);
    chapters[41] = { ...chapters[41], title: "Город у моря" };
    chapters[2499] = { ...chapters[2499], title: "港の灯り" };
    expect(chapterMatches(chapters, "")).toBeNull();
    expect(chapterMatches(chapters, "   ")).toBeNull();
    expect(chapterMatches(chapters, "2750")).toEqual([2749]);
    expect(chapterMatches(chapters, "город")).toEqual([41]);
    expect(chapterMatches(chapters, "灯り")).toEqual([2499]);
    expect(chapterMatches(chapters, "Title 129")).toEqual([128, 1289, 1290, 1291, 1292, 1293, 1294, 1295, 1296, 1297, 1298]);
    expect(chapterMatches(chapters, "nothing like this")).toEqual([]);
  });
});
