import { describe, expect, it } from "vitest";
import { DESIGN_CRITERIA } from "narrarium-engine";
import {
  ALTERNATIVES_MAX,
  ALTERNATIVES_MIN,
  DEFAULT_WORKFLOW_FORM,
  alternativesViewOf,
  chapterReviewCounts,
  criterionRows,
  findingsViewOf,
  readWorkflowForm,
  readerNameOf,
  reviewBlockOf,
  reviewRequest,
  rubricViewOf,
  serverHasDesignReview,
  workflowFormOf,
} from "@/outline/designReviewModel";
import { AT, FLAT, WITH_WEAK, finding, pitch, stateOf, subject } from "./helpers/designReviewFixtures";

describe("the form of the workflow of a design", () => {
  it("offers every review and three pitches, the director choosing, to a design that had none", () => {
    expect(workflowFormOf(undefined)).toEqual(DEFAULT_WORKFLOW_FORM);
    expect(workflowFormOf({})).toEqual(DEFAULT_WORKFLOW_FORM);
    expect(DEFAULT_WORKFLOW_FORM).toMatchObject({ alternatives: true, alternativeCount: "3", pitchChoice: "director", chapterReview: true, coherence: true, rubric: true });
  });

  it("offers again what the design before it did", () => {
    expect(workflowFormOf({ workflow: { rubric: true, alternatives: 5, pitchChoice: "author" } })).toEqual({ alternatives: true, alternativeCount: "5", pitchChoice: "author", chapterReview: false, coherence: false, rubric: true });
    expect(workflowFormOf({ workflow: { chapterReview: true } })).toMatchObject({ alternatives: false, chapterReview: true, coherence: false, rubric: false });
  });

  it("sends what the form asks, and only that", () => {
    expect(readWorkflowForm(DEFAULT_WORKFLOW_FORM, { supported: true, alternativesAllowed: true })).toEqual({ workflow: { rubric: true, chapterReview: true, coherence: true, alternatives: 3 }, problem: null });
    expect(readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, alternatives: false, coherence: false }, { supported: true, alternativesAllowed: true }).workflow).toEqual({ rubric: true, chapterReview: true });
    expect(readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, pitchChoice: "author", alternativeCount: " 4 " }, { supported: true, alternativesAllowed: true }).workflow).toEqual({ rubric: true, chapterReview: true, coherence: true, alternatives: 4, pitchChoice: "author" });
    expect(readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, rubric: false, chapterReview: false, coherence: false, alternatives: false }, { supported: true, alternativesAllowed: true })).toEqual({ workflow: {}, problem: null });
  });

  it("asks for the alternatives only before the concept is made", () => {
    const form = { ...DEFAULT_WORKFLOW_FORM, pitchChoice: "author" as const };
    expect(readWorkflowForm(form, { supported: true, alternativesAllowed: false })).toEqual({ workflow: { rubric: true, chapterReview: true, coherence: true }, problem: null });
  });

  it("refuses a count of pitches the engine would refuse, and sends no workflow then", () => {
    expect([ALTERNATIVES_MIN, ALTERNATIVES_MAX]).toEqual([2, 6]);
    for (const typed of ["1", "7", "", "  ", "two", "2.5", "-3"]) {
      const reading = readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, alternativeCount: typed }, { supported: true, alternativesAllowed: true });
      expect(reading.problem, typed).toBe("alternatives");
      expect(reading.workflow?.alternatives, typed).toBeUndefined();
    }
    for (const typed of ["2", "6"]) expect(readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, alternativeCount: typed }, { supported: true, alternativesAllowed: true }).problem).toBeNull();
    // A count that is typed while the alternatives are off is not a problem: it is not used.
    expect(readWorkflowForm({ ...DEFAULT_WORKFLOW_FORM, alternatives: false, alternativeCount: "x" }, { supported: true, alternativesAllowed: true }).problem).toBeNull();
  });

  it("sends nothing to a personal server that predates the reviews: the design is the plain one", () => {
    expect(readWorkflowForm(DEFAULT_WORKFLOW_FORM, { supported: false, alternativesAllowed: true })).toEqual({ workflow: undefined, problem: null });
    expect(serverHasDesignReview({ features: [] })).toBe(false);
    expect(serverHasDesignReview({ features: ["autopilot-design-review"] })).toBe(true);
    expect(serverHasDesignReview(null)).toBe(false);
  });
});

