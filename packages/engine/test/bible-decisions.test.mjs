import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// The decisions of a book (a log, locked by the author only), its open questions, its threads of setup and payoff: read softly, written in order, told to the agents
// and checked against what an edit would change, without a model.

const {
  BIBLE_DECISIONS_FILE,
  answerQuestion,
  askQuestion,
  captureDecision,
  decisionConflictText,
  decisionConflicts,
  decisionsBlock,
  lockedDecisions,
  openQuestions,
  readBibleDecisions,
  readBibleThreads,
  serializeBibleDecisions,
  serializeBibleThreads,
  setDecisionStatus,
} = engine;

const NOW = new Date("2026-11-28T10:00:00.000Z");

const FILE = `---
type: bible
id: bible:decisions
title: Decisions
decisions:
  - id: d-001
    date: 2026-11-20
    decision: Elio is the keeper's son.
    reason: The whole second act depends on it.
    by: author
    status: locked
    chapters: [3, "chapter:007-the-wreck"]
    secrets: [the-wreck]
    files: [characters/elio.md]
    avoid: ["Elio is an orphan"]
  - id: d-002
    decision: Mara leaves in the end
    status: open
    by: brainstorming
  - id: d-003
  - just text
questions:
  - id: q-001
    question: Who sent the letter?
    by: brainstorming
  - id: q-002
    question: Is the lamp cursed?
    answer: No, it is only old.
---

Notes the author keeps here.
`;

test("the log is read softly: ids, days, chapters as numbers or references, what cannot be read said and left out, the notes kept", () => {
  const { value, problems } = readBibleDecisions(FILE);
  assert.deepEqual(value.decisions.map((decision) => [decision.id, decision.status, decision.by, decision.date]), [["d-001", "locked", "author", "2026-11-20"], ["d-002", "open", "brainstorming", ""]]);
  assert.deepEqual(value.decisions[0].chapters, [3, 7]);
  assert.deepEqual(value.decisions[0].avoid, ["Elio is an orphan"]);
  assert.deepEqual(value.questions.map((question) => [question.id, question.status, question.answer]), [["q-001", "open", ""], ["q-002", "answered", "No, it is only old."]]);
  assert.equal(value.notes, "Notes the author keeps here.");
  assert.equal(problems.length, 2, problems.join(" | "));
  assert.deepEqual(lockedDecisions(value).map((decision) => decision.id), ["d-001"]);
  assert.deepEqual(openQuestions(value).map((question) => question.id), ["q-001"]);
  assert.deepEqual(readBibleDecisions(null).value, { decisions: [], questions: [], notes: "" });
  assert.match(readBibleDecisions("---\ndecisions: nope\n---\n").problems.join(), /decisions must be a list/);
});

test("writing the log keeps what the engine does not manage, and reading it back gives the same", () => {
  const existing = `---\ntype: bible\nid: bible:decisions\nmy_key: kept\n---\n\nMy notes.\n`;
  const { value } = readBibleDecisions(FILE);
  const written = serializeBibleDecisions(value, existing);
  assert.match(written, /my_key: kept/);
  assert.deepEqual(readBibleDecisions(written).value.decisions, value.decisions);
  assert.deepEqual(readBibleDecisions(written).value.questions, value.questions);
  assert.equal(readBibleDecisions(serializeBibleDecisions({ decisions: [], questions: [] }, null)).value.decisions.length, 0);
});

test("a decision is captured at the end of the log with the next id; only the author's can come out locked", () => {
  const first = captureDecision(null, { decision: "The sea is never named.", status: "locked" }, NOW);
  assert.ok("content" in first);
  assert.equal(first.decision.id, "d-001");
  assert.equal(first.decision.status, "locked");
  assert.equal(first.decision.date, "2026-11-28");
  const second = captureDecision(first.content, { decision: "Mara is the narrator.", by: "brainstorming", status: "locked", chapters: [1, 2, 2] }, NOW);
  assert.ok("content" in second);
  assert.equal(second.decision.id, "d-002");
  assert.equal(second.decision.status, "open", "an agent never locks");
  assert.deepEqual(second.decision.chapters, [1, 2]);
  assert.deepEqual(readBibleDecisions(second.content).value.decisions.map((decision) => decision.id), ["d-001", "d-002"]);
  assert.deepEqual(captureDecision(null, { decision: "   " }, NOW), { problem: "the decision has no text" });
});

