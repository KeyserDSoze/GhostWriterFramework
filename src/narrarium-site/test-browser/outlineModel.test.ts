import { describe, expect, it } from "vitest";
import { composeOutlineEdits, createAutopilotState, outlineChapterPath, outlineEntryDigest, parseOutline, remapOutlineNumber, serializeOutlineBook, serializeOutlineChapter, sha256Hex, type OutlineEdit, type PlannedChapter } from "narrarium-engine";
import { applyToSnapshot, composeOptions, composerSource, convertSynopsis, entryStatus, filterEntries, missingNumbers, snapshotOf, warningsByPath, writtenChapters, type OutlineFile, type OutlineSnapshot } from "@/outline/outlineModel";

async function file(path: string, content: string): Promise<OutlineFile> {
  return { path, content, hash: await sha256Hex(content) };
}

async function autopilotEntry(number: number, title: string, body: string, ghostwriter?: string): Promise<OutlineFile> {
  const digest = await outlineEntryDigest({ title, body, ghostwriter });
  return file(outlineChapterPath(number), serializeOutlineChapter({ number, title, body, ghostwriter, origin: "autopilot", digest }));
}

async function authorEntry(number: number, title: string, body: string, ghostwriter?: string): Promise<OutlineFile> {
  return file(outlineChapterPath(number), serializeOutlineChapter({ number, title, body, ghostwriter, origin: "author" }));
}

const planned = (number: number, extra: Partial<PlannedChapter> = {}) => ({ number, title: `Chapter ${number}`, slug: `${String(number).padStart(3, "0")}-chapter`, summary: "", goal: "", pov: [], keyEvents: [], reveals: [], status: "planned", scenes: [], ...extra }) as PlannedChapter;

/** The state of the autopilot as the page reads it, with this plan. */
function autopilotWith(...chapters: PlannedChapter[]) {
  const state = createAutopilotState(new Date("2026-11-21T00:00:00.000Z"), { idea: "Glass" });
  state.plan = { chapters, approved: true, rounds: 0, revisionNotes: [], readerReactions: [], readersDone: true, awaitingAuthor: false };
  return state;
}

/** Several edits as one commit, the way the page and the Copilot make them: the engine's composer on the files of a snapshot, and the outline once the commit is saved. */
async function compose(snapshot: OutlineSnapshot, edits: OutlineEdit[]) {
  const composed = await composeOutlineEdits(composerSource(snapshot), edits, composeOptions());
  return { ...composed, next: composed.changes.length ? await applyToSnapshot(snapshot, composed.changes) : snapshot };
}