describe("the alternatives", () => {
  const alternatives = {
    pitches: [pitch("p1", "The Glass Tide"), pitch("p2", "The Salt Ledger"), pitch("p3", "Nobody Sleeps Here")],
    evaluations: {
      p1: [{ by: "director", name: "Marta Vela", overall: 7.4, scores: FLAT(7.4), note: "Strong premise." }, { by: "ada", name: "Ada", overall: 8, scores: FLAT(8), note: "I kept reading." }, { by: "bo", name: "Bo", overall: 6, scores: FLAT(6), note: "Slow middle." }],
      p2: [{ by: "director", name: "Marta Vela", overall: 8.1, scores: FLAT(8.1), note: "The one." }],
    },
    recommended: { id: "p2", reason: "It has the sharpest stakes." },
  };

  it("is nothing for a design that proposed none", () => {
    expect(alternativesViewOf(null)).toBeNull();
    expect(alternativesViewOf(stateOf())).toBeNull();
    expect(alternativesViewOf(stateOf({ alternatives: { pitches: [], evaluations: {} } }))).toBeNull();
  });

  it("shows every pitch with the director's judgement and the readers' mean, and marks the recommended one", () => {
    const view = alternativesViewOf(stateOf({ alternatives }, (state) => { state.concept = { done: false, generated: false, secrets: [] }; }));
    expect(view?.pitches.map((entry) => entry.pitch.id)).toEqual(["p1", "p2", "p3"]);
    expect(view?.pitches[0]).toMatchObject({ director: { overall: 7.4 }, readersMean: 7, chosen: false, recommended: false });
    expect(view?.pitches[0].readers.map((reader) => reader.name)).toEqual(["Ada", "Bo"]);
    expect(view?.pitches[1]).toMatchObject({ director: { overall: 8.1 }, readers: [], readersMean: null, recommended: true });
    expect(view?.pitches[2]).toMatchObject({ director: null, readers: [], readersMean: null });
  });

  it("waits for the author when the director recommended and nobody chose, until the concept is made", () => {
    const open = stateOf({ alternatives }, (state) => { state.concept = { done: false, generated: false, secrets: [] }; });
    expect(alternativesViewOf(open)).toMatchObject({ waiting: true, choosable: true, selected: null, recommended: { id: "p2" } });
    const chosen = stateOf({ alternatives: { ...alternatives, selected: { id: "p1", by: "author", reason: "Her pick.", at: AT } } }, (state) => { state.concept = { done: false, generated: false, secrets: [] }; });
    expect(alternativesViewOf(chosen)).toMatchObject({ waiting: false, choosable: true });
    expect(alternativesViewOf(chosen)?.pitches.map((entry) => entry.chosen)).toEqual([true, false, false]);
    // The concept is made of the chosen pitch: it cannot be chosen again.
    const locked = stateOf({ alternatives: { ...alternatives, selected: { id: "p1", by: "director", reason: "Best.", at: AT } } }, (state) => { state.concept = { done: true, generated: true, secrets: [] }; });
    expect(alternativesViewOf(locked)).toMatchObject({ waiting: false, choosable: false, selected: { by: "director" } });
  });
});

