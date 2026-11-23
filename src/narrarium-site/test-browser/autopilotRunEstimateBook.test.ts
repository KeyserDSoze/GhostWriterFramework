import { describe, expect, it } from "vitest";
import {
  OUTLINE_BOOK_FILE,
  countWords,
  defaultDirector,
  directorPrompt,
  evaluationStyleBlock,
  ghostwriterPrompt,
  isThinDocument,
  mergeReaderPersonas,
  outlineChapterPath,
  outlineEntryDigest,
  parseDirector,
  parseEvaluationStyle,
  parseGhostwriter,
  parseMarkdown,
  readerPersonaPath,
  serializeReaderPersona,
  serializeDirector,
  serializeGhostwriter,
  serializeOutlineBook,
  serializeOutlineChapter,
  emptyGhostwriter,
  type BookStore,
} from "narrarium-engine";
import { MemoryBookStore } from "narrarium-engine/testing";
import { readEstimateBook } from "@/autopilot/runEstimateBook";
import { storeOutlineSource } from "@/outline/outlineSource";

const DESIGN = `---\ntype: note\n---\n# Story design\n\n${"The harbor keeps its ships in a ledger that only the keeper can read. ".repeat(12)}\n`;
const THIN = "---\ntype: note\n---\n# Story design\n\n- Record the premise.\n";

async function bookOf(files: Record<string, string>, patch: Partial<Parameters<typeof readEstimateBook>[0]> = {}) {
  const store = new MemoryBookStore(files);
  return readEstimateBook({ store, outlineFiles: () => storeOutlineSource(store).files(), language: "en", personaPaths: [], ghostwriterSlugs: [], ...patch });
}

describe("the director of the book", () => {
  it("says the rounds of review its file allows, and counts the words of its profile as the prompts carry them", async () => {
    const profile = { ...defaultDirector("en"), name: "Ada", maxReviewRounds: 3, body: "A tight book that never explains its own ending. ".repeat(6) };
    const file = serializeDirector(profile);
    const book = await bookOf({ "director.md": file });
    expect(book.directorRounds).toBe(3);
    expect(book.directorFile).toBe(true);
    expect(book.context.directorWords).toBe(countWords(directorPrompt(parseDirector(file, "en"))));
  });

  it("is the default director when the book has none: the rounds the engine's default has, and no size of its own", async () => {
    const book = await bookOf({});
    expect(book.read).toBe(true);
    expect(book.directorFile).toBe(false);
    expect(book.directorRounds).toBe(defaultDirector("en").maxReviewRounds);
    expect(book.context.directorWords).toBeUndefined();
  });

  it("is read in the language of the book, as the engine reads it", async () => {
    const file = serializeDirector({ ...defaultDirector("it"), maxReviewRounds: 1 });
    const book = await bookOf({ "director.md": file }, { language: "it" });
    expect(book.directorRounds).toBe(parseDirector(file, "it").maxReviewRounds);
  });
});