describe("the status of an entry of the outline", () => {
  it("tells the autopilot's untouched entries from the author's, and says when the chapter is written or approved", async () => {
    const snapshot = await snapshotOf([
      await autopilotEntry(1, "The harbor", "Mira wakes."),
      await authorEntry(2, "The key", "Mira finds the key."),
      await autopilotEntry(3, "The wall", "The wall cracks."),
    ]);
    const [first, second, third] = snapshot.outline.chapters;
    const written = writtenChapters([{ slug: "001-the-harbor", title: "The harbor", paragraphs: [{}] }, { slug: "003-the-wall", title: "The wall", paragraphs: [] }]);
    const context = { autopilot: autopilotWith(planned(1, { status: "done", outlineDigest: first.contentDigest })), written, ghostwriters: new Set<string>(), warnings: warningsByPath(snapshot.outline.warnings) };
    expect(entryStatus(first, context)).toMatchObject({ origin: "autopilot", written: { slug: "001-the-harbor" }, approved: true, replan: false });
    expect(entryStatus(second, context)).toMatchObject({ origin: "author", written: null, approved: false });
    expect(entryStatus(third, context).written, "a chapter folder with no scene is not written").toBeNull();
  });

  it("says that a chapter planned from another version of its entry will be planned again, unless it is written", async () => {
    const snapshot = await snapshotOf([await authorEntry(4, "Changed", "The author rewrote it.")]);
    const [entry] = snapshot.outline.chapters;
    const context = (plan: PlannedChapter, written = new Map()) => ({ autopilot: autopilotWith(plan), written, ghostwriters: new Set<string>(), warnings: new Map() });
    expect(entryStatus(entry, context(planned(4, { outlineDigest: "0123456789abcdef" }))).replan).toBe(true);
    expect(entryStatus(entry, context(planned(4, { outlineDigest: entry.contentDigest }))).replan).toBe(false);
    expect(entryStatus(entry, context(planned(4, { outlineDigest: "0123456789abcdef", status: "done" }))).replan).toBe(false);
    expect(entryStatus(entry, context(planned(4, { outlineDigest: "0123456789abcdef" }), new Map([[4, { slug: "004-x", title: "X" }]]))).replan).toBe(false);
  });

  it("names a ghostwriter that the book does not have, and the problems of the file", async () => {
    const broken = await file(outlineChapterPath(6), "---\ntitle: [unclosed\n---\nText");
    const snapshot = await snapshotOf([await authorEntry(5, "Five", "x", "ghost"), broken]);
    const [five, six] = snapshot.outline.chapters;
    const context = { autopilot: null, written: new Map(), ghostwriters: new Set(["night-owl"]), warnings: warningsByPath(snapshot.outline.warnings) };
    expect(entryStatus(five, context).missingGhostwriter).toBe("ghost");
    expect(entryStatus(six, context).warnings.map((warning) => warning.code)).toContain("unreadable");
  });
});

describe("the chapters the outline leaves without an entry", () => {
  it("are said as runs of numbers", () => {
    expect(missingNumbers([1, 2, 5, 6, 9])).toEqual([[3, 4], [7, 8]]);
    expect(missingNumbers([2])).toEqual([[1, 1]]);
    expect(missingNumbers([1, 2, 3])).toEqual([]);
  });
});

describe("the filter of the entries", () => {
  it("finds an entry by its number, its title or what happens, without caring for case or accents", async () => {
    const snapshot = await snapshotOf([await authorEntry(1, "Il porto", "Mira si sveglia."), await authorEntry(12, "La città", "Il consiglio mente."), await authorEntry(120, "Fine", "Tutto crolla.")]);
    const numbers = (query: string) => filterEntries(snapshot.outline.chapters, query).map((entry) => entry.number);
    expect(numbers("12")).toEqual([12]);
    expect(numbers("CITTA")).toEqual([12]);
    expect(numbers("mira")).toEqual([1]);
    expect(numbers("  ")).toEqual([1, 12, 120]);
  });
});

describe("the numbers of the entries after an edit", () => {
  it("follow the edit the way the engine moves the files: the page keeps what the author typed in an entry that moved with it", () => {
    expect(remapOutlineNumber({ kind: "insert", at: 3, entry: {} }, 2)).toBe(2);
    expect(remapOutlineNumber({ kind: "insert", at: 3, entry: {} }, 3)).toBe(4);
    expect(remapOutlineNumber({ kind: "move", from: 5, to: 7 }, 5)).toBe(7);
    expect(remapOutlineNumber({ kind: "move", from: 5, to: 7 }, 6)).toBe(5);
    expect(remapOutlineNumber({ kind: "move", from: 5, to: 7 }, 8)).toBe(8);
    expect(remapOutlineNumber({ kind: "move", from: 7, to: 2 }, 2)).toBe(3);
    expect(remapOutlineNumber({ kind: "remove", number: 4 }, 4)).toBeNull();
    expect(remapOutlineNumber({ kind: "remove", number: 4 }, 6)).toBe(6);
    expect(remapOutlineNumber({ kind: "remove", number: 4, renumber: true }, 6)).toBe(5);
    expect(remapOutlineNumber({ kind: "append", entry: {} }, 9)).toBe(9);
  });
});

