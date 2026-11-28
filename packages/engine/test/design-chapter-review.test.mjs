import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, fakeRubric, seedBookFiles } from "../dist/testing/index.js";

// The review of the design of the chapters, chapter by chapter: a panel judges every chapter with the chapters beside it on the twelve criteria, a few in a call. What it keeps says
// which chapters were judged as they are, so that only the ones that changed (or whose neighbours changed) are judged again, and what it said goes to the director.

const {
  AutopilotSession,
  DESIGN_REVIEW_BATCH_CHAPTERS,
  DESIGN_SUMMARY_CHARACTERS,
  chapterReviewSignature,
  designFlow,
  loadBookSnapshot,
  nextChapterReview,
  nextDesignReview,
  normalizeAutopilotState,
  normalizeDesignStart,
  parseAutopilotState,
  reviewableChapters,
  serializeAutopilotState,
  serializeOutlineChapter,
  shortHash,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";

const entry = (number, body = `What happens in ${number}.`) => serializeOutlineChapter({ number, title: `Chapter ${number}`, body, origin: "autopilot" });

async function snapshotOf(files) {
  return loadBookSnapshot(new MemoryBookStore({ ...seedBookFiles({ chapters: 0 }), ...files }));
}

const outlineOf = (numbers, extra = {}) => Object.fromEntries(numbers.map((number) => [`outline/chapters/${String(number).padStart(3, "0")}.md`, extra[number] ?? entry(number)]));

test("a fingerprint is the same for the same text and changes with it", () => {
  assert.equal(shortHash("abc"), shortHash("abc"));
  assert.notEqual(shortHash("abc"), shortHash("abd"));
  assert.match(shortHash(""), /^[0-9a-f]{8}$/);
  assert.match(shortHash("a long text ".repeat(1000)), /^[0-9a-f]{8}$/);
});

test("the chapters a review looks at are the entries of the Synopsis that no prose is written for", async () => {
  const snapshot = await snapshotOf({
    ...outlineOf([1, 2, 3, 4]),
    "chapters/001-one/chapter.md": "---\ntype: chapter\nid: chapter:001-one\nnumber: 1\ntitle: One\n---\n\n# One\n",
    "chapters/001-one/001-scene.md": "---\ntype: paragraph\nid: paragraph:001-one/001\nchapter: chapter:001-one\nnumber: 1\ntitle: Scene\n---\n\nSome prose.\n",
    "chapters/002-two/chapter.md": "---\ntype: chapter\nid: chapter:002-two\nnumber: 2\ntitle: Two\n---\n\n# Two\n",
  });
  assert.deepEqual(reviewableChapters(snapshot), [2, 3, 4], "chapter 1 is written; a folder with no scene is not");
});

test("the signature of a chapter is made of its entry and the entries beside it: a change of a neighbour is a change of the chapter, and nothing else is", async () => {
  const before = await snapshotOf(outlineOf([1, 2, 3, 4, 5]));
  const after = await snapshotOf(outlineOf([1, 2, 3, 4, 5], { 3: entry(3, "Something else happens.") }));
  const same = (number) => chapterReviewSignature(before, number) === chapterReviewSignature(after, number);
  assert.deepEqual([1, 2, 3, 4, 5].map(same), [true, false, false, false, true]);
  assert.equal(chapterReviewSignature(before, 3), chapterReviewSignature(await snapshotOf(outlineOf([1, 2, 3, 4, 5])), 3), "the same files give the same signature");
  assert.match(chapterReviewSignature(before, 1), /^[0-9a-f]{8}$/, "the first chapter has no chapter before it, and a signature all the same");
  assert.notEqual(chapterReviewSignature(before, 5), chapterReviewSignature(await snapshotOf(outlineOf([1, 2, 3, 4, 5, 6])), 5), "a chapter after the last one is a neighbour that came");
});

test("the next chapters to review are the first that were not reviewed as they are and the stale ones that follow, a few in a row", async () => {
  const snapshot = await snapshotOf(outlineOf([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const design = (reviewed = {}, extra = {}) => ({ design: { startedAt: "x", chapters: 9, rounds: [], reviewed, ...extra } });
  assert.equal(DESIGN_REVIEW_BATCH_CHAPTERS, 4);
  assert.deepEqual(nextChapterReview(design(), snapshot), { from: 1, to: 4 });
  const done = (numbers) => Object.fromEntries(numbers.map((number) => [String(number), { sig: chapterReviewSignature(snapshot, number), round: 1, at: "x", overall: 7, verdict: "ok", summary: "" }]));
  assert.deepEqual(nextChapterReview(design(done([1, 2, 3, 4])), snapshot), { from: 5, to: 8 });
  assert.deepEqual(nextChapterReview(design(done([1, 2, 3, 4, 5, 6, 7, 8])), snapshot), { from: 9, to: 9 });
  assert.equal(nextChapterReview(design(done([1, 2, 3, 4, 5, 6, 7, 8, 9])), snapshot), null);
  // A hole in what was reviewed is a batch of its own, and a batch never reaches over what is reviewed.
  assert.deepEqual(nextChapterReview(design(done([1, 2, 4, 5, 6, 7, 8, 9])), snapshot), { from: 3, to: 3 });
  assert.deepEqual(nextChapterReview(design(done([1, 2, 3, 5])), snapshot), { from: 4, to: 4 });
  assert.deepEqual(nextChapterReview(design({ ...done([1, 2, 3, 4]), 2: { ...done([2])["2"], sig: "00000000" } }), snapshot), { from: 2, to: 2 }, "a review of what was another chapter is stale");
  assert.deepEqual(nextChapterReview(design(), snapshot, 6), { from: 6, to: 9 }, "from a chapter on");
  assert.equal(nextChapterReview({}, snapshot), null, "a book with no design reviews nothing");
  // A review of chosen chapters looks only at those.
  assert.deepEqual(nextChapterReview(design({}, { reviewing: { chapters: [3, 4, 7], startedAt: "x" } }), snapshot), { from: 3, to: 4 });
  assert.deepEqual(nextChapterReview(design(done([3, 4]), { reviewing: { chapters: [3, 4, 7], startedAt: "x" } }), snapshot), { from: 7, to: 7 });
});

test("the planner asks for a review of the chapters only when the workflow does, before the director", async () => {
  const snapshot = await snapshotOf(outlineOf([1, 2]));
  const plain = { design: { startedAt: "x", chapters: 2, rounds: [] } };
  assert.equal(nextDesignReview(plain, snapshot), null);
  assert.deepEqual(nextDesignReview({ design: { ...plain.design, workflow: { chapterReview: true } } }, snapshot), { kind: "design-chapter-review", from: 1, to: 2 });
  assert.deepEqual(designFlow({ workflow: { chapterReview: true } }), { rubric: false, chapterReview: true });
  assert.deepEqual(designFlow({ workflow: {}, reviewing: { startedAt: "x" } }), { rubric: true, chapterReview: true }, "a review on request judges, whatever the workflow says");
  assert.deepEqual(normalizeDesignStart({ workflow: { rubric: true, chapterReview: true } }), { workflow: { rubric: true, chapterReview: true } });
  assert.throws(() => normalizeDesignStart({ workflow: { chapterReview: 1 } }), /design\.workflow\.chapterReview must be true or false/);
});

async function describedBook() {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

async function run(store, ai, start) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  await session.start(start);
  await session.waitForIdle();
  return { events, state: parseAutopilotState(store.files.get(STATE)) };
}

const START = (chapters = 6, extra = {}) => ({ design: { chapters, workflow: { rubric: true, chapterReview: true }, ...extra }, options: { readersOnPlan: false, pauseAfterPlan: false } });
const reviews = (ai) => ai.calls.filter((call) => call.json?.name === "design_chapter_review");
const askedChapters = (call) => [...call.user.slice(call.user.indexOf("CHAPTERS UNDER REVIEW:")).matchAll(/^Chapter (\d+)[^\n]*:$/gm)].map((match) => Number(match[1]));

test("with the review of the chapters on, every chapter is judged with its neighbours before the director looks at the whole, a few in a call", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 3 ? { pace: 4, twists: 6 } : 8) });
  const { state, events } = await run(store, ai, START(6));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(ai.calls.map((call) => call.json?.name), ["design_concept", "chapter_design", "design_chapter_review", "design_chapter_review", "design_review"]);
  const asked = reviews(ai);
  assert.deepEqual(asked.map(askedChapters), [[1, 2, 3, 4], [5, 6]]);
  // The panel, with the chapters beside the ones under review for what they take and leave.
  assert.match(asked[0].system, /^You are the Director of this book/);
  assert.match(asked[0].system, /as three voices at once/);
  assert.match(asked[0].system, /the ghostwriter who will write it/);
  assert.match(asked[0].user, /STRUCTURE OF THE BOOK:\n1\. Chapter Title 1 — Goal of chapter 1\.\n2\. /);
  assert.match(asked[0].user, /THE CHAPTERS BESIDE THEM[^\n]*:\nChapter 5:\nTitle: Chapter Title 5/);
  assert.doesNotMatch(asked[0].user, /THE CHAPTERS BESIDE THEM[^\n]*:\nChapter [1-4]:/);
  assert.match(asked[1].user, /THE CHAPTERS BESIDE THEM[^\n]*:\nChapter 4:\nTitle: Chapter Title 4/);
  assert.match(asked[0].user, /CHAPTERS UNDER REVIEW:\nChapter 1:\nTitle: Chapter Title 1\nText of the entry: Summary of chapter 1\.\nNarrative goal: Goal of chapter 1\./);
  assert.match(asked[0].user, /RUBRIC: score these twelve criteria, each once/);
  assert.match(asked[0].user, /Round 1 of the design\./);
  assert.deepEqual(asked[0].json.parameters.properties.chapters.items.properties.rubric.items.required, ["criterion", "applicable", "score", "reason", "issues", "proposals"]);
  // What was kept.
  assert.deepEqual(Object.keys(state.design.reviewed).sort(), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(state.design.reviewed["3"], { sig: state.design.reviewed["3"].sig, round: 1, at: "2026-11-28T09:00:00.000Z", overall: 7.1, verdict: "revise", summary: "Chapter 3 has weak points." });
  assert.equal(state.design.reviewed["1"].verdict, "ok");
  assert.match(state.design.reviewed["1"].sig, /^[0-9a-f]{8}$/);
  assert.deepEqual(state.design.rubric["chapter:3"].latest.map((entry) => entry.criterion), ["pace", "twists"], "a chapter keeps the text of its weak points");
  assert.deepEqual(state.design.rubric["chapter:1"].latest, []);
  assert.equal(state.design.rubric["chapter:1"].history[0].scores.length, 12);
  // What it said to the director and to the author.
  const review = ai.calls.at(-1);
  assert.match(review.user, /CHAPTER-BY-CHAPTER REVIEW \(by the panel, each chapter with the chapters beside it\):\n- Chapter 1 «Chapter Title 1»: 8\/10, ok — Chapter 1 holds\./);
  assert.match(review.user, /- Chapter 3 «Chapter Title 3»: 7\.1\/10, revise; weak: pace 4, twists 6 — Chapter 3 has weak points\./);
  const told = events.filter((event) => event.type === "insight" && event.code === "designChapterReview");
  assert.deepEqual(told.map((event) => event.figures), [{ from: 1, to: 4, score: 7.8, weak: 1 }, { from: 5, to: 6, score: 8, weak: 0 }]);
  assert.deepEqual(told.map((event) => event.tone), ["warning", "ok"]);
  assert.match(told[0].title, /^Chapters 1-4 reviewed: 7\.8\/10 on average, one has weak points$/);
  assert.match(told[0].detail, /Chapter 3: pace 4!, twists 6!/);
  assert.match(told[0].detail, /Chapter 1: no weak point/);
});

test("without the review of the chapters on, no chapter is reviewed and the director's prompt has no such section: the design run of an engine before", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, { design: { chapters: 6 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.deepEqual(ai.calls.map((call) => call.json?.name), ["design_concept", "chapter_design", "design_review"]);
  assert.equal(state.design.reviewed, undefined);
  assert.doesNotMatch(ai.calls.at(-1).user, /CHAPTER-BY-CHAPTER REVIEW/);
});

test("when the design is rewritten, only the chapters that changed, and the ones beside them, are judged again", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    chapterRubric: (chapter, round) => (chapter === 2 && round === 1 ? { pace: 4 } : 8),
    designReview: (round) => (round === 1
      ? { verdict: "revise", score: 6, summary: "Not yet.", strengths: [], changes: [{ chapterNumber: 2, instruction: "Quicken chapter 2." }], guidance: [], critical: [], counterProposal: "x" }
      : { verdict: "approve", score: 9, summary: "Now.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "y" }),
  });
  const { state } = await run(store, ai, START(8, { review: { maxRounds: 3 } }));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.deepEqual(ai.calls.map((call) => call.json?.name), ["design_concept", "chapter_design", "chapter_design", "design_chapter_review", "design_chapter_review", "design_review", "chapter_design", "design_chapter_review", "design_chapter_review", "design_review"]);
  // The first pass judged the eight chapters; the batch of the first six was designed again (chapter 7 is beside chapter 6, chapter 8 is not): seven were judged again.
  assert.deepEqual(reviews(ai).map(askedChapters), [[1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 3, 4], [5, 6, 7]]);
  assert.match(reviews(ai)[2].user, /Round 2 of the design: the design was rewritten since the last round/);
  assert.equal(state.design.reviewed["2"].round, 2);
  assert.equal(state.design.reviewed["8"].round, 1, "the chapter that did not change keeps its review");
  assert.deepEqual(state.design.rubric["chapter:2"].history.map((round) => round.round), [1, 2]);
  assert.ok(state.design.rubric["chapter:2"].history[1].overall > state.design.rubric["chapter:2"].history[0].overall);
});

/** The fake AI whose replies to the review of the chapters are scripted (the last one repeated), the others the defaults. */
function scriptedReviews(replies) {
  let calls = 0;
  return createFakeAutopilotAi({
    answer: (request) => {
      if (request.json?.name !== "design_chapter_review") return undefined;
      calls += 1;
      return replies[Math.min(calls, replies.length) - 1](Array.from({ length: 4 }, (_, index) => ({ chapterNumber: index + 1, verdict: "ok", summary: "Holds.", rubric: fakeRubric(8, { applicable: true }) })));
    },
  });
}

test("a reply that does not review the chapters asked is asked again with the reason, and a second reply that is not whole stops the step with it", async () => {
  const store = await describedBook();
  const ai = scriptedReviews([(items) => ({ chapters: items.slice(0, 3) }), (items) => ({ chapters: items })]);
  const { state } = await run(store, ai, START(4));
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(reviews(ai).length, 2, "the step is asked again once");
  assert.match(reviews(ai)[1].user, /The previous reply to this request was rejected because: The review of the chapters was rejected: chapter 4 is not reviewed\. Return one review for each of the chapters 1, 2, 3, 4\./);
  assert.deepEqual(Object.keys(state.design.reviewed).sort(), ["1", "2", "3", "4"]);
  // The same chapter twice, a chapter nobody asked for.
  const twice = await run(await describedBook(), scriptedReviews([(items) => ({ chapters: [...items, items[0]] })]), START(4));
  assert.match(twice.state.lastError.message, /chapter 1 is reviewed 2 times/);
  const stranger = await run(await describedBook(), scriptedReviews([(items) => ({ chapters: [...items.slice(0, 3), { ...items[3], chapterNumber: 9 }] })]), START(4));
  assert.match(stranger.state.lastError.message, /chapter 4 is not reviewed/);
});

test("a verdict that is neither ok nor revise, a summary over its limit and a rubric that is not whole are rejected, and a review that was not whole is not kept", async () => {
  const rubricOf = (items, number, rubric) => ({ chapters: items.map((item) => (item.chapterNumber === number ? { ...item, rubric } : item)) });
  const bad = [
    [(items) => ({ chapters: items.map((item) => (item.chapterNumber === 2 ? { ...item, verdict: "maybe" } : item)) }), /The review of chapter 2 was rejected: the field "verdict" must be "ok" or "revise"\./],
    [(items) => ({ chapters: items.map((item) => (item.chapterNumber === 2 ? { ...item, summary: "x".repeat(DESIGN_SUMMARY_CHARACTERS + 1) } : item)) }), /the summary is 401 characters long, over the 400 allowed: return it shorter, whole\./],
    [(items) => ({ chapters: items.map((item) => (item.chapterNumber === 3 ? { ...item, summary: " " } : item)) }), /The review of chapter 3 was rejected: the field "summary" is missing\./],
    [(items) => rubricOf(items, 4, fakeRubric(8, { applicable: true }).slice(0, 10)), /The review of chapter 4 was rejected: the criteria «subplots», «ending» are missing/],
    [(items) => rubricOf(items, 1, fakeRubric(8, { applicable: true }).map((entry) => ({ ...entry, applicable: entry.criterion === "pace" || entry.criterion === "tension" || entry.criterion === "ending" || entry.criterion === "twists" || entry.criterion === "emotion" ? true : false, score: entry.criterion === "pace" ? 8 : 0 }))), /only 1 criterion is scored: at least 4 must apply/],
  ];
  for (const [reply, message] of bad) {
    const store = await describedBook();
    const { state } = await run(store, scriptedReviews([reply]), START(4));
    assert.equal(state.status, "error");
    assert.match(state.lastError.message, message);
    assert.equal(state.design.reviewed, undefined, "nothing of a review that was not whole is kept");
    assert.equal(state.design.rubric, undefined);
  }
});

test("an entry of the author's is judged too, and said to bind: the panel proposes for it", async () => {
  const store = await describedBook();
  const author = serializeOutlineChapter({ number: 2, title: "The Bell", body: "Mira rings the bell and nobody comes.", origin: "author" });
  await store.commit([{ path: "outline/chapters/002.md", content: author, expectedHash: null }], "author entry");
  const ai = createFakeAutopilotAi();
  const { state } = await run(store, ai, START(3));
  assert.equal(state.status, "paused", state.lastError?.message);
  const [call] = reviews(ai);
  assert.match(call.user, /Chapter 2 \(the author's entry: binding\):\nTitle: The Bell\nText of the entry: Mira rings the bell and nobody comes\./);
  assert.match(call.system, /An entry that the author wrote binds: propose for it, and the autopilot will not rewrite it\./);
  assert.equal(store.files.get("outline/chapters/002.md"), author, "the entry is as the author wrote it");
  assert.ok(state.design.reviewed["2"]);
});

test("the reviews of the chapters are kept when the state is saved and read again", async () => {
  const store = await describedBook();
  const { state } = await run(store, createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 2 ? { ending: 5 } : 8) }), START(3));
  const again = normalizeAutopilotState(JSON.parse(serializeAutopilotState(state)));
  assert.deepEqual(again.design.reviewed, state.design.reviewed);
  assert.deepEqual(again.design.workflow, { rubric: true, chapterReview: true });
  assert.deepEqual(again.design.rubric["chapter:2"], state.design.rubric["chapter:2"]);
});
