import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// The rewrite of a weak design: what the reviews found weak (a chapter the panel judged under par, a major finding of the analysis, a critical one) is the input of a round, the
// chapters it names are the ones designed again, the loop is bounded by the rounds of its policy and stops at a plateau, and the entries of the author are never rewritten: what
// concerns only them is a proposal for the author, told, and a critical one only they can answer is asked to the author at once.

const {
  AutopilotSession,
  DESIGN_PROPOSALS_MAX,
  DESIGN_REWRITE_NOTES_MAX,
  MAX_REVISION_NOTES,
  parseAutopilotState,
  rewriteExtras,
  serializeOutlineChapter,
  writeOutlineBrief,
} = engine;

const IDEA = "A harbor town built on glass hides a lie that the tide will tell.";
const clock = () => new Date("2026-11-28T09:00:00.000Z");
const STATE = "autopilot/state.json";

const finding = (extra = {}) => ({ id: "a-00000001", source: "ai", kind: "contradiction", severity: "major", chapters: [4], requires: [4], text: "Orrin is in two places on the same day.", owner: "autopilot", status: "open", round: 1, seen: 1, ...extra });
const review = (overall, extra = {}) => ({ sig: "00000000", round: 1, at: "x", overall, verdict: "revise", summary: `Weak at ${overall}.`, ...extra });
const weakRubric = (chapter, ...criteria) => ({ [`chapter:${chapter}`]: { latest: criteria.map(([criterion, score]) => ({ criterion, score, reason: "r", issues: ["i"], proposals: [`Fix the ${criterion}.`] })), history: [] } });
const sources = (extra = {}) => ({ language: "en", existingNotes: 0, named: new Set(), findings: [], rewritable: () => true, ...extra });

test("a major finding that nobody dismissed is a note for the chapters it revises, and those chapters are the ones designed again; the critical ones are the director's already", () => {
  const extras = rewriteExtras(sources({
    findings: [
      finding({ id: "a-00000001", requires: [4, 5], chapters: [4, 5], proposal: "Move the meeting." }),
      finding({ id: "a-00000002", severity: "critical" }),
      finding({ id: "a-00000003", severity: "minor" }),
      finding({ id: "a-00000004", status: "dismissed" }),
      finding({ id: "a-00000005", status: "mine" }),
      finding({ id: "a-00000006", status: "fixed" }),
      finding({ id: "a-00000007", status: "fixing" }),
      finding({ id: "a-00000008", requires: [], chapters: [7], text: "Chapter 7 repeats chapter 6." }),
    ],
  }));
  assert.deepEqual(extras.notes, [
    "Coherence — Chapters 4, 5: Orrin is in two places on the same day. → Move the meeting.",
    "Coherence — Chapter 7: Chapter 7 repeats chapter 6.",
  ]);
  assert.deepEqual(extras.chapters, [4, 5, 7]);
  assert.deepEqual(extras.proposals, []);
  assert.deepEqual(rewriteExtras(sources({ language: "it", findings: [finding({ requires: [2, 3] })] })).notes, ["Coerenza — Capitoli 2, 3: Orrin is in two places on the same day."]);
});

test("a chapter the panel judged under par is a note with what the panel would do, the weakest first, unless the director named it: then it is the director's to say", () => {
  const rubric = { ...weakRubric(3, ["pace", 4], ["tension", 5], ["ending", 6]), ...weakRubric(6, ["twists", 6.5]), ...weakRubric(8, ["ending", 3]) };
  const reviewed = { 3: review(6.4), 6: review(7.2), 8: review(5), 9: review(8, { verdict: "ok" }), 10: review(5, { summary: "Nothing happens." }), 11: review(null, { summary: "" }) };
  const extras = rewriteExtras(sources({ reviewed, rubric, named: new Set([6]) }));
  assert.deepEqual(extras.notes, [
    "Chapter 8: ending (3) — Fix the ending.",
    "Chapter 10: Nothing happens.",
    "Chapter 3: pace (4) — Fix the pace.; tension (5) — Fix the tension.",
  ]);
  assert.deepEqual(extras.chapters, [3, 8, 10]);
  assert.equal(extras.notes.some((note) => note.startsWith("Chapter 6")), false, "named by the director");
  assert.equal(extras.notes.some((note) => note.startsWith("Chapter 9")), false, "an ok verdict");
  assert.equal(extras.notes.some((note) => note.startsWith("Chapter 11")), false, "nothing was said");
});