describe("several edits made into one commit", () => {
  it("write the files once, each expecting the version that was read, and make every entry the author's", async () => {
    const snapshot = await snapshotOf([await autopilotEntry(1, "One", "a"), await autopilotEntry(2, "Two", "b"), await autopilotEntry(3, "Three", "c")]);
    const { changes, next } = await compose(snapshot, [{ kind: "update", number: 2, entry: { body: "b, rewritten" } }, { kind: "update", number: 2, entry: { title: "Two, again" } }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "outline/chapters/002.md", expectedHash: snapshot.files.get("outline/chapters/002.md")!.hash });
    expect(changes[0].content).toContain("origin: author");
    expect(changes[0].content).not.toContain("digest:");
    const two = next.outline.chapters.find((entry) => entry.number === 2)!;
    expect(two).toMatchObject({ title: "Two, again", body: "b, rewritten", origin: "author", intact: false });
  });

  it("move an entry after another as the engine does, touching only the files in between", async () => {
    const files = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((number) => authorEntry(number, `T${number}`, `B${number}`)));
    const snapshot = await snapshotOf(files);
    const { changes, next } = await compose(snapshot, [{ kind: "move", from: 5, to: 7 }]);
    expect(changes.map((change) => change.path)).toEqual(["outline/chapters/005.md", "outline/chapters/006.md", "outline/chapters/007.md"]);
    expect(next.outline.chapters.map((entry) => entry.title)).toEqual(["T1", "T2", "T3", "T4", "T6", "T7", "T5", "T8"]);
  });

  it("create the description and the entries of an empty outline, none expected to exist", async () => {
    const snapshot = await snapshotOf([]);
    const { changes } = await compose(snapshot, [
      { kind: "book", body: "A harbor of glass." },
      { kind: "update", number: 1, entry: { title: "Wake", body: "Mira wakes." } },
      { kind: "update", number: 2, entry: { title: "Key", body: "Mira finds the key." } },
    ]);
    expect(changes.map((change) => [change.path, change.expectedHash])).toEqual([["outline/book.md", null], ["outline/chapters/001.md", null], ["outline/chapters/002.md", null]]);
  });

  it("leave out what comes back to what it was", async () => {
    const snapshot = await snapshotOf([await authorEntry(1, "One", "a"), await authorEntry(2, "Two", "b")]);
    const { changes } = await compose(snapshot, [{ kind: "move", from: 1, to: 2 }, { kind: "move", from: 2, to: 1 }]);
    expect(changes).toEqual([]);
  });
});

