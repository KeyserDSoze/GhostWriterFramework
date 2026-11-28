import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// What the writing autopilot reads of the design of the book (Phase 5 of #108, item 3 of #125): the design of each chapter in the plan of its scenes, its writing, the
// specialists and the director's review; the ledgers of the secrets as the spoiler guards of each chapter; the rules of the world and the themes of the Bible; the entries
// around a chapter in full; and a design that binds when the author approved it (or wrote it).

const {
  AutopilotSession,
  chapterSpoilerGuards,
  chapterDesignBlock,
  designApproved,
  neighbourEntriesSection,
  otherEntriesSection,
  readDesignApproval,
  parseAutopilotState,
  parseMarkdown,
  renderMarkdown,
  readOutlineChapter,
  serializeOutlineChapter,
  writeOutlineBrief,
} = engine;

const STATE = "autopilot/state.json";
const clock = () => new Date("2026-11-28T07:00:00.000Z");
const stateOf = (store) => parseAutopilotState(store.files.get(STATE));
const entryPath = (number) => `outline/chapters/${String(number).padStart(3, "0")}.md`;

async function run(store, ai, start) {
  const session = new AutopilotSession({ bookId: "book", store, ai, host: "browser", hostLabel: "test", retryDelayMs: 0, now: clock });
  await session.start(start);
  await session.waitForIdle();
  return stateOf(store);
}

const LEDGER = {
  slug: "the-wall-is-failing",
  name: "The Wall Is Failing",
  reveal: 3,
  holders: ["Orrin Hale"],
  ledger: {
    learnedBy: [{ character: "character:mira-vale", chapter: 3 }, { character: "Tessa", chapter: 2 }],
    readerKnows: [{ chapter: 1, note: "Something is wrong with the sea wall." }, { chapter: 2, note: "The council hides the repairs." }],
    clues: [{ chapter: 1, note: "Salt water in the cellar." }, { chapter: 2, note: "A wet ledger." }],
    redHerrings: [{ chapter: 2, note: "The storms are blamed." }],
    consequences: ["The town turns on the council"],
  },
};
const mira = (character) => (character === "character:mira-vale" ? "Mira Vale" : character);

test("the spoiler guards of a chapter: what the reader knows by then, who knows the secret and who learns it later, what to plant there, the consequences after the reveal", () => {
  const one = chapterSpoilerGuards([LEDGER], 1, mira);
  assert.equal(one, [
    "SPOILER GUARDS FOR CHAPTER 1 (from the ledgers of the secrets: they bind):",
    "- «The Wall Is Failing»: HIDDEN until chapter 3: do not reveal it here.",
    "  The reader knows by now: Something is wrong with the sea wall.",
    "  Who knows it by now: Orrin Hale",
    "  Not yet (they must not act on it here): Mira Vale (learns it in chapter 3), Tessa (learns it in chapter 2)",
    "  Clues to plant here: Salt water in the cellar.",
  ].join("\n"));
  const two = chapterSpoilerGuards([LEDGER], 2, mira);
  assert.match(two, /The reader knows by now: The council hides the repairs\./);
  assert.match(two, /Who knows it by now: Orrin Hale, Tessa\n/);
  assert.match(two, /Clues to plant here: A wet ledger\.\n  Red herrings to plant here: The storms are blamed\./);
  const three = chapterSpoilerGuards([LEDGER], 3, mira);
  assert.match(three, /«The Wall Is Failing»: revealed to the reader in THIS chapter\./);
  assert.match(three, /Consequences to set in motion: The town turns on the council/);
  assert.doesNotMatch(three, /Not yet/);
  assert.match(chapterSpoilerGuards([LEDGER], 5, mira), /revealed to the reader in chapter 3\.[\s\S]*Consequences in effect: The town turns on the council/);
  assert.equal(chapterSpoilerGuards([{ ...LEDGER, ledger: { learnedBy: [], readerKnows: [], clues: [], redHerrings: [], consequences: [] }, holders: [] }], 1), "", "a secret with nothing for the chapter says nothing more than the reveal rules");
  // A tight budget keeps what belongs in the chapter, and says how many it left out.
  const far = Array.from({ length: 12 }, (_, index) => ({ ...LEDGER, slug: `s${index}`, name: `Secret ${index}`, reveal: 40 + index, ledger: { ...LEDGER.ledger, clues: [{ chapter: 30, note: "Elsewhere." }], redHerrings: [] } }));
  const tight = chapterSpoilerGuards([...far, LEDGER], 2, mira, 1200);
  assert.ok(tight.length <= 1400, `${tight.length}`);
  assert.match(tight, /«The Wall Is Failing»/);
  assert.match(tight, /more secrets far from this chapter not listed/);
});

