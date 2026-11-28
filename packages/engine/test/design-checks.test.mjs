import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The checks of a design that came after the first ones: what is told too early, threads without a payoff, who knows what and when, the timeline, a character in two
// places at once, the names the canon does not have; and the spoiler check on written text.

const { compareStoryDates, designFindings, findingText, readSecretLedger, secretKeywords, spoilerChecks, storyDate } = engine;
const designChecks = designFindings;
const designFindingText = findingText;

const characters = [
  { slug: "elio", name: "Elio Marr" },
  { slug: "mara", name: "Mara Voss" },
  { slug: "keeper", name: "The Keeper", aliases: ["Old Tam"] },
];
const locations = [{ slug: "lighthouse", name: "The Lighthouse" }, { slug: "harbour", name: "The Harbour" }];
const wreck = { slug: "the-wreck", title: "The wreck of the Aurora", holders: ["character:keeper"], ledger: readSecretLedger({ learned_by: [{ character: "character:elio", chapter: 7 }], clues: [{ chapter: 3, note: "Wet boots." }] }).ledger, revealChapter: 9, knownFromChapter: 8 };

const base = (over = {}) => ({ chapters: [], secrets: [], characters, locations, lastChapter: 12, ...over });
const codes = (input) => designChecks(input).map((finding) => finding.code);
const only = (input, code) => designChecks(input).filter((finding) => finding.code === code);

test("a chapter that tells the reader a secret before it is revealed is a finding, once, and not when the point of view already said so", () => {
  const chapters = [
    { number: 2, design: { reveals: ["secret:the-wreck"], characters: ["Mara"] } },
    { number: 4, design: { reveals: ["The wreck of the Aurora is the keeper's doing"], pov: ["Elio"] } },
    { number: 9, design: { reveals: ["secret:the-wreck"] } },
  ];
  const found = only(base({ chapters, secrets: [wreck] }), "reveal-too-early");
  // Chapter 4's point of view is Elio, who learns it in 7: that one is the first check's, not said twice.
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.other]), [[2, 8]]);
  assert.equal(found[0].severity, "warning");
  assert.match(designFindingText(found[0], "en"), /Chapter 2 tells the reader the secret «The wreck of the Aurora», which is revealed only from chapter 8/);
  assert.match(designFindingText(found[0], "it"), /Il capitolo 2 fa scoprire al lettore il segreto/);
});

test("a clue that names the secret outright is too explicit; a tag with its id is bookkeeping, and an event that names it is a lighter finding", () => {
  const chapters = [
    { number: 3, design: { clues: ["Wet boots, tagged secret:the-wreck", "A hint: the wreck of the Aurora was no accident"] } },
    { number: 5, design: { events: ["The wreck of the Aurora is whispered about at the pier"] } },
    { number: 6, design: { clues: ["Wet boots (secret:the-wreck)"] } },
  ];
  const found = only(base({ chapters, secrets: [wreck] }), "hint-too-explicit");
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.severity, finding.field]), [[3, "warning", "clues"], [5, "info", "events"]]);
  assert.match(designFindingText(found[0], "en"), /hint that is too explicit/);
  // The notes of the ledger count too, as a lighter finding.
  const ledger = readSecretLedger({ clues: [{ chapter: 2, note: "The wreck of the Aurora, hinted at" }] }).ledger;
  assert.deepEqual(only(base({ secrets: [{ ...wreck, ledger }] }), "hint-too-explicit").map((finding) => [finding.chapter, finding.severity]), [[2, "info"]]);
});

test("a character who has not learned a secret acts on it or speaks of it in any chapter: a finding when the line says both, a lighter one when it is only on stage with it", () => {
  const chapters = [
    { number: 2, design: { characters: ["Elio"], events: ["Elio confronts the keeper about the wreck of the Aurora"] } },
    { number: 4, design: { pov: ["Mara"], characters: ["Elio"], scenes: ["The crowd speaks of the wreck of the Aurora"] } },
    { number: 5, design: { characters: ["Mara"], events: ["Mara sails out"] } },
    { number: 6, design: { characters: ["Elio"], events: ["Elio talks to the wreck of the Aurora"] } },
  ];
  const found = only(base({ chapters, secrets: [{ ...wreck, revealChapter: 9, knownFromChapter: 9 }] }), "character-acts-on-secret");
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.severity, finding.name]), [[2, "warning", "Elio Marr"], [4, "info", "Elio Marr"], [6, "warning", "Elio Marr"]]);
  assert.match(designFindingText(found[0], "en"), /In chapter 2 Elio Marr acts on the secret/);
  assert.match(designFindingText(found[1], "en"), /check that they know nothing of it/);
  assert.match(designFindingText(found[0], "it"), /Nel capitolo 2 Elio Marr agisce sul segreto/);
  // A holder knows it from the start.
  const holder = { ...wreck, holders: ["character:elio"] };
  assert.deepEqual(only(base({ chapters, secrets: [holder] }), "character-acts-on-secret"), []);
});