test("a decision is locked and opened again by the author, and a question is asked and answered, as a decision when the author says so", () => {
  const { content } = captureDecision(null, { decision: "Elio is the keeper's son.", by: "copilot" }, NOW);
  const locked = setDecisionStatus(content, "d-001", "locked");
  assert.equal(readBibleDecisions(locked).value.decisions[0].status, "locked");
  assert.equal(readBibleDecisions(setDecisionStatus(locked, "d-001", "open")).value.decisions[0].status, "open");
  assert.equal(setDecisionStatus(content, "d-009", "locked"), null);

  const asked = askQuestion(locked, { question: "Who sent the letter?", by: "brainstorming", chapters: [5] }, NOW);
  assert.ok("content" in asked);
  assert.equal(asked.question.id, "q-001");
  assert.deepEqual(openQuestions(readBibleDecisions(asked.content).value).map((question) => question.id), ["q-001"]);
  const answered = answerQuestion(asked.content, "q-001", "The harbour master.", NOW, { status: "locked" });
  assert.ok("content" in answered);
  const value = readBibleDecisions(answered.content).value;
  assert.deepEqual(value.questions.map((question) => [question.status, question.answer]), [["answered", "The harbour master."]]);
  assert.equal(value.decisions[1].decision, "The harbour master.");
  assert.equal(value.decisions[1].status, "locked");
  assert.deepEqual(value.decisions[1].chapters, [5]);
  assert.deepEqual(answerQuestion(asked.content, "q-009", "x", NOW), { problem: "there is no question q-009" });
});