test("the design of a chapter binds when it is the author's or the author approved it; one the design run proposed is followed unless the story contradicts it", () => {
  const design = { goal: "Mira finds the crack.", scenes: ["The dive", "The shard"], cliffhanger: true, notes: "Keep it cold." };
  const author = { number: 4, intact: false, design };
  assert.equal(chapterDesignBlock(author, false), [
    "THE DESIGN OF CHAPTER 4 (the author's: it binds the chapter; write what it plans):",
    "Narrative goal: Mira finds the crack.",
    "Planned scenes:\n- The dive\n- The shard",
    "Cliffhanger: yes",
    "Notes for the ghostwriter: Keep it cold.",
  ].join("\n"));
  assert.match(chapterDesignBlock({ ...author, intact: true }, true), /^THE DESIGN OF CHAPTER 4 \(approved by the author: it binds the chapter/);
  assert.match(chapterDesignBlock({ ...author, intact: true }, false), /^THE DESIGN OF CHAPTER 4 \(proposed by the design run, not approved yet: follow it unless the story so far contradicts it\)/);
  assert.equal(chapterDesignBlock({ number: 4, intact: false }, true), "");
  const approval = readDesignApproval({ design_approved: { at: "2026-11-28T06:00:00.000Z", run: "2026-11-27T10:00:00.000Z" } });
  assert.deepEqual(approval, { at: "2026-11-28T06:00:00.000Z", run: "2026-11-27T10:00:00.000Z" });
  assert.equal(readDesignApproval({ design_approved: "yes" }), null);
  assert.equal(designApproved(approval, { design: { startedAt: "2026-11-27T10:00:00.000Z" } }), true);
  assert.equal(designApproved(approval, { design: { startedAt: "2026-11-28T01:00:00.000Z" } }), false, "the approval of another design run");
  assert.equal(designApproved(approval, null), true);
  assert.equal(designApproved(null, null), false);
});

test("the entries around a chapter: the one before and the one after in full, the others as a line each, the nearest kept first", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ number: index + 1, title: `T${index + 1}`, body: `${"x".repeat(50)} chapter ${index + 1}`, intact: false, design: index === 4 ? { ending: "A door closes.", next: "The flood." } : undefined }));
  const around = neighbourEntriesSection(entries, 6);
  assert.match(around, /^THE CHAPTER BEFORE IN THE SYNOPSIS — Chapter 5 «T5»:\nx+ chapter 5\nSets up for later chapters: The flood\.\nEnding: A door closes\./);
  assert.match(around, /THE CHAPTER AFTER IN THE SYNOPSIS \(set it up, do not tell it\) — Chapter 7 «T7»:/);
  const others = otherEntriesSection(entries, 6, 600);
  assert.match(others, /^THE OTHER CHAPTERS OF THE SYNOPSIS \(summaries; 19 far from this chapter left out\):\n1\. T1 — /);
  assert.match(others, /^4\. T4 — [\s\S]*^8\. T8 — /m, "the nearest are kept");
  assert.doesNotMatch(others, /^(5|6|7)\. /m, "the chapter and its neighbours are not repeated");
  assert.doesNotMatch(others, /^30\. /m, "the farthest is what a tight budget leaves out");
});

/** A book designed by the design run (two chapters), with its secret's ledger, the rules of the world and the themes. */
async function designedBook() {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 0, title: "The Glass Harbor" }));
  await writeOutlineBrief(store, { idea: "A harbor town built on glass hides a lie that the tide will tell.", genre: "mystery", audience: "adults", wordsPerScene: 200 });
  const ai = createFakeAutopilotAi();
  const state = await run(store, ai, { design: { chapters: 2 }, options: { readersOnPlan: false, pauseAfterPlan: false, readers: false } });
  assert.equal(state.design.outcome, "target", state.lastError?.message);
  return { store, state };
}

function approve(store, run) {
  const path = "outline/book.md";
  const document = parseMarkdown(store.files.get(path));
  store.files.set(path, renderMarkdown({ ...document.frontmatter, design_approved: { at: "2026-11-28T07:00:00.000Z", run } }, document.body));
}