test("a thread planted and never paid, paid before it is planted, or beyond the last chapter is a finding; a thread given up on purpose, or paid, is not", () => {
  const threads = [
    { id: "t-1", title: "The lamp", setup: { chapter: 2, note: "" }, status: "open" },
    { id: "t-2", title: "The letter", setup: { chapter: 6, note: "" }, payoff: { chapter: 3, note: "" }, status: "paid" },
    { id: "t-3", title: "The key", setup: { chapter: 4, note: "" }, payoff: { chapter: 20, note: "" }, status: "open" },
    { id: "t-4", title: "The dog", setup: { chapter: 1, note: "" }, status: "dropped" },
    { id: "t-5", title: "The song", setup: { chapter: 1, note: "" }, payoff: { chapter: 12, note: "" }, status: "paid" },
  ];
  const found = designChecks(base({ threads })).filter((finding) => finding.thread);
  assert.deepEqual(found.map((finding) => [finding.code, finding.thread.id, finding.chapter]), [["thread-without-payoff", "t-1", 2], ["thread-payoff-before-setup", "t-2", 3], ["thread-out-of-range", "t-3", 20]]);
  assert.match(designFindingText(found[0], "en"), /The thread «The lamp» is set up in chapter 2 and has no payoff/);
  assert.match(designFindingText(found[1], "it"), /prima di essere preparato/);
  assert.match(designFindingText(found[2], "en"), /after the last chapter of the book \(12\)/);
});

test("dates are read only in forms that cannot be misread, and compared at the precision both have", () => {
  assert.deepEqual(storyDate("1348-03-12, night"), { year: 1348, month: 3, day: 12 });
  assert.deepEqual(storyDate("March 1348"), { year: 1348 });
  assert.deepEqual(storyDate("12/03/1348"), { year: 1348, month: 3, day: 12 });
  assert.deepEqual(storyDate("1348-03"), { year: 1348, month: 3 });
  assert.equal(storyDate("three days later"), undefined);
  assert.equal(storyDate("room 4821"), undefined, "a number of four digits beyond the years a story has is no year");
  assert.equal(compareStoryDates({ year: 1348, month: 3 }, { year: 1348 }), 0);
  assert.equal(compareStoryDates({ year: 1348, month: 3, day: 12 }, { year: 1348, month: 3, day: 13 }), -1);
  assert.equal(compareStoryDates({ year: 1400 }, { year: 1348, month: 12 }), 1);
});

test("a timeline event anchored to a chapter whose design puts it at another date is a finding, and so are dates that contradict the order of the chapters (a flashback is allowed)", () => {
  const chapters = [
    { number: 2, design: { time: "1348-03-12" } },
    { number: 3, design: { time: "1348-03-20" } },
    { number: 4, design: { time: "1347-06-01, a memory of the first voyage" } },
    { number: 5, design: { time: "1348-02-01" } },
  ];
  const timeline = [{ slug: "storm", title: "The great storm", date: "1348-03-15", participants: ["Elio", "Nobody Known"], chapter: 2 }, { slug: "fair", title: "The fair", date: "1348", participants: [], chapter: 3 }];
  const found = designChecks(base({ chapters, timeline }));
  assert.deepEqual(found.filter((finding) => finding.code === "timeline-date-mismatch").map((finding) => [finding.chapter, finding.event.slug]), [[2, "storm"]]);
  assert.deepEqual(found.filter((finding) => finding.code === "timeline-order").map((finding) => [finding.chapter, finding.other]), [[5, 3]]);
  assert.deepEqual(found.filter((finding) => finding.code === "unknown-character" && finding.event).map((finding) => finding.name), ["Nobody Known"]);
  assert.match(designFindingText(found.find((finding) => finding.code === "timeline-date-mismatch"), "en"), /timeline event «The great storm», anchored to chapter 2/);
  assert.match(designFindingText(found.find((finding) => finding.code === "timeline-order"), "it"), /un flashback\?/);
});