test("the agents are told the locked decisions as binding and the open questions as not theirs to settle, within a limit", () => {
  const { value } = readBibleDecisions(FILE);
  const block = decisionsBlock(value);
  assert.match(block, /LOCKED DECISIONS/);
  assert.match(block, /d-001: Elio is the keeper's son\. \(why: The whole second act depends on it\.\)/);
  assert.match(block, /Never write: «Elio is an orphan»/);
  assert.doesNotMatch(block, /d-002/, "an open decision does not bind");
  assert.match(block, /OPEN QUESTIONS[\s\S]*q-001: Who sent the letter\?/);
  assert.doesNotMatch(block, /q-002/);
  assert.equal(decisionsBlock({ decisions: [], questions: [], notes: "" }), "");
  assert.ok(decisionsBlock(value, 200).length <= 200);
});

test("a change that touches a locked decision is held: the entry of its chapters, its files and secrets, a forbidden phrase; a change that leaves a file as it was is none", () => {
  const { value } = readBibleDecisions(FILE);
  const conflicts = decisionConflicts([
    { path: "outline/chapters/003.md", before: "A", after: "B" },
    { path: "outline/chapters/004.md", before: "A", after: "B" },
    { path: "secrets/the-wreck.md", before: "A", after: "B" },
    { path: "characters/elio.md", before: "A", after: "A" },
    { path: "characters/mara.md", before: "Mara is brave.", after: "Mara is brave. Elio is an orphan, raised by the harbour." },
    { path: "chapters/003-the-letter/001-scene.md", before: "Elio read.", after: "Elio read the letter." },
    { path: "outline/chapters/007.md", before: null, after: "New entry" },
  ], value);
  assert.deepEqual(conflicts.map((conflict) => [conflict.kind, conflict.path]), [["scope", "outline/chapters/003.md"], ["scope", "secrets/the-wreck.md"], ["avoid", "characters/mara.md"], ["scope", "outline/chapters/007.md"]]);
  assert.equal(conflicts[2].phrase, "Elio is an orphan");
  // The autopilot's bookkeeping on an entry (its digest) says nothing new about the chapter.
  const entry = (extra) => `---\ntitle: The wreck\n${extra}---\n\nWhat happens.\n`;
  assert.deepEqual(decisionConflicts([{ path: "outline/chapters/003.md", before: entry("digest: aaaa\n"), after: entry("digest: bbbb\norigin: autopilot\n") }], value), []);
  assert.deepEqual(decisionConflicts([{ path: "outline/chapters/003.md", before: entry(""), after: entry("design:\n  goal: Change it\n") }], value).length, 1);
  assert.deepEqual(decisionConflicts([{ path: "outline/chapters/003.md", before: "A", after: "B" }], []), []);
  assert.deepEqual(decisionConflicts([{ path: "outline/chapters/003.md", before: "A", after: "B" }], { decisions: value.decisions.map((decision) => ({ ...decision, status: "open" })) }), []);
  // The prose of a chapter is never held for being written, and a phrase that was already there is not new.
  assert.deepEqual(decisionConflicts([{ path: "chapters/003-the-letter/001-scene.md", before: null, after: "Elio walked." }], value), []);
  assert.deepEqual(decisionConflicts([{ path: "notes.md", before: "ELIO IS AN ORPHAN.", after: "Elio is an orphan, still." }], value), []);
  assert.equal(decisionConflicts([{ path: "notes.md", before: null, after: "elio  is an  Órphan" }], value).length, 1, "case, accents and spacing do not matter");
  assert.equal(decisionConflicts([{ path: "notes.md", before: null, after: "Elio is an orphaned boy" }], value).length, 1, "the phrase is found inside a longer text");
});

test("a change that alters or removes a locked decision in the log is held: only the author unlocks", () => {
  const { value } = readBibleDecisions(FILE);
  const unlocked = setDecisionStatus(FILE, "d-001", "open");
  const kept = serializeBibleDecisions({ ...value, notes: "Other notes" }, FILE);
  assert.deepEqual(decisionConflicts([{ path: BIBLE_DECISIONS_FILE, before: FILE, after: unlocked }], value).map((conflict) => conflict.kind), ["unlock"]);
  assert.deepEqual(decisionConflicts([{ path: BIBLE_DECISIONS_FILE, before: FILE, after: null }], value).map((conflict) => conflict.kind), ["unlock"]);
  assert.deepEqual(decisionConflicts([{ path: BIBLE_DECISIONS_FILE, before: FILE, after: kept }], value), []);
  const added = captureDecision(FILE, { decision: "Another one", by: "copilot" }, NOW);
  assert.deepEqual(decisionConflicts([{ path: BIBLE_DECISIONS_FILE, before: FILE, after: added.content }], value), []);
});

test("a conflict is told in English and in Italian, with the decision and what to do", () => {
  const { value } = readBibleDecisions(FILE);
  const [scope] = decisionConflicts([{ path: "outline/chapters/003.md", before: "A", after: "B" }], value);
  assert.match(decisionConflictText(scope, "en"), /entry of chapter 3[\s\S]*locked decision d-001[\s\S]*Elio is the keeper's son/);
  assert.match(decisionConflictText(scope, "it"), /voce del capitolo 3[\s\S]*decisione bloccata d-001/);
  const [avoid] = decisionConflicts([{ path: "notes.md", before: null, after: "Elio is an orphan" }], value);
  assert.match(decisionConflictText(avoid, "en"), /forbids/);
  assert.match(decisionConflictText(avoid, "it"), /vieta/);
  const [unlock] = decisionConflicts([{ path: BIBLE_DECISIONS_FILE, before: FILE, after: null }], value);
  assert.match(decisionConflictText(unlock, "en"), /only the author unlocks/);
  assert.match(decisionConflictText(unlock, "it"), /solo l'autore/);
});

test("the threads of setup and payoff are read softly and written back as they are", () => {
  const file = `---
type: bible
id: bible:threads
threads:
  - id: t-001
    title: The keeper's lamp
    setup: { chapter: 2, note: It is lit at noon. }
    payoff: { chapter: "chapter:012-the-light", note: It goes out. }
    status: paid
  - id: t-002
    title: The letter
    setup: { chapter: 4 }
  - id: t-003
  - id: t-001
    title: Twice
---

Notes.
`;
  const { value, problems } = readBibleThreads(file);
  assert.deepEqual(value.threads.map((thread) => [thread.id, thread.status, thread.setup?.chapter, thread.payoff?.chapter]), [["t-001", "paid", 2, 12], ["t-002", "open", 4, undefined]]);
  assert.equal(value.notes, "Notes.");
  assert.equal(problems.length, 2, problems.join(" | "));
  assert.deepEqual(readBibleThreads(serializeBibleThreads(value, file)).value.threads, value.threads);
  assert.deepEqual(readBibleThreads(null).value.threads, []);
});