test("an approved design reaches every step that writes a chapter: its design, its spoiler guards and the rules of the world, in the scenes, the writing, the specialists and the director", async () => {
  const { store, state } = await designedBook();
  approve(store, state.design.startedAt);
  const ai = createFakeAutopilotAi();
  const written = await run(store, ai, { limits: { chapters: 1 }, options: { readers: false } });
  assert.notEqual(written.status, "error", written.lastError?.message);
  const call = (label) => ai.calls.find((entry) => entry.label.startsWith(label));
  for (const label of ["autopilot:scenes:1", "autopilot:write:1.1", "autopilot:specialists:1", "autopilot:director-review:1"]) {
    const asked = call(label);
    assert.ok(asked, label);
    assert.match(asked.user, /THE DESIGN OF CHAPTER 1 \(approved by the author: it binds the chapter; write what it plans\):\nNarrative goal: Goal of chapter 1\./, label);
    assert.match(asked.user, /Planned scenes:\n- Scene A of chapter 1\n- Scene B of chapter 1/, label);
    assert.match(asked.user, /SPOILER GUARDS FOR CHAPTER 1 \(from the ledgers of the secrets: they bind\):\n- «The Wall Is Failing»: HIDDEN until chapter 2: do not reveal it here\./, label);
    assert.match(asked.user, /Clues to plant here: Salt water in the cellar\.\n  Red herrings to plant here: The storms are blamed\./, label);
    assert.match(asked.user, /Not yet \(they must not act on it here\): Mira Vale \(learns it in chapter 2\)/, label);
    assert.match(asked.user, /RULES OF THE WORLD \(never break them\):\n- Glass is the only trade that matters/, label);
    assert.match(asked.user, /THEMES, TONE AND AUDIENCE \(serve them\):\nThemes: truth; inheritance\nTone: Melancholic, tense/, label);
  }
  assert.match(call("autopilot:scenes:1").user, /the scenes carry it out: its planned scenes/);
  assert.match(call("autopilot:scenes:1").user, /THE CHAPTER AFTER IN THE SYNOPSIS \(set it up, do not tell it\) — Chapter 2 «Chapter Title 2»:\nSummary of chapter 2\./);
  assert.match(call("autopilot:write:1.1").user, /Write what the design of the chapter plans for this scene/);
  assert.match(call("autopilot:specialists:1").user, /a character acting on a secret before learning it/);
  assert.match(call("autopilot:director-review:1").user, /Judge the chapter against its design, the spoiler guards and the rules of the world/);
});

test("a design nobody approved is followed as a proposal, the reveal chapter is told so, and a book without a design is asked what it always was", async () => {
  const { store } = await designedBook();
  const ai = createFakeAutopilotAi();
  await run(store, ai, { limits: { chapters: 2 }, options: { readers: false, specialists: false } });
  const scenes = ai.calls.filter((entry) => entry.label.startsWith("autopilot:scenes:"));
  assert.match(scenes[0].user, /THE DESIGN OF CHAPTER 1 \(proposed by the design run, not approved yet: follow it unless the story so far contradicts it\)/);
  assert.match(scenes[1].user, /«The Wall Is Failing»: revealed to the reader in THIS chapter\.[\s\S]*Consequences to set in motion: The town turns on the council/);
  assert.match(scenes[1].user, /THE CHAPTER BEFORE IN THE SYNOPSIS — Chapter 1 «Chapter Title 1»:\nSummary of chapter 1\.\nMain events:\n- Event 1\nSets up for later chapters: Sets up chapter 2\.\nEnding: Chapter 1 ends on a door closing\.\nCliffhanger: yes/);
  // A book of the author's without designs, secrets or a Bible: none of it.
  const plain = new MemoryBookStore(seedBookFiles({ chapters: 2 }));
  const plainAi = createFakeAutopilotAi();
  await run(plain, plainAi, { brief: { idea: "A plain book.", wordsPerScene: 200 }, limits: { chapters: 1 }, options: { readers: false, specialists: false, pauseAfterPlan: false } });
  const asked = plainAi.calls.find((entry) => entry.label === "autopilot:scenes:1");
  assert.doesNotMatch(asked.user, /THE DESIGN OF CHAPTER|SPOILER GUARDS|RULES OF THE WORLD/);
  assert.match(asked.user, /THE CHAPTER AFTER IN THE SYNOPSIS \(set it up, do not tell it\) — Chapter 2 «Chapter Title 2»:\nEvent 2 happens and the story turns\./, "the entries around it reach the plan of the scenes");
});