describe("the files the prompts carry", () => {
  it("weighs the story design and tells a written one from a scaffold that only has headings and hints", async () => {
    const written = await bookOf({ "story-design.md": DESIGN });
    expect(written.designWritten).toBe(true);
    expect(isThinDocument(parseMarkdown(DESIGN).body)).toBe(false);
    expect(written.context.designWords).toBe(countWords(parseMarkdown(DESIGN).body));
    const thin = await bookOf({ "story-design.md": THIN });
    expect(thin.designWritten).toBe(false);
    // The scaffold is what the concept writes first: the engine's typical size stands for the design it will have, not the few words of the hints.
    expect(thin.context.designWords).toBeUndefined();
    const none = await bookOf({});
    expect(none.designWritten).toBe(false);
    expect(none.context.designWords).toBeUndefined();
    expect((await bookOf({ "context.md": "---\ntype: note\n---\n# World\n\nA short note.\n" })).context.worldWords).toBeUndefined();
  });

  it("weighs the world context, the ghostwriter the book uses and the evaluation style when the book has them", async () => {
    const ghostwriter = serializeGhostwriter({ ...parseGhostwriter("noir", ""), slug: "noir", name: "Noir", voice: "Short, dry, in the present tense. ".repeat(20) });
    const style = "---\ntype: guideline\n---\n# Evaluation style\n\n## Criteria\n\n- Voice: does it sound like the book?\n- Pacing: does each scene move?\n\n## Method\n\nQuote the text.\n";
    const world = `---\ntype: note\n---\n# World\n\n${"The harbor freezes in March and thaws in June, and the ledger stays shut. ".repeat(4)}\n`;
    const book = await bookOf(
      { "context.md": world, "ghostwriters/default.md": serializeGhostwriter(parseGhostwriter("default", "")), "ghostwriters/noir.md": ghostwriter, "evaluation-guidelines.md": style },
      { ghostwriter: "noir", ghostwriterSlugs: ["default", "noir"] },
    );
    expect(book.context.worldWords).toBe(countWords(parseMarkdown(world).body));
    expect(book.context.ghostwriterWords).toBe(countWords(ghostwriterPrompt(parseGhostwriter("noir", ghostwriter))));
    expect(book.context.styleWords).toBe(countWords(evaluationStyleBlock(parseEvaluationStyle(style), { criteria: true })));
    expect(book.context.styleWords).toBeGreaterThan(0);
  });

  it("takes the default ghostwriter when the book names none, else the first one, and none when there is none", async () => {
    const files = { "ghostwriters/default.md": serializeGhostwriter({ ...parseGhostwriter("default", ""), voice: "Plain. ".repeat(40) }), "ghostwriters/alpha.md": serializeGhostwriter({ ...emptyGhostwriter("Alpha"), slug: "alpha", voice: "Ornate. ".repeat(80) }) };
    const withDefault = await bookOf(files, { ghostwriterSlugs: ["alpha", "default"] });
    expect(withDefault.context.ghostwriterWords).toBe(countWords(ghostwriterPrompt(parseGhostwriter("default", files["ghostwriters/default.md"]))));
    const first = await bookOf({ "ghostwriters/alpha.md": files["ghostwriters/alpha.md"] }, { ghostwriterSlugs: ["alpha"] });
    expect(first.context.ghostwriterWords).toBe(countWords(ghostwriterPrompt(parseGhostwriter("alpha", files["ghostwriters/alpha.md"]))));
    expect((await bookOf({}, { ghostwriterSlugs: [] })).context.ghostwriterWords).toBeUndefined();
  });

  it("never reads a path that is not a ghostwriter's file: a slug that is not a name is left alone", async () => {
    const book = await bookOf({ "ghostwriters/default.md": serializeGhostwriter(parseGhostwriter("default", "")) }, { ghostwriter: "../director", ghostwriterSlugs: ["default"] });
    expect(book.context.ghostwriterWords).toBeGreaterThan(0);
  });
});

describe("the readers of the panel", () => {
  it("are the built-in ones that are enabled and not given a weight of zero by the director", async () => {
    const panel = mergeReaderPersonas("en", []);
    const book = await bookOf({});
    expect(book.readerPanelSize).toBe(panel.filter((reader) => reader.enabled).length);
    const weights = Object.fromEntries(panel.slice(0, 2).map((reader) => [reader.slug, 0]));
    const quiet = await bookOf({ "director.md": serializeDirector({ ...defaultDirector("en"), readerWeights: weights }) });
    expect(quiet.readerPanelSize).toBe(panel.filter((reader) => reader.enabled).length - 2);
  });

  it("follow the files of the book: a reader it turns off is not in the panel", async () => {
    const first = mergeReaderPersonas("en", []).find((reader) => reader.enabled)!;
    const path = readerPersonaPath(first);
    const book = await bookOf({ [path]: serializeReaderPersona({ ...first, enabled: false }) }, { personaPaths: [path] });
    expect(book.readerPanelSize).toBe(mergeReaderPersonas("en", []).filter((reader) => reader.enabled).length - 1);
  });
});