test("what concerns only the author's entries is a proposal, never a note; a finding that revises both gets a note for the autopilot's and a proposal for the author's", () => {
  const author = new Set([2, 3]);
  const extras = rewriteExtras(sources({
    rewritable: (chapter) => !author.has(chapter),
    findings: [finding({ id: "a-00000001", requires: [2], chapters: [2] }), finding({ id: "a-00000002", requires: [3, 4], chapters: [3, 4], text: "Chapters 3 and 4 clash." })],
    reviewed: { 2: review(5) },
    rubric: weakRubric(2, ["pace", 4]),
  }));
  assert.deepEqual(extras.notes, ["Coherence — Chapter 4: Chapters 3 and 4 clash."]);
  assert.deepEqual(extras.chapters, [4]);
  assert.deepEqual(extras.proposals, [
    { chapter: 2, text: "Orrin is in two places on the same day.", finding: "a-00000001" },
    { chapter: 3, text: "Chapters 3 and 4 clash.", finding: "a-00000002" },
    { chapter: 2, text: "pace (4) — Fix the pace.", finding: null },
  ]);
  assert.equal(rewriteExtras(sources({ rewritable: (chapter) => !author.has(chapter), findings: [finding({ requires: [2], chapters: [2] }), finding({ requires: [2], chapters: [2] })] })).proposals.length, 1, "told once");
});

test("a round adds at most so many notes, the revision never goes over its limit, and the chapters of a note that did not fit are not designed again", () => {
  assert.equal(DESIGN_REWRITE_NOTES_MAX, 20);
  const many = Array.from({ length: 30 }, (_, index) => finding({ id: `a-${String(index).padStart(8, "0")}`, requires: [index + 1], chapters: [index + 1], text: `Problem ${index + 1}.` }));
  const full = rewriteExtras(sources({ findings: many }));
  assert.equal(full.notes.length, DESIGN_REWRITE_NOTES_MAX);
  assert.deepEqual(full.chapters, Array.from({ length: 20 }, (_, index) => index + 1), "only the chapters that have a note");
  const crowded = rewriteExtras(sources({ findings: many, existingNotes: MAX_REVISION_NOTES - 3 }));
  assert.equal(crowded.notes.length, 3);
  assert.equal(crowded.chapters.length, 3);
  assert.deepEqual(rewriteExtras(sources({ findings: many, existingNotes: MAX_REVISION_NOTES + 5 })).notes, []);
  const author = rewriteExtras(sources({ rewritable: () => false, findings: Array.from({ length: DESIGN_PROPOSALS_MAX + 10 }, (_, index) => finding({ id: `a-${String(index).padStart(8, "0")}`, requires: [index + 1], chapters: [index + 1] })) }));
  assert.equal(author.proposals.length, DESIGN_PROPOSALS_MAX);
});

async function describedBook(extra = {}) {
  const store = new MemoryBookStore({ ...seedBookFiles({ chapters: 0, title: "The Glass Harbor" }), ...extra });
  await writeOutlineBrief(store, { idea: IDEA, genre: "mystery", audience: "adults", wordsPerScene: 200 });
  return store;
}

function makeSession(store, ai) {
  const events = [];
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  session.subscribe((event) => events.push(event));
  return { session, events, state: () => parseAutopilotState(store.files.get(STATE)) };
}

async function run(store, ai, start) {
  const made = makeSession(store, ai);
  await made.session.start(start);
  await made.session.waitForIdle();
  return { ...made, state: made.state() };
}