test("two events dated against the order of the chapters they are anchored to are a finding", () => {
  const timeline = [{ slug: "a", title: "A", date: "1350-01-01", participants: [], chapter: 2 }, { slug: "b", title: "B", date: "1349-05-05", participants: [], chapter: 6 }];
  const found = only(base({ timeline }), "timeline-order");
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.other, finding.event.slug]), [[6, 2, "b"]]);
});

test("a character at the same time in two different places is a finding, once for the pair of chapters", () => {
  const chapters = [
    { number: 4, design: { time: "1348-03-12, night", setting: "The Lighthouse", characters: ["Elio", "Mara"] } },
    { number: 5, design: { time: "1348-03-12, night", setting: "The Harbour", pov: ["Elio"], characters: ["Keeper"] } },
    { number: 6, design: { time: "1348-03-12, night", setting: "The Harbour", characters: ["Mara"] } },
    { number: 7, design: { time: "the next day", setting: "The Harbour", characters: ["Elio"] } },
  ];
  const found = only(base({ chapters }), "character-in-two-places");
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.other, finding.name]), [[4, 5, "Elio Marr"], [4, 6, "Mara Voss"]]);
  assert.deepEqual(found[0].places, ["The Lighthouse", "The Harbour"]);
  assert.match(designFindingText(found[0], "en"), /Elio Marr is in two places at the same time: in chapter 4 at «The Lighthouse» and in chapter 5 at «The Harbour»/);
  assert.match(designFindingText(found[0], "it"), /è in due posti nello stesso momento/);
});

test("names the canon does not have are findings wherever they are written: the holders and learners of a secret, a secret that an entry names and the book lacks", () => {
  const secret = { ...wreck, holders: ["Stranger One"], ledger: readSecretLedger({ learned_by: [{ character: "Stranger Two", chapter: 5 }] }).ledger };
  const chapters = [{ number: 3, design: { reveals: ["secret:no-such-secret"], withholds: ["secret:the-wreck"] } }];
  const found = designChecks(base({ secrets: [secret], chapters }));
  assert.deepEqual(found.filter((finding) => finding.code === "unknown-character" && finding.secret).map((finding) => finding.name).sort(), ["Stranger One", "Stranger Two"]);
  assert.deepEqual(found.filter((finding) => finding.code === "unknown-secret").map((finding) => [finding.chapter, finding.name]), [[3, "no-such-secret"]]);
  assert.match(designFindingText(found.find((finding) => finding.code === "unknown-secret"), "en"), /names the secret «no-such-secret», which the book does not have/);
});

test("a book that has none of the new data gets the findings it always had, and no more", () => {
  const chapters = [{ number: 1, design: { goal: "Open", pov: ["Elio"], events: ["a"], ending: "x" } }];
  assert.deepEqual(codes(base({ chapters })), []);
  assert.deepEqual(codes({ chapters: [], secrets: [], characters: [], locations: [] }), []);
});

// ─── The spoiler check on written prose ─────────────────────────────────────

const truth = "The keeper scuttled the Aurora himself to hide the smuggled silver beneath the lighthouse.";
const secret = { slug: "the-wreck", title: "The wreck of the Aurora", holders: [], ledger: readSecretLedger({}).ledger, revealChapter: 9, knownFromChapter: 8, truth };

test("the keywords of a secret are the words particular to its truth", () => {
  const keywords = secretKeywords(truth);
  assert.ok(keywords.includes("scuttled") && keywords.includes("smuggled") && keywords.includes("silver") && keywords.includes("lighthouse"));
  assert.ok(!keywords.includes("the") && !keywords.includes("to"));
});

test("written text that states a secret before the chapter from which the reader may know it is a finding, with the sentence; text before saying nothing of it, and text at or after the reveal, is not", () => {
  const chapters = [
    { number: 1, text: "Elio walked along the pier. The sea was calm.\n\nMara waited." },
    { number: 2, text: "At dinner Tam said it plainly. The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse. Nobody spoke." },
    { number: 3, text: "People still spoke of the wreck of the Aurora at the pier." },
    { number: 4, text: "Nothing of the sort: the silver was a rumour." },
    { number: 8, text: "The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse." },
    { number: 10, text: "The wreck of the Aurora, said the keeper, was his doing." },
  ];
  const found = spoilerChecks({ chapters, secrets: [secret] });
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.other, finding.severity]), [[2, 8, "warning"], [3, 8, "warning"]]);
  assert.match(found[0].excerpt, /scuttled the Aurora himself/);
  assert.match(designFindingText(found[0], "en"), /The written text of chapter 2 states the secret «The wreck of the Aurora» before its reveal \(chapter 8\)/);
  assert.match(designFindingText(found[1], "it"), /Il testo scritto del capitolo 3 dice il segreto/);
});