describe("the engine's composer, as the page and the Copilot ask for it", () => {
  it("answers an edit of a chapter that has no entry with a warning, makes the others, and refuses nothing", async () => {
    const snapshot = await snapshotOf([await authorEntry(1, "One", "a"), await authorEntry(2, "Two", "b")]);
    const { changes, warnings, steps } = await compose(snapshot, [{ kind: "remove", number: 9 }, { kind: "move", from: 8, to: 1 }, { kind: "update", number: 2, entry: { title: "Deux" } }]);
    expect(changes.map((change) => change.path)).toEqual(["outline/chapters/002.md"]);
    expect(warnings.filter((warning) => warning.code === "not-found")).toHaveLength(2);
    expect(steps.map((step) => ("missing" in step && step.missing) === true)).toEqual([true, true, false]);
  });

  it("has no limit of edits or of files: more than the composer allows a server's call", async () => {
    const files = await Promise.all(Array.from({ length: 1010 }, (_, index) => authorEntry(index + 1, `T${index + 1}`, `B${index + 1}`)));
    const snapshot = await snapshotOf(files);
    const many = await compose(snapshot, Array.from({ length: 60 }, (_, index) => ({ kind: "update", number: 1, entry: { body: `Version ${index}` } }) as OutlineEdit));
    expect(many.changes).toHaveLength(1);
    const wide = await compose(snapshot, [{ kind: "move", from: 1010, to: 1 }]);
    expect(wide.changes).toHaveLength(1010);
  }, 30_000);

  it("reads an outline with two files for one chapter whole, as the engine reads it: the file that waited takes the number an edit frees", async () => {
    const files = [await authorEntry(6, "Six", "f"), await authorEntry(7, "Seven", "g"), await file("outline/chapters/7.md", serializeOutlineChapter({ number: 7, title: "Seven, the other file", body: "h", origin: "author" })), await authorEntry(8, "Eight", "i")];
    const snapshot = await snapshotOf(files);
    expect(snapshot.outline.warnings.map((warning) => warning.code)).toContain("duplicate");
    const { changes, next } = await compose(snapshot, [{ kind: "remove", number: 7 }]);
    expect(changes.map((change) => [change.path, change.content === null])).toEqual([["outline/chapters/007.md", true]]);
    const fresh = await parseOutline([...next.files.values()]);
    expect(next.outline.chapters.map((entry) => [entry.number, entry.title, entry.hash])).toEqual(fresh.chapters.map((entry) => [entry.number, entry.title, entry.hash]));
    expect(next.outline.chapters.find((entry) => entry.number === 7)?.title).toBe("Seven, the other file");
  });

  it("says which entry an edit is about though the numbers shifted before it: the number the entry had when the series began", async () => {
    const snapshot = await snapshotOf(await Promise.all([1, 2, 3, 4].map((number) => authorEntry(number, `T${number}`, `B${number}`))));
    const { steps } = await compose(snapshot, [{ kind: "insert", at: 1, entry: { title: "New" } }, { kind: "update", number: 2, entry: { title: "T1, again" } }, { kind: "remove", number: 5 }]);
    expect(steps).toEqual([
      { kind: "insert", at: 1 },
      { kind: "update", number: 2, created: false, fields: ["title"], origin: 1 },
      { kind: "remove", number: 5, renumber: false, origin: 4 },
    ]);
  });
});

describe("the outline after a commit", () => {
  it("is the one a fresh reading of the files gives", async () => {
    const files = await Promise.all([1, 2, 3].map((number) => autopilotEntry(number, `T${number}`, `B${number}`)));
    const snapshot = await snapshotOf([...files, await file("outline/book.md", serializeOutlineBook({ title: "Glass", body: "About glass." }))]);
    const { changes } = await compose(snapshot, [{ kind: "insert", at: 2, entry: { title: "New" } }, { kind: "remove", number: 4 }, { kind: "book", body: "About sand." }]);
    const after = await applyToSnapshot(snapshot, changes);
    const fresh = await parseOutline([...after.files.values()]);
    expect(after.outline.chapters.map((entry) => [entry.number, entry.title, entry.hash, entry.contentDigest])).toEqual(fresh.chapters.map((entry) => [entry.number, entry.title, entry.hash, entry.contentDigest]));
    expect(after.outline.book?.body).toBe("About sand.");
  });
});

describe("the chapter-by-chapter synopsis of the brief", () => {
  it("becomes entries with a hypothetical title where the line gives one, and the rest goes to the description", () => {
    const converted = convertSynopsis([
      "Un porto di vetro nasconde una bugia.",
      "",
      "Capitolo 1: Il risveglio — Mira si sveglia al porto.",
      "Il vento porta sabbia.",
      "Capitolo 2: Mira trova la chiave nella sabbia, sotto il molo.",
      "Chapter 3 - The council",
      "4. The wall cracks and the city floods while the council lies.",
    ].join("\n"));
    expect(converted.description).toBe("Un porto di vetro nasconde una bugia.");
    expect(converted.entries).toEqual([
      { number: 1, title: "Il risveglio", body: "Mira si sveglia al porto.\nIl vento porta sabbia." },
      { number: 2, title: "", body: "Mira trova la chiave nella sabbia, sotto il molo." },
      { number: 3, title: "The council", body: "" },
      { number: 4, title: "", body: "The wall cracks and the city floods while the council lies." },
    ]);
  });

  it("finds nothing to convert in a text without chapter lines", () => {
    expect(convertSynopsis("Just an idea about glass.").entries).toEqual([]);
  });
});
