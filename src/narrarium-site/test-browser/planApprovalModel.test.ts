import { describe, expect, it } from "vitest";
import { createAutopilotState, outlineEntryDigest, serializeOutlineChapter, type AutopilotPlan, type AutopilotState } from "narrarium-engine";
import { castMember, castPaths, changeEffect, outlineOrigins, pendingPlanChanges, planReviewMode, planReviews, premiseOf } from "@/autopilot/planApprovalModel";
import { chapter, longPlan, planOf, scene } from "./helpers/autopilotFixtures";
import { activityOf } from "./helpers/autopilotBand";

const T0 = "2026-11-21T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

function stateWith(plan: Partial<AutopilotPlan> | null, status: AutopilotState["status"] = "paused"): AutopilotState {
  return { ...createAutopilotState(new Date(T0)), status, plan: plan ? { ...planOf(longPlan(3, 0, () => "planned")), ...plan } : null };
}

const NOTE = "Chapter 2 «Title 2»: the harbor master must not appear before the storm.";

describe("what the plan waits for", () => {
  it("waits for the author's approval while it awaits the author and nothing runs", () => {
    expect(planReviewMode(stateWith({ awaitingAuthor: true }), false)).toBe("approve");
    // A question of the director does not hide the plan: the author answers it and reads the plan in the same place.
    expect(planReviewMode({ ...stateWith({ awaitingAuthor: true }), status: "waiting-author" }, false)).toBe("approve");
  });

  it("waits to be made again when it was reopened with changes, and nothing runs", () => {
    expect(planReviewMode(stateWith({ approved: false, awaitingAuthor: false, revisionNotes: [NOTE] }), false)).toBe("revise");
    expect(planReviewMode(stateWith({ approved: false, awaitingAuthor: false, revisionNotes: [NOTE] }, "idle"), false)).toBe("revise");
  });

  it("waits for nothing while a run goes on, for an approved plan, for a plan without changes, for an extension of the book or after an error", () => {
    expect(planReviewMode(stateWith({ awaitingAuthor: true }), true)).toBeNull();
    expect(planReviewMode(stateWith({ approved: false, revisionNotes: [NOTE] }, "running"), false)).toBeNull();
    expect(planReviewMode(stateWith({ approved: true, awaitingAuthor: false }), false)).toBeNull();
    expect(planReviewMode(stateWith({ approved: false, awaitingAuthor: false, revisionNotes: [] }), false)).toBeNull();
    expect(planReviewMode(stateWith({ approved: false, revisionNotes: ["Extend the book to 20 chapters, continuing from the chapters already written."] }), false)).toBeNull();
    expect(planReviewMode(stateWith({ approved: false, revisionNotes: [NOTE] }, "error"), false)).toBeNull();
    expect(planReviewMode(stateWith(null), false)).toBeNull();
    expect(planReviewMode(null, false)).toBeNull();
  });

  it("lists the changes the plan will be made again with, without the note that only extends the book", () => {
    const extension = "Extend the book to 20 chapters, continuing from the chapters already written.";
    expect(pendingPlanChanges({ revisionNotes: [extension, NOTE, "Chapter 3: a quieter ending."] })).toEqual([NOTE, "Chapter 3: a quieter ending."]);
    expect(pendingPlanChanges(null)).toEqual([]);
  });
});

describe("what asking for a change does", () => {
  it("makes the plan again when nothing of the book is written, as the engine's rewrite does", () => {
    expect(changeEffect({ chapters: longPlan(4, 0, () => "planned") })).toBe("replan");
  });

  it("revises the chapters already written when the book has some: the plan is not made again", () => {
    const imported = chapter(1, "done", { imported: true, scenes: [scene(1, "reviewed", 900)] });
    expect(changeEffect({ chapters: [imported, ...longPlan(3, 0, () => "planned").map((entry, index) => ({ ...entry, number: index + 2 }))] })).toBe("revise-written");
  });
});

describe("the director's reviews of the plan", () => {
  const review = (summary: string, seconds: number, status: "succeeded" | "failed" = "succeeded") => activityOf("plan-review", { id: `review-${seconds}`, phase: "plan", summary, status, startedAt: at(seconds), endedAt: at(seconds + 20) });

  it("are the reviews of the planning that led to this plan, oldest first, with their verdict, vote and words", () => {
    const activities = [
      activityOf("concept", { phase: "concept", startedAt: at(0) }),
      activityOf("plan", { phase: "plan", startedAt: at(30) }),
      review("revise 5/10 — The middle sags.", 60),
      activityOf("plan", { phase: "plan", startedAt: at(90) }),
      review("revise 6,5/10 — Better, but chapter 4 repeats chapter 2.", 120),
      review("approve 8/10 — irrelevant: it failed", 150, "failed"),
      activityOf("plan-reader", { phase: "plan", reader: "anna", startedAt: at(160) }),
      review("approve 8/10 — A solid plan: every chapter turns.", 180),
    ];
    expect(planReviews(activities)).toEqual([
      { number: 1, verdict: "revise", score: 5, text: "The middle sags.", at: at(80) },
      { number: 2, verdict: "revise", score: 6.5, text: "Better, but chapter 4 repeats chapter 2.", at: at(140) },
      { number: 3, verdict: "approve", score: 8, text: "A solid plan: every chapter turns.", at: at(200) },
    ]);
  });

  it("leave out the reviews of an earlier planning: the book was written in between", () => {
    const activities = [
      review("approve 7/10 — The first plan.", 0),
      activityOf("write", { chapterNumber: 1, sceneNumber: 1, startedAt: at(30) }),
      activityOf("plan", { phase: "plan", startedAt: at(60) }),
      review("approve 9/10 — The extension holds.", 90),
    ];
    expect(planReviews(activities).map((entry) => entry.text)).toEqual(["The extension holds."]);
  });

  it("are none when the history has no review that can be read", () => {
    expect(planReviews([])).toEqual([]);
    expect(planReviews([activityOf("plan-review", { phase: "plan", summary: "Something the engine did not write." })])).toEqual([]);
  });
});