test("a secret with no chapter that reveals it, or one revealed in the first chapter, has no threshold and says nothing; the id of a secret in the text is always a finding", () => {
  const text = "The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.";
  assert.deepEqual(spoilerChecks({ chapters: [{ number: 1, text }], secrets: [{ ...secret, revealChapter: undefined, knownFromChapter: undefined }] }), []);
  assert.deepEqual(spoilerChecks({ chapters: [{ number: 1, text }], secrets: [{ ...secret, revealChapter: 1, knownFromChapter: undefined }] }), []);
  assert.equal(spoilerChecks({ chapters: [{ number: 2, text: "A note: secret:the-wreck." }], secrets: [{ ...secret, truth: "" }] }).length, 1);
});

// ─── What is read from a book ───────────────────────────────────────────────

test("the checks read a real book: the timeline events with their chapters and dates, the threads, the secrets with their truth, and the text of the written chapters", async () => {
  const { MemoryBookStore, seedBookFiles } = await import("../dist/testing/index.js");
  const store = new MemoryBookStore({
    ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }),
    "secrets/the-wreck.md": "---\ntype: secret\nid: secret:the-wreck\ntitle: The wreck of the Aurora\nreveal_in: chapter:005-the-reveal\nholders: [character:keeper]\n---\n\nThe keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.\n",
    "timelines/events/storm.md": "---\ntype: timeline-event\nid: timeline-event:storm\ntitle: The great storm\ndate: 1348-03-15\nparticipants: [Elio]\nreveal_in: chapter:002-the-pier\n---\n\nThe storm.\n",
    "bible/threads.md": "---\ntype: bible\nid: bible:threads\nthreads:\n  - id: t-001\n    title: The lamp\n    setup: { chapter: 2 }\n---\n",
    "chapters/002-the-pier/chapter.md": "---\ntype: chapter\nid: chapter:002-the-pier\nnumber: 2\ntitle: The pier\n---\n\n# The pier\n",
    "chapters/002-the-pier/001-dinner.md": "---\ntype: paragraph\nid: paragraph:002-the-pier:001-dinner\nchapter: chapter:002-the-pier\nnumber: 1\ntitle: Dinner\n---\n\nTam said it plainly. The keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.\n",
    "chapters/005-the-reveal/chapter.md": "---\ntype: chapter\nid: chapter:005-the-reveal\nnumber: 5\ntitle: The reveal\n---\n\n# The reveal\n",
    "chapters/005-the-reveal/001-truth.md": "---\ntype: paragraph\nid: paragraph:005-the-reveal:001-truth\nchapter: chapter:005-the-reveal\nnumber: 1\ntitle: Truth\n---\n\nThe keeper scuttled the Aurora himself, to hide the smuggled silver beneath the lighthouse.\n",
  });
  const snapshot = await engine.loadBookSnapshot(store);
  const events = await engine.loadTimelineEvents(store, snapshot);
  assert.deepEqual(events, [{ slug: "storm", title: "The great storm", date: "1348-03-15", participants: ["Elio"], chapter: 2 }]);
  assert.deepEqual((await engine.loadThreads(store)).map((thread) => [thread.id, thread.setup.chapter]), [["t-001", 2]]);
  const written = await engine.loadWrittenChapters(store, snapshot);
  assert.deepEqual(written.map((chapter) => chapter.number), [2, 5]);
  assert.match(written[0].text, /scuttled the Aurora/);
  assert.doesNotMatch(written[0].text, /^---|type: paragraph/);
  assert.deepEqual((await engine.loadWrittenChapters(store, snapshot, [5])).map((chapter) => chapter.number), [5]);
  const secrets = await engine.loadSpoilerSecretsOfBook(store, snapshot);
  assert.deepEqual(secrets.map((entry) => [entry.slug, entry.revealChapter, entry.holders]), [["the-wreck", 5, ["character:keeper"]]]);
  const found = spoilerChecks({ chapters: written, secrets });
  assert.deepEqual(found.map((finding) => [finding.chapter, finding.other]), [[2, 5]], "chapter 2 is before the reveal, chapter 5 is the reveal");
  assert.deepEqual((await engine.spoilerFindingsOfChapter(store, snapshot, written[0])).map((finding) => finding.chapter), [2]);
  assert.deepEqual(await engine.spoilerFindingsOfChapter(store, snapshot, written[1]), []);
});