const START = (chapters, workflow, review) => ({ design: { chapters, workflow, ...(review ? { review } : {}) }, options: { readersOnPlan: false, pauseAfterPlan: false } });
const names = (ai) => ai.calls.map((call) => call.json?.name);
const approve = { verdict: "approve", score: 9, summary: "Now.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "y" };
const revise = (score = 6, extra = {}) => ({ verdict: "revise", score, summary: "Not yet.", strengths: [], changes: [], guidance: [], critical: [], counterProposal: "x", ...extra });
const insights = (events, code) => events.filter((event) => event.type === "insight" && event.code === code);

test("a weak chapter is what a round rewrites: the director asked for nothing, the panel found chapter 9 weak, and only the batch that holds it is designed again, then judged again", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({
    chapterRubric: (chapter, round) => (chapter === 9 && round === 1 ? { pace: 4, tension: 5 } : 8),
    designReview: (round) => (round === 1 ? revise(6) : approve),
  });
  const { state } = await run(store, ai, START(12, { rubric: true, chapterReview: true }, { maxRounds: 3 }));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.deepEqual(names(ai).filter((name) => name !== "design_chapter_review"), ["design_concept", "chapter_design", "chapter_design", "design_review", "chapter_design", "design_review"]);
  const redesign = ai.calls.filter((call) => call.json?.name === "chapter_design").at(-1);
  assert.match(redesign.user, /Revise the design of chapters 7-12 applying the director's changes:\n- Chapter 9: pace \(4\) — Strengthen the pace\.; tension \(5\) — Strengthen the tension\./, "only the batch of chapter 9");
  assert.doesNotMatch(redesign.user, /Chapter [1-8]:/);
  // What changed is judged again: chapter 6 is beside chapter 7.
  const asked = ai.calls.filter((call) => call.json?.name === "design_chapter_review").map((call) => [...call.user.slice(call.user.indexOf("CHAPTERS UNDER REVIEW:")).matchAll(/^Chapter (\d+)[^\n]*:$/gm)].map((match) => Number(match[1])));
  assert.deepEqual(asked, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [6, 7, 8, 9], [10, 11, 12]]);
  assert.deepEqual(state.design.rounds.map((round) => [round.score, round.verdict]), [[6, "revise"], [9, "approve"]]);
  assert.equal(state.design.reviewed["9"].verdict, "ok");
  assert.deepEqual(state.design.rubric["chapter:9"].history.map((entry) => entry.round), [1, 2]);
  assert.deepEqual(state.design.rubric["chapter:9"].latest, []);
});

test("what the director votes below its target with nothing to change and nothing weak found is the design as it is, and with something weak found it is a round", async () => {
  const quiet = createFakeAutopilotAi({ designReview: () => revise(6) });
  const { state } = await run(await describedBook(), quiet, START(6, { rubric: true, chapterReview: true }));
  assert.equal(state.design.outcome, "unchanged", state.lastError?.message);
  assert.equal(state.design.rounds.length, 1);
  assert.equal(names(quiet).filter((name) => name === "chapter_design").length, 1);
  const weak = createFakeAutopilotAi({ chapterRubric: (chapter, round) => (chapter === 2 && round === 1 ? { ending: 5 } : 8), designReview: (round) => (round === 1 ? revise(6) : approve) });
  const second = await run(await describedBook(), weak, START(6, { chapterReview: true }));
  assert.equal(second.state.design.outcome, "target");
  assert.equal(second.state.design.rounds.length, 2);
});

test("the loop is bounded: a weak chapter that stays weak is rewritten until the votes stop improving or the rounds are used, and no more", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 9 ? { pace: 4 } : 8), designReview: () => revise(6) });
  const { state, events } = await run(store, ai, START(12, { chapterReview: true }, { maxRounds: 8 }));
  assert.equal(state.design.outcome, "plateau", state.lastError?.message);
  assert.deepEqual(state.design.rounds.map((round) => round.score), [6, 6, 6]);
  assert.equal(names(ai).filter((name) => name === "chapter_design").length, 4, "the two batches, and the batch of the weak chapter twice");
  assert.match(insights(events, "designReady")[0].title, /the rounds stopped improving it/);
  const capped = createFakeAutopilotAi({ chapterRubric: (chapter) => (chapter === 9 ? { pace: 4 } : 8), designReview: (round) => revise(5 + round) });
  const used = await run(await describedBook(), capped, START(12, { chapterReview: true }, { maxRounds: 2 }));
  assert.equal(used.state.design.outcome, "rounds");
  assert.equal(used.state.design.rounds.length, 2);
  assert.equal(names(capped).filter((name) => name === "chapter_design").length, 3, "two batches, and the batch of the weak chapter once: the last round only judges");
});

const author = (number) => serializeOutlineChapter({ number, title: `Mine ${number}`, body: `I decided what happens in ${number}.`, origin: "author" });