describe("the outline of the author", () => {
  const entry = (number: number, title: string, body: string, origin: "author" | "autopilot" = "author", digest?: string) => [outlineChapterPath(number), serializeOutlineChapter({ number, title, body, origin, digest })] as const;

  it("counts the chapters the author wrote an entry for, the last of them, and their words, without the description of the book: the idea is the brief's", async () => {
    const intact = { title: "Filled in", body: "The autopilot wrote this one." };
    const digest = await outlineEntryDigest(intact);
    const files = Object.fromEntries([
      entry(1, "The arrival", "The keeper reaches the harbor at dusk and finds the ledger open."),
      entry(2, intact.title, intact.body, "autopilot", digest),
      entry(5, "The storm", "A storm closes the harbor for three days."),
      [OUTLINE_BOOK_FILE, serializeOutlineBook({ title: "Working title", body: "A keeper, a ledger and the ships that never arrive.", origin: "author" })],
    ]);
    const { outline } = await bookOf(files);
    expect(outline).toEqual({
      entries: 2,
      lastChapter: 5,
      words: countWords("The arrival The keeper reaches the harbor at dusk and finds the ledger open.") + countWords("The storm A storm closes the harbor for three days."),
    });
  });

  it("counts an entry that was changed since the autopilot wrote it, and one whose file cannot be read, as the author's", async () => {
    const digest = await outlineEntryDigest({ title: "Filled in", body: "Original." });
    const files = Object.fromEntries([
      entry(1, "Filled in", "Changed by the author since.", "autopilot", digest),
      [outlineChapterPath(3), "---\n: : not yaml [\n---\nThe author's own words, unreadable above."],
    ]);
    const { outline } = await bookOf(files);
    expect(outline?.entries).toBe(2);
    expect(outline?.lastChapter).toBe(3);
  });

  it("has no outline to say when there are only entries of the autopilot, or none", async () => {
    const digest = await outlineEntryDigest({ title: "T", body: "B" });
    expect((await bookOf(Object.fromEntries([entry(1, "T", "B", "autopilot", digest)]))).outline).toBeUndefined();
    expect((await bookOf({})).outline).toBeUndefined();
  });

  it("is read once and not entry by entry from the store: the folder is what is asked", async () => {
    const store = new MemoryBookStore(Object.fromEntries(Array.from({ length: 300 }, (_, index) => entry(index + 1, `T${index}`, "Some words here."))));
    let asked = 0;
    const book = await readEstimateBook({ store, outlineFiles: async () => { asked += 1; return storeOutlineSource(store).files(); }, language: "en", personaPaths: [], ghostwriterSlugs: [] });
    expect(asked).toBe(1);
    expect(book.outline).toMatchObject({ entries: 300, lastChapter: 300 });
  });
});

describe("a book that cannot be read", () => {
  it("is said, and nothing is made up of it: the estimate is made with typical sizes", async () => {
    const broken: BookStore = { list: async () => [], read: async () => { throw new Error("no working copy"); }, readMany: async () => { throw new Error("no working copy"); }, commit: async () => ({ revision: "x" }) };
    const book = await readEstimateBook({ store: broken, outlineFiles: async () => { throw new Error("no working copy"); }, language: "en", personaPaths: [], ghostwriterSlugs: [] });
    expect(book).toEqual({ read: false, directorFile: false, context: {}, designWritten: false });
  });

  it("is still the files that could be read, when only the outline cannot", async () => {
    const store = new MemoryBookStore({ "director.md": serializeDirector({ ...defaultDirector("en"), maxReviewRounds: 1 }) });
    const book = await readEstimateBook({ store, outlineFiles: async () => { throw new Error("no outline folder"); }, language: "en", personaPaths: [], ghostwriterSlugs: [] });
    expect(book.read).toBe(true);
    expect(book.directorRounds).toBe(1);
    expect(book.outline).toBeUndefined();
  });
});