describe("the rubric", () => {
  it("is nothing while nothing was judged", () => {
    expect(rubricViewOf(null)).toBeNull();
    expect(rubricViewOf(stateOf())).toBeNull();
    expect(rubricViewOf(stateOf({ rubric: {} }))).toBeNull();
    expect(rubricViewOf(stateOf({ rubric: { "bad-key": subject([FLAT(8)]) } }))).toBeNull();
  });

  it("groups the subjects: the design, the readers, the chapters in order and the pitches", () => {
    const view = rubricViewOf(stateOf({
      rubric: {
        "chapter:10": subject([FLAT(8)]),
        "chapter:2": subject([FLAT(7)]),
        "reader:bo": subject([FLAT(6)]),
        "reader:ada": subject([FLAT(9)]),
        design: subject([FLAT(5), FLAT(7)]),
        "pitch:p2": subject([FLAT(8)]),
        "pitch:p1": subject([FLAT(7)]),
      },
    }));
    expect(view?.design?.key).toBe("design");
    expect(view?.readers.map((entry) => entry.id)).toEqual(["ada", "bo"]);
    expect(view?.chapters.map((entry) => entry.chapter)).toEqual([2, 10]);
    expect(view?.pitches.map((entry) => entry.id)).toEqual(["p1", "p2"]);
  });

  it("says how a subject went: its overall, the one before, and how much it moved since the first review", () => {
    const view = rubricViewOf(stateOf({ rubric: { design: subject([FLAT(5), FLAT(6.5), FLAT(7.8)]), "chapter:1": subject([FLAT(8)]) } }));
    expect(view?.design).toMatchObject({ overall: 7.8, previous: 6.5, trend: 2.8 });
    expect(view?.design?.history.map((entry) => [entry.round, entry.overall])).toEqual([[1, 5], [2, 6.5], [3, 7.8]]);
    expect(view?.chapters[0]).toMatchObject({ overall: 8, previous: null, trend: null });
  });

  it("lists the weak criteria, worst first, and keeps the whole criteria for every subject but a chapter", () => {
    const view = rubricViewOf(stateOf({ rubric: { design: subject([WITH_WEAK(8, { 2: 4.5, 9: 6 })]), "chapter:3": subject([WITH_WEAK(8, { 4: 5 })]) } }));
    expect(view?.design?.weak.map((entry) => [entry.criterion, entry.score])).toEqual([["coherence", 4.5], ["credibility", 6]]);
    expect(view?.design?.criteria).toHaveLength(DESIGN_CRITERIA.length);
    expect(view?.chapters[0].weak.map((entry) => entry.criterion)).toEqual(["tension"]);
    expect(view?.chapters[0].criteria).toBeNull();
  });

  it("turns the twelve scores into the rows of a table, in the order of the criteria, with the ones that do not apply", () => {
    const rows = criterionRows([8, 6.9, null, 7]);
    expect(rows).toHaveLength(DESIGN_CRITERIA.length);
    expect(rows.slice(0, 4).map((row) => [row.criterion, row.score, row.weak])).toEqual([["originality", 8, false], ["engagement", 6.9, true], ["coherence", null, false], ["pace", 7, false]]);
    expect(rows[11]).toMatchObject({ criterion: "ending", score: null, weak: false });
  });

  it("counts the chapters that were reviewed and the ones that said revise", () => {
    expect(chapterReviewCounts(undefined)).toEqual({ reviewed: 0, weak: 0 });
    const review = (overall: number | null, verdict: "ok" | "revise") => ({ sig: "x", round: 1, at: AT, overall, verdict, summary: "" });
    expect(chapterReviewCounts({ reviewed: { "1": review(8, "ok"), "2": review(5, "revise"), "3": review(null, "ok"), "4": review(6, "revise") } })).toEqual({ reviewed: 3, weak: 2 });
  });

  it("names a reader as the plan does, else by its slug", () => {
    const state = stateOf({}, (draft) => { draft.plan = { chapters: [], readerReactions: [{ slug: "ada", name: "Ada Quill" }] } as never; });
    expect(readerNameOf(state, "ada")).toBe("Ada Quill");
    expect(readerNameOf(state, "bo")).toBe("bo");
    expect(readerNameOf(null, "bo")).toBe("bo");
  });
});