test("a replan after a change of the design carries the design forward: the new entry's design is in the request, and what the reply leaves out of the plan the design says", async () => {
  const store = new MemoryBookStore(seedBookFiles({ chapters: 3 }));
  const ai = createFakeAutopilotAi();
  await run(store, ai, { brief: { idea: "A book.", wordsPerScene: 200 }, options: { pauseAfterPlan: true } });
  assert.equal(stateOf(store).plan.approved, true);
  // The author designs chapter 3 in the Synopsis: its entry changes, and nothing of it is written.
  const { entry } = await readOutlineChapter(entryPath(3), 3, store.files.get(entryPath(3)));
  await store.commit([{ path: entryPath(3), content: serializeOutlineChapter({ number: 3, title: entry.title, body: entry.body, design: { goal: "Mira chooses the town.", pov: ["Orrin Hale"], events: ["Orrin opens the sluice"], reveals: ["The Wall Is Failing"] }, origin: "author", frontmatter: entry.frontmatter }), expectedHash: entry.hash }], "The author designs chapter 3");
  const replanAi = createFakeAutopilotAi({
    completion: undefined,
  });
  const original = replanAi.complete.bind(replanAi);
  replanAi.complete = async (request) => {
    const response = await original(request);
    // The architect leaves the point of view, the events and the reveals out of the plan of chapter 3: the design fills them.
    if (request.label === "autopilot:replan:3") {
      const json = { chapters: [{ number: 3, title: "Chapter Title 3", summary: "Orrin's choice.", goal: "", pov: [], keyEvents: [], reveals: [] }] };
      return { ...response, json, text: JSON.stringify(json) };
    }
    return response;
  };
  await run(store, replanAi, { limits: { chapters: 3 }, options: { readers: false, specialists: false } });
  const replan = replanAi.calls.find((call) => call.label === "autopilot:replan:3");
  assert.ok(replan, replanAi.calls.map((call) => call.label).join(", "));
  assert.match(replan.user, /THE DESIGN OF CHAPTER 3 \(the author's: it binds the chapter; write what it plans\):\nNarrative goal: Mira chooses the town\./);
  assert.match(replan.user, /the plan carries it forward/);
  const chapter = stateOf(store).plan.chapters.find((item) => item.number === 3);
  assert.equal(chapter.goal, "Mira chooses the town.");
  assert.deepEqual(chapter.pov, ["Orrin Hale"]);
  assert.deepEqual(chapter.keyEvents, ["Orrin opens the sluice"]);
  assert.deepEqual(chapter.reveals, ["The Wall Is Failing"]);
});

test("the plan reads the entries of its batch with their designs, and the chapter before and after the batch in full", async () => {
  const files = seedBookFiles({ chapters: 0 });
  for (let number = 1; number <= 24; number += 1) files[entryPath(number)] = serializeOutlineChapter({ number, title: `Entry ${number}`, body: `${"Long text of the entry. ".repeat(40)}End of ${number}.`, ...(number === 2 ? { design: { ending: "On the pier." } } : {}), origin: "author" });
  const store = new MemoryBookStore(files);
  const ai = createFakeAutopilotAi();
  await run(store, ai, { brief: { idea: "A long book.", wordsPerScene: 200 }, options: { pauseAfterPlan: true, readersOnPlan: false } });
  const plans = ai.calls.filter((call) => call.label === "autopilot:plan");
  assert.ok(plans.length >= 2, `${plans.length}`);
  assert.match(plans[0].user, /Chapter 2 «Entry 2»:\n(Long text of the entry\. )+End of 2\.\nIts design:\nEnding: On the pier\./, "an entry of the batch is whole, with its design");
  const second = plans[1].user;
  const from = Number(/numbered (\d+) to/.exec(second)[1]);
  assert.match(second, new RegExp(`AUTHOR'S OUTLINE, THE CHAPTER BEFORE THESE \\(binding\\):\\nChapter ${from - 1} «Entry ${from - 1}»:\\n(Long text of the entry\\. )+End of ${from - 1}\\.`));
});

test("the estimate counts the entries around a chapter only when they say something: entries without words, or no outline, change nothing in the plan of the scenes", () => {
  const base = { language: "en", progress: { planned: 14, conceptDone: true }, options: { readers: false, specialists: false } };
  const without = engine.estimateAutopilotRun(base);
  const empty = engine.estimateAutopilotRun({ ...base, outline: { entries: 14, lastChapter: 14, words: 0 } });
  assert.deepEqual(empty.steps.scenes.inputTokens, without.steps.scenes.inputTokens);
  const written = engine.estimateAutopilotRun({ ...base, outline: { entries: 14, lastChapter: 14, words: 14 * 120 } });
  assert.ok(written.steps.scenes.inputTokens.max > without.steps.scenes.inputTokens.max, "the entries before and after a chapter, and the others a line each");
  const designed = engine.estimateAutopilotRun({ ...base, context: { chapterDesignWords: 300 } });
  assert.ok(designed.steps.write.inputTokens.max > without.steps.write.inputTokens.max, "the design of a chapter reaches the writer");
  assert.ok(designed.steps["director-review"].inputTokens.max > without.steps["director-review"].inputTokens.max);
});