test("a major finding about a chapter of the author's is a proposal, the autopilot's own chapters are rewritten, and the author's entry is never touched", async () => {
  const store = await describedBook();
  await store.commit([{ path: "outline/chapters/003.md", content: author(3), expectedHash: null }], "author entry");
  const ai = createFakeAutopilotAi({
    coherence: (call) => (call === 1
      ? {
        findings: [
          { severity: "major", kind: "timeline", chapters: [4, 5], requires: [5], text: "The ferry runs on a closed day.", proposal: "Move it a day." },
          { severity: "major", kind: "character", chapters: [3], requires: [3], text: "Mira forgives too quickly.", proposal: "Let her wait a chapter." },
        ],
        summary: "Two things.",
      }
      : { findings: [], summary: "Sound." }),
    designReview: (round) => (round === 1 ? revise(6) : approve),
  });
  const { state, events } = await run(store, ai, START(6, { coherence: true }, { maxRounds: 3 }));
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  assert.equal(store.files.get("outline/chapters/003.md"), author(3), "the author's entry is as the author wrote it");
  const redesign = ai.calls.filter((call) => call.json?.name === "chapter_design").at(-1);
  assert.match(redesign.user, /applying the director's changes:\n- Coherence — Chapter 5: The ferry runs on a closed day\. → Move it a day\.$/m);
  assert.doesNotMatch(redesign.user, /Mira forgives too quickly/, "the author's chapter gets no instruction");
  const told = insights(events, "designProposals");
  assert.equal(told.length, 1);
  assert.equal(told[0].title, "One proposal for a chapter you wrote: the design does not rewrite them");
  assert.deepEqual(told[0].figures, { chapters: 1 });
  assert.match(told[0].detail, /^- Chapter 3: Mira forgives too quickly\. → Let her wait a chapter\.$/);
  const proposed = state.design.coherence.findings.find((entry) => entry.chapters[0] === 3);
  assert.equal(proposed.owner, "author");
  assert.equal(proposed.status, "fixed", "the second analysis no longer finds it, whoever fixed it");
});

test("a critical finding that only the author's entry can answer is asked to the author at once, not after the rounds, and then the design ends with it as guidance", async () => {
  const store = await describedBook();
  await store.commit([{ path: "outline/chapters/002.md", content: author(2), expectedHash: null }], "author entry");
  const ai = createFakeAutopilotAi({
    coherence: () => ({ findings: [{ severity: "critical", kind: "contradiction", chapters: [2], requires: [2], text: "The bell cannot ring in a harbor with no bell.", proposal: "Give the harbor a bell." }], summary: "x" }),
    designReview: () => approve,
  });
  const first = await run(store, ai, START(5, { coherence: true }, { maxRounds: 4 }));
  assert.equal(first.state.status, "waiting-author", first.state.lastError?.message);
  assert.equal(first.state.design.rounds.length, 1, "the first round: the rounds of the policy are not used up before the author is asked");
  assert.equal(first.state.design.escalated, true);
  assert.match(first.state.question.question, /a critical inconsistency the director could not resolve/);
  assert.match(first.state.question.context, /The bell cannot ring in a harbor with no bell\. → Give the harbor a bell\./);
  assert.equal(insights(first.events, "designEscalated").length, 1);
  assert.equal(store.files.get("outline/chapters/002.md"), author(2));
  // The author answers and the autopilot goes on: nothing more can be done for that chapter, so the design ends, and the finding stays open for the author.
  const again = makeSession(store, ai);
  await again.session.answer({ questionId: first.state.question.id, answer: "I will give the harbor a bell myself.", accept: false });
  await again.session.start({});
  await again.session.waitForIdle();
  const state = again.state();
  assert.equal(state.status, "paused", state.lastError?.message);
  assert.equal(state.design.outcome, "rounds");
  assert.equal(state.design.rounds.length, 2);
  assert.ok(state.directorNotes.some((note) => note.includes("The bell cannot ring")));
  assert.equal(state.design.coherence.findings.find((entry) => entry.severity === "critical").status, "open");
  assert.equal(store.files.get("outline/chapters/002.md"), author(2), "never rewritten");
});

test("a design without any of the reviews rewrites only what the director asked: no note of the rewrite is added", async () => {
  const store = await describedBook();
  const ai = createFakeAutopilotAi({ designReview: (round) => (round === 1 ? revise(6, { changes: [{ chapterNumber: 2, instruction: "Make the cost personal." }] }) : approve) });
  const { state } = await run(store, ai, { design: { chapters: 6 }, options: { readersOnPlan: false, pauseAfterPlan: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  const redesign = ai.calls.filter((call) => call.json?.name === "chapter_design").at(-1);
  assert.match(redesign.user, /applying the director's changes:\n- Chapter 2: Make the cost personal\.\n/);
  assert.doesNotMatch(redesign.user, /Coherence —|Weak criterion —/);
  assert.equal(insights([], "designProposals").length, 0);
});
