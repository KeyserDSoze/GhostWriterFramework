import { describe, expect, it } from "vitest";
import { createAutopilotState, outlineChapterPath, serializeOutlineChapter, sha256Hex, type AutopilotState, type ChapterFreeze, type PlannedChapter } from "narrarium-engine";
import { estimateRest, type EstimateSources } from "@/autopilot/runEstimate";
import { applyModel, initialChoice, isDecidable, restEstimateState, reviseInput, rewriteEstimateState, toRewrite, type ApplyChoice } from "@/outline/applyModel";
import { snapshotOf } from "@/outline/outlineModel";
import { whatChanged } from "@/outline/whatChanged";

// «Apply to the book»: which chapters the author decides about, what each starts with, the campaign the choices make, the chapters confirmed before anything is
// rewritten, and the states the estimate is made on.

async function entries(list: Array<[number, string, string]>) {
  const files = await Promise.all(list.map(async ([number, title, body]) => {
    const content = serializeOutlineChapter({ number, title, body, origin: "author" });
    return { path: outlineChapterPath(number), content, hash: await sha256Hex(content) };
  }));
  return (await snapshotOf(files)).outline.chapters;
}

const scene = (status: "planned" | "written" | "reviewed" = "reviewed") => ({ number: 1, title: "S", goal: "", beats: [], characters: [], revisions: 0, status });
const planned = (number: number, extra: Partial<PlannedChapter> = {}) => ({ number, title: `Chapter ${number}`, slug: `00${number}-chapter-${number}`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [scene()], ...extra }) as PlannedChapter;