describe("the cast", () => {
  it("is what the concept created under characters/, in the order it wrote them", () => {
    const concept = activityOf("concept", { phase: "concept", changedPaths: ["story-design.md", "characters/mira-vale.md", "locations/glass-harbor.md", "characters/orrin-hale.md", "secrets/the-wall.md"] });
    expect(castPaths([concept])).toEqual(["characters/mira-vale.md", "characters/orrin-hale.md"]);
    // The last concept that worked is the one: an earlier one, or one that failed, is not.
    const failed = activityOf("concept", { phase: "concept", status: "failed", changedPaths: ["characters/nobody.md"], startedAt: at(100) });
    expect(castPaths([concept, failed])).toEqual(["characters/mira-vale.md", "characters/orrin-hale.md"]);
    expect(castPaths([])).toEqual([]);
  });

  it("says each character in one line, from its file", () => {
    const file = "---\ntype: character\nid: character:mira-vale\nname: Mira Vale\nrole_tier: main\nstory_role: protagonist\nfunction_in_book: A stubborn young glassmaker.\ncanon: draft\n---\n\n# Mira Vale\n\nA stubborn young glassmaker.\n";
    expect(castMember("characters/mira-vale.md", file)).toEqual({ path: "characters/mira-vale.md", slug: "mira-vale", name: "Mira Vale", role: "protagonist", tier: "main", line: "A stubborn young glassmaker." });
    // Without the function, the first line of the text after the title; without the file, the name from the name of the file.
    expect(castMember("characters/orrin-hale.md", "---\ntype: character\nname: Orrin Hale\n---\n\n# Orrin Hale\n\nThe harbor master, smooth and patient.\n").line).toBe("The harbor master, smooth and patient.");
    expect(castMember("characters/li-wei.md", null)).toEqual({ path: "characters/li-wei.md", slug: "li-wei", name: "Li Wei", role: null, tier: null, line: null });
    expect(castMember("characters/ana.md", "---\nname: Ана\nstory_role: something-else\n---\n").role).toBeNull();
  });
});

describe("the premise", () => {
  it("is the section of the story design that is called so, in English or in Italian", () => {
    expect(premiseOf("# Story Design\n\n> The pitch.\n\n## Premise\n\nMira uncovers the harbor's oldest lie.\n\nIt costs her the workshop.\n\n## Main Conflict\n\nThe council.\n")).toBe("Mira uncovers the harbor's oldest lie.\n\nIt costs her the workshop.");
    expect(premiseOf("# Story Design\n\n## Premessa\n\nMira scopre la menzogna del porto.\n\n## Conflitto\n\nIl consiglio.\n")).toBe("Mira scopre la menzogna del porto.");
  });

  it("is the first section when none is called so (a story design written in another language), and nothing when it is empty", () => {
    expect(premiseOf("# 物語の設計\n\n## 前提\n\nミラは港の嘘を暴く。\n\n## 対立\n\n議会。\n")).toBe("ミラは港の嘘を暴く。");
    expect(premiseOf("# Story Design\n\n## Premise\n\n## Main Conflict\n")).toBeNull();
    expect(premiseOf(null)).toBeNull();
    expect(premiseOf("---\ntype: note\n---\n\n# Story Design\n")).toBeNull();
  });
});

describe("who wrote the entries of the outline", () => {
  it("is the author for an entry of the author, or one of the autopilot that the author changed; the autopilot for one it wrote and nobody touched", async () => {
    const mine = serializeOutlineChapter({ number: 1, title: "The key", body: "Mira finds the key.", origin: "author" });
    const content = { title: "Chapter Title 2", body: "Summary of chapter 2." };
    const theirs = serializeOutlineChapter({ number: 2, ...content, origin: "autopilot", digest: await outlineEntryDigest(content) });
    const touched = serializeOutlineChapter({ number: 3, title: "Changed by me", body: "Something else.", origin: "autopilot", digest: await outlineEntryDigest(content) });
    const origins = await outlineOrigins([
      { path: "outline/chapters/001.md", content: mine },
      { path: "outline/chapters/002.md", content: theirs },
      { path: "outline/chapters/003.md", content: touched },
      { path: "outline/book.md", content: "---\ntype: outline\n---\n\nThe book." },
    ]);
    expect([...origins.entries()]).toEqual([[1, "author"], [2, "autopilot"], [3, "author"]]);
  });
});