describe("the findings", () => {
  const findings = [
    finding({ id: "a-minor", text: "A minor one.", severity: "minor", chapters: [5] }),
    finding({ id: "a-major", text: "A major one.", severity: "major", chapters: [3, 4] }),
    finding({ id: "c-critical", text: "A critical one.", severity: "critical", chapters: [2], source: "check" }),
    finding({ id: "a-fixing", text: "Being fixed.", status: "fixing" }),
    finding({ id: "a-mine", text: "Taken.", status: "mine", decision: { by: "author", at: AT } }),
    finding({ id: "a-no", text: "Not a problem.", status: "dismissed", decision: { by: "director", reason: "It is deliberate.", at: AT } }),
    finding({ id: "a-fixed", text: "Fixed.", status: "fixed" }),
    finding({ id: "a-hers", text: "Hers.", owner: "author", severity: "major", chapters: [1] }),
  ];

  it("is nothing when the structure was never analysed", () => {
    expect(findingsViewOf(null)).toBeNull();
    expect(findingsViewOf(stateOf())).toBeNull();
  });

  it("puts every finding where its status says, the critical first and then by chapter", () => {
    const view = findingsViewOf(stateOf({ coherence: { sig: "x", round: 2, at: AT, summary: "It mostly holds.", findings } }));
    expect(view?.open.map((entry) => entry.finding.id)).toEqual(["c-critical", "a-hers", "a-major", "a-minor"]);
    expect(view?.fixing.map((entry) => entry.finding.id)).toEqual(["a-fixing"]);
    expect(view?.mine.map((entry) => entry.finding.id)).toEqual(["a-mine"]);
    expect(view?.dismissed.map((entry) => entry.finding.id)).toEqual(["a-no"]);
    expect(view?.fixed.map((entry) => entry.finding.id)).toEqual(["a-fixed"]);
    expect(view?.counts).toEqual({ critical: 1, major: 2, minor: 1 });
    expect(view).toMatchObject({ analysedAt: AT, summary: "It mostly holds." });
  });

  it("offers each finding what the author can do about it", () => {
    const view = findingsViewOf(stateOf({ coherence: { sig: "x", round: 2, at: AT, summary: "", findings } }));
    const by = (id: string) => [...view!.open, ...view!.fixing, ...view!.mine, ...view!.dismissed, ...view!.fixed].find((entry) => entry.finding.id === id)!;
    expect(by("a-major")).toMatchObject({ canFix: true, canTake: true, canDismiss: true, canReopen: false });
    // What only her entries can answer is hers: the autopilot proposes, so it cannot be asked to fix it.
    expect(by("a-hers")).toMatchObject({ canFix: false, canTake: true, canDismiss: true });
    expect(by("a-fixing")).toMatchObject({ canFix: false, canTake: true, canDismiss: true, canReopen: true });
    expect(by("a-mine")).toMatchObject({ canFix: true, canTake: false, canDismiss: true, canReopen: true });
    expect(by("a-no")).toMatchObject({ canFix: true, canTake: true, canDismiss: false, canReopen: true });
    expect(by("a-fixed")).toMatchObject({ canFix: false, canTake: false, canDismiss: false, canReopen: false });
  });

  it("says that the structure holds when the analysis found nothing", () => {
    const view = findingsViewOf(stateOf({ coherence: { sig: "x", round: 1, at: AT, summary: "", findings: [] } }));
    expect(view).toMatchObject({ open: [], counts: { critical: 0, major: 0, minor: 0 } });
  });
});

describe("what can be asked of the reviews now", () => {
  const free = { chapters: 3, running: false, designing: false, serverWithoutReview: false };

  it("allows a review of a book that has chapters, while nothing runs", () => {
    expect(reviewBlockOf(free)).toBeNull();
  });

  it("says why not, the personal server first, then what the book lacks, then what holds it", () => {
    expect(reviewBlockOf({ ...free, serverWithoutReview: true, chapters: 0, running: true })).toBe("server");
    expect(reviewBlockOf({ ...free, chapters: 0, running: true })).toBe("chapters");
    expect(reviewBlockOf({ ...free, designing: true, running: true })).toBe("designing");
    expect(reviewBlockOf({ ...free, running: true })).toBe("running");
  });

  it("asks for the whole design with an empty request, and for chapters in order", () => {
    expect(reviewRequest()).toEqual({ reviewOnly: {} });
    expect(reviewRequest([])).toEqual({ reviewOnly: {} });
    expect(reviewRequest([4, 2])).toEqual({ reviewOnly: { chapters: [2, 4] } });
  });
});