function stateWith(chapters: PlannedChapter[], extra: Partial<AutopilotState> = {}): AutopilotState {
  const state = createAutopilotState(new Date("2026-11-20T00:00:00.000Z"), { idea: "Glass" });
  state.plan = { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  return { ...state, ...extra };
}

const freeze = (by: ChapterFreeze["by"]): ChapterFreeze => ({ at: "2026-11-20T00:00:00.000Z", by, digest: "0123456789abcdef", files: {} });

/** A finished book of five chapters whose entries all changed: 1 and 2 the autopilot wrote, 3 the author wrote before it, 4 the author froze by hand, 5 is being written. */
async function book(extra: Partial<AutopilotState> = {}) {
  const now = await entries([1, 2, 3, 4, 5].map((number) => [number, `T${number}`, `New ${number}.`] as [number, string, string]));
  const state = stateWith([
    planned(1, { outlineDigest: "0000000000000001" }),
    planned(2, { outlineDigest: "0000000000000002" }),
    planned(3, { outlineDigest: "0000000000000003", imported: true }),
    planned(4, { outlineDigest: "0000000000000004" }),
    planned(5, { outlineDigest: "0000000000000005", status: "writing", scenes: [scene("written")] }),
  ], extra);
  const view = whatChanged({ entries: now, journal: { series: [] }, state, written: new Set([1, 2, 3, 4, 5]) });
  return { now, state, view };
}

describe("the chapters of «Apply to the book»", () => {
  it("decides about the written chapters the setting would ask about, rewrite or only report, and tells the others", async () => {
    const { view } = await book();
    const model = applyModel(view, new Map([[1, freeze("autopilot")], [2, freeze("autopilot")], [4, freeze("author")]]));
    expect(model.decide.map((row) => [row.row.number, row.outcome, row.frozenBy, row.initial])).toEqual([
      [1, "ask", "autopilot", "follow"],
      [2, "ask", "autopilot", "follow"],
      [3, "ask", null, "later"],
      [4, "ask", "author", "later"],
    ]);
    expect(model.told.map((row) => [row.number, row.outcome]), "the chapter being written is decided once it is closed").toEqual([[5, "later"]]);
    expect(model.decide.map((row) => row.authorWritten)).toEqual([false, false, true, false]);
  });

  it("tells a chapter the autopilot approved from one the author wrote by the record of its freeze, when a plan made again counts both as imported", async () => {
    const now = await entries([[1, "T1", "New 1."], [2, "T2", "New 2."]]);
    const state = stateWith([planned(1, { outlineDigest: "0000000000000001", imported: true }), planned(2, { outlineDigest: "0000000000000002", imported: true })]);
    const view = whatChanged({ entries: now, journal: { series: [] }, state, written: new Set([1, 2]) });
    const model = applyModel(view, new Map([[1, freeze("autopilot")], [2, null]]));
    expect(model.decide.map((row) => [row.row.number, row.initial, row.authorWritten])).toEqual([[1, "follow", false], [2, "later", true]]);
  });

  it("starts from what the author decided already: left for later, or a decision recorded for the next run", async () => {
    const first = await book();
    const digest = first.view.rows.find((row) => row.number === 2)!.digest!;
    const { view } = await book({
      deferredChanges: [{ kind: "outline", number: 2, fingerprint: digest, at: "2026-11-21T00:00:00.000Z" }],
      pendingReviews: [{ id: "r1", kind: "outline", number: 1, fingerprint: "x", action: "keep-text", at: "2026-11-21T00:00:00.000Z" }],
    });
    const rows = new Map(view.rows.map((row) => [row.number, row]));
    expect([rows.get(1)!.held, rows.get(1)!.decision, rows.get(2)!.held]).toEqual(["decided", "keep-text", "deferred"]);
    expect([initialChoice(rows.get(1)!, "autopilot"), initialChoice(rows.get(2)!, "autopilot")]).toEqual(["keep", "later"]);
    expect([isDecidable(rows.get(1)!), isDecidable(rows.get(2)!)]).toEqual([true, true]);
    // A deferral of another version of the entry is not this change.
    const other = await book({ deferredChanges: [{ kind: "outline", number: 2, fingerprint: "ffffffffffffffff", at: "2026-11-21T00:00:00.000Z" }] });
    expect(other.view.rows.find((row) => row.number === 2)!.held).toBeUndefined();
  });

  it("tells the chapters a campaign holds, the one rewritten now included, and decides nothing about them", async () => {
    const first = await book();
    const digestOf = (number: number) => first.view.rows.find((row) => row.number === number)!.digest!;
    const state = stateWith([
      planned(1, { outlineDigest: digestOf(1) }),
      planned(2, { outlineDigest: "0000000000000002" }),
      planned(3, { outlineDigest: "0000000000000003" }),
    ], { campaign: { id: "c", reason: "outline-change", createdAt: "2026-11-21T00:00:00.000Z", chapters: [{ number: 1, mode: "follow", status: "working" }, { number: 2, mode: "follow", status: "waiting" }, { number: 3, mode: "keep", status: "waiting" }] } });
    const view = whatChanged({ entries: first.now, journal: { series: [] }, state, written: new Set([1, 2, 3]) });
    const rows = view.rows.filter((row) => row.number <= 3);
    expect(rows.map((row) => [row.number, row.held])).toEqual([[1, "rewriting"], [2, "applying"], [3, "keeping"]]);
    expect(rows.some(isDecidable)).toBe(false);
  });
});

describe("the campaign the choices make", () => {
  it("names every chapter decided about with the change the author saw, the author's words for all and for the chapters rewritten", async () => {
    const { view } = await book();
    const model = applyModel(view, new Map([[4, freeze("author")]]));
    const choices = new Map<number, ApplyChoice>([[2, "keep"], [4, "follow"]]);
    const input = reviseInput(model.decide, choices, { note: "  The vault comes first.  ", instructions: new Map([[1, "Mira arrives at night."], [2, "ignored: kept"]]) });
    expect(input).toEqual({
      reason: "outline-change",
      note: "The vault comes first.",
      chapters: [
        { number: 1, mode: "follow", fingerprint: model.decide[0].row.digest, instruction: "Mira arrives at night." },
        { number: 2, mode: "keep", fingerprint: model.decide[1].row.digest },
        { number: 3, mode: "later", fingerprint: model.decide[2].row.digest },
        { number: 4, mode: "follow", fingerprint: model.decide[3].row.digest },
      ],
    });
    expect(toRewrite(model.decide, choices).map((row) => row.row.number), "what the author confirms before anything is rewritten").toEqual([1, 4]);
    expect(reviseInput(model.decide, new Map(), { note: "   " }).note).toBeUndefined();
  });
});

describe("what the estimate is made on", () => {
  const sources = (state: AutopilotState, lastChapter: number): EstimateSources => ({
    book: { read: true, directorFile: false, context: {}, designWritten: true, outline: { entries: lastChapter, lastChapter, words: lastChapter * 40 } },
    ai: null,
    aiFrom: "browser",
    activities: [],
    state,
    chapters: null,
    canonEntries: 0,
  });

  it("counts the chosen chapters as chapters to write anew, without readers and without the judgement of the book, and the rest of the plan apart", async () => {
    const state = stateWith([1, 2, 3, 4].map((number) => planned(number)), { finalDone: true, options: { ...createAutopilotState(new Date()).options, readers: true } });
    const rewrite = rewriteEstimateState(state, new Set([1, 3]));
    expect(rewrite.plan!.chapters.map((chapter) => chapter.status)).toEqual(["planned", "done", "planned", "done"]);
    expect([rewrite.options.readers, rewrite.options.readersOnPlan, rewrite.finalDone]).toEqual([false, false, true]);
    const chosen = estimateRest(sources(state, 4), rewrite).estimate;
    expect(chosen.chaptersToWrite).toBe(2);
    expect(chosen.capabilities["reader-evaluation"].calls.max, "a rewrite is reviewed without the simulated readers").toBe(0);
    // The rest: chapter 5, added at the end of the Synopsis, and the book judged again.
    const rest = estimateRest(sources(state, 5), restEstimateState(state, true)).estimate;
    expect(rest.chaptersToWrite).toBe(1);
    expect(restEstimateState(state, false).finalDone).toBe(true);
  });
});
