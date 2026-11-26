import { describe, expect, it } from "vitest";
import { createAutopilotState, outlineChapterPath, parseOutlineJournal, serializeOutlineChapter, sha256Hex, type AutopilotState, type OutlineJournal, type OutlineJournalSeries, type PlannedChapter } from "narrarium-engine";
import { snapshotOf } from "@/outline/outlineModel";
import { whatChanged } from "@/outline/whatChanged";

// «What changed» on the Synopsis page: what the autopilot has not followed yet, from the digests its plan keeps (never from the journal), told with the journal
// (who, when, how), and what else changed since the author's «reviewed» or the autopilot's last work.

async function entries(list: Array<[number, string, string]>) {
  const files = await Promise.all(list.map(async ([number, title, body]) => {
    const content = serializeOutlineChapter({ number, title, body, origin: "author" });
    return { path: outlineChapterPath(number), content, hash: await sha256Hex(content) };
  }));
  return (await snapshotOf(files)).outline.chapters;
}

const planned = (number: number, extra: Partial<PlannedChapter> = {}) => ({ number, title: `Chapter ${number}`, slug: `${String(number).padStart(3, "0")}-chapter`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "done", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], revisions: 0, status: "reviewed" }], ...extra }) as PlannedChapter;

function stateWith(chapters: PlannedChapter[], options: Partial<AutopilotState["options"]> = {}, approved = true): AutopilotState {
  const state = createAutopilotState(new Date("2026-11-20T00:00:00.000Z"), { idea: "Glass" });
  state.plan = { chapters, approved, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  state.options = { ...state.options, ...options };
  state.updatedAt = "2026-11-20T12:00:00.000Z";
  return state;
}

const series = (id: string, at: string, by: OutlineJournalSeries["by"], chapters: OutlineJournalSeries["chapters"]): OutlineJournalSeries => ({ id, at, by, chapters });
const journalOf = (...list: OutlineJournalSeries[]): OutlineJournal => ({ series: list });

describe("what the autopilot has not followed yet", () => {
  it("lists the chapters whose entry is not the one the plan keeps, with what the autopilot will do as its setting says, told with the journal", async () => {
    const before = await entries([[1, "Dawn", "Mira wakes."], [2, "Key", "Mira finds the key."], [3, "Vault", "The vault opens."], [4, "Sea", "The sea rises."]]);
    const now = await entries([[1, "Dawn", "Mira wakes at night."], [2, "Key", "Mira finds the key."], [3, "Sea", "The sea rises."], [4, "Vault", "The vault opens."], [5, "Return", "Mira returns."]]);
    const digest = (list: typeof now, number: number) => list.find((entry) => entry.number === number)!.contentDigest;
    const state = stateWith([1, 2, 3, 4].map((number) => planned(number, { outlineDigest: digest(before, number) })), { frozenEdits: "ask" });
    const journal = journalOf(
      series("fill", "2026-11-19T00:00:00.000Z", "autopilot", [1, 2, 3, 4].map((chapter) => ({ chapter, change: "created", after: digest(before, chapter), summary: "" }))),
      series("s1", "2026-11-21T10:00:00.000Z", "brainstorming", [
        { chapter: 1, change: "modified", title: "Dawn", before: digest(before, 1), after: digest(now, 1), summary: "" },
        { chapter: 3, change: "moved", from: 4, title: "Sea", was: "Vault", before: digest(before, 3), after: digest(now, 3), summary: "" },
        { chapter: 4, change: "moved", from: 3, title: "Vault", was: "Sea", before: digest(before, 4), after: digest(now, 4), summary: "" },
        { chapter: 5, change: "created", title: "Return", after: digest(now, 5), summary: "" },
      ]),
    );
    const view = whatChanged({ entries: now, journal, state, written: new Set([1, 2, 3, 4]) });
    expect(view.mode).toBe("plan");
    expect(view.since).toEqual({ kind: "autopilot", at: "2026-11-20T12:00:00.000Z" });
    expect(view.rows.map((row) => [row.number, row.change, row.from ?? null, row.by, row.outcome, row.pending, row.series])).toEqual([
      [1, "modified", null, "brainstorming", "ask", true, 1],
      [3, "moved", 4, "brainstorming", "ask", true, 1],
      [4, "moved", 3, "brainstorming", "ask", true, 1],
      [5, "created", null, "brainstorming", "extends", true, 1],
    ]);
    expect(view.rows[0]).toMatchObject({ title: "Dawn", at: "2026-11-21T10:00:00.000Z", written: true, approved: true, digest: digest(now, 1), fresh: true });
    expect(view.unreviewed).toBe(true);
    // The setting of the autopilot says what it does; a chapter the author wrote is never rewritten for its own decision.
    const auto = whatChanged({ entries: now, journal, state: stateWith([planned(1, { outlineDigest: digest(before, 1) }), planned(3, { outlineDigest: digest(before, 3), imported: true })], { frozenEdits: "auto" }), written: new Set([1, 3]) });
    expect(auto.rows.filter((row) => row.pending && row.outcome !== "extends").map((row) => [row.number, row.outcome, row.imported])).toEqual([[1, "auto", false], [3, "notify", true]]);
  });

  it("says a chapter not written yet is planned again, one that lost its entry leaves the plan or stays, and a chapter the autopilot is writing is decided once closed", async () => {
    const now = await entries([[1, "One", "Changed."], [2, "Two", "Changed."], [4, "Four", "Changed."]]);
    const state = stateWith([
      planned(1, { outlineDigest: "0000000000000001", status: "planned", scenes: [] }),
      planned(2, { outlineDigest: "0000000000000002", status: "writing", scenes: [{ number: 1, title: "S", goal: "", beats: [], characters: [], revisions: 0, status: "written" }] }),
      planned(3, { outlineDigest: "0000000000000003" }),
      planned(4, { outlineDigest: now[2].contentDigest }),
      planned(5, { outlineDigest: "0000000000000005", status: "planned", scenes: [] }),
    ]);
    const view = whatChanged({ entries: now, journal: journalOf(), state, written: new Set([2, 3]) });
    expect(view.rows.map((row) => [row.number, row.change, row.outcome, row.by ?? null])).toEqual([
      [1, "changed", "replan", null],
      [2, "changed", "later", null],
      [3, "removed", "stays", null],
      [5, "removed", "unplan", null],
    ]);
    // Deleting the whole Synopsis is not deleting every chapter.
    expect(whatChanged({ entries: [], journal: journalOf(), state, written: new Set([2, 3]) }).rows).toEqual([]);
  });

  it("tells who and when only when the journal knows the last change: an entry changed outside the app is only said to have changed", async () => {
    const before = await entries([[1, "Dawn", "Mira wakes."]]);
    const middle = await entries([[1, "Dawn", "Mira wakes late."]]);
    const now = await entries([[1, "Dawn", "Mira wakes at noon."]]);
    const state = stateWith([planned(1, { outlineDigest: before[0].contentDigest })]);
    const journal = journalOf(series("a", "2026-11-21T00:00:00.000Z", "author", [{ chapter: 1, change: "modified", before: before[0].contentDigest, after: middle[0].contentDigest, summary: "" }]));
    expect(whatChanged({ entries: middle, journal, state, written: new Set([1]) }).rows[0]).toMatchObject({ change: "modified", by: "author", series: 1 });
    const outside = whatChanged({ entries: now, journal, state, written: new Set([1]) }).rows[0];
    expect(outside).toMatchObject({ change: "changed", series: 0, outcome: "ask", pending: true });
    expect(outside.by).toBeUndefined();
    // Two changes since the entry the autopilot follows: the last one is told, with how many came before it; the series that made the followed entry is not one.
    const twice = journalOf(
      series("fill", "2026-11-19T00:00:00.000Z", "autopilot", [{ chapter: 1, change: "created", after: before[0].contentDigest, summary: "" }]),
      series("a", "2026-11-21T00:00:00.000Z", "author", [{ chapter: 1, change: "modified", before: before[0].contentDigest, after: middle[0].contentDigest, summary: "" }]),
      series("b", "2026-11-22T00:00:00.000Z", "mcp", [{ chapter: 1, change: "modified", before: middle[0].contentDigest, after: now[0].contentDigest, summary: "" }]),
    );
    expect(whatChanged({ entries: now, journal: twice, state, written: new Set([1]) }).rows[0]).toMatchObject({ change: "modified", by: "mcp", at: "2026-11-22T00:00:00.000Z", series: 2 });
  });
});

describe("since when", () => {
  it("lists what else changed since the author marked the changes as reviewed, else since the autopilot last worked, and keeps what is not followed yet", async () => {
    const now = await entries([[1, "One", "Same."], [2, "Two", "New text."]]);
    const state = stateWith([planned(1, { outlineDigest: now[0].contentDigest }), planned(2, { outlineDigest: "0000000000000002" })]);
    const journal = journalOf(
      series("old", "2026-11-18T00:00:00.000Z", "author", [{ chapter: 1, change: "modified", after: now[0].contentDigest, summary: "" }]),
      series("undone", "2026-11-21T00:00:00.000Z", "author", [{ chapter: 1, change: "modified", after: "1111111111111111", summary: "" }]),
      series("back", "2026-11-21T01:00:00.000Z", "author", [{ chapter: 1, change: "modified", after: now[0].contentDigest, summary: "" }, { chapter: 2, change: "modified", after: now[1].contentDigest, summary: "" }]),
    );
    const sinceWork = whatChanged({ entries: now, journal, state, written: new Set([1, 2]) });
    expect(sinceWork.rows.map((row) => [row.number, row.outcome, row.pending, row.series])).toEqual([[1, "followed", false, 2], [2, "ask", true, 1]]);
    const reviewed = whatChanged({ entries: now, journal: { ...journal, reviewedAt: "2026-11-21T02:00:00.000Z" }, state, written: new Set([1, 2]) });
    expect(reviewed.since).toEqual({ kind: "review", at: "2026-11-21T02:00:00.000Z" });
    expect(reviewed.unreviewed).toBe(false);
    expect(reviewed.rows.map((row) => [row.number, row.pending, row.fresh])).toEqual([[2, true, false]]);
    const older = whatChanged({ entries: now, journal: { ...journal, reviewedAt: "2026-11-17T00:00:00.000Z" }, state, written: new Set([1, 2]) });
    expect(older.rows.map((row) => [row.number, row.outcome, row.fresh])).toEqual([[1, "followed", true], [2, "ask", true]]);
  });
});

describe("a book without an approved plan", () => {
  it("tells only the journal, and that the autopilot follows the Synopsis when it plans the book", async () => {
    const now = await entries([[1, "One", "A."], [2, "Two", "B."]]);
    const journal = parseOutlineJournal([
      "version: 1",
      "series:",
      "  - id: s1",
      "    at: 2026-11-21T00:00:00.000Z",
      "    by: brainstorming",
      "    chapters:",
      `      - { chapter: 1, change: created, title: One, after: ${now[0].contentDigest}, summary: x }`,
      `      - { chapter: 3, change: removed, title: Three, before: 0000000000000003, summary: x }`,
    ].join("\n"));
    const none = whatChanged({ entries: now, journal, state: null, written: new Set() });
    expect(none).toMatchObject({ mode: "journal", since: { kind: "always" }, unreviewed: true });
    expect(none.rows.map((row) => [row.number, row.change, row.outcome, row.title, row.by])).toEqual([[1, "created", "no-plan", "One", "brainstorming"], [3, "removed", "no-plan", "Three", "brainstorming"]]);
    const planning = whatChanged({ entries: now, journal, state: stateWith([planned(1, { outlineDigest: "0000000000000001" })], {}, false), written: new Set() });
    expect(planning.mode).toBe("journal");
    expect(planning.rows.every((row) => row.outcome === "no-plan" && !row.pending)).toBe(true);
    expect(whatChanged({ entries: now, journal: { series: [] }, state: null, written: new Set() }).rows).toEqual([]);
  });
});
