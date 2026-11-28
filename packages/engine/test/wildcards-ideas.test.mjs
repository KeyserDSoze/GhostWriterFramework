import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";

// What the room gives, as records: every one advisory, never a score; what a voice gives beyond the cap is counted, never dropped in silence; and the journal
// of the room (`bible/ideas.yml`) keeps every consultation and the latest decision of each idea, mergeable between devices, with what a later version adds.

const {
  IDEAS_JOURNAL_FILE, IDEAS_JOURNAL_KEEP_DAYS, WILDCARD_MAX_IDEAS_PER_VOICE, WILDCARD_IDEAS_TOOL, appendIdeasJournal, builtinWildcards, isAcceptedDecision,
  mergeIdeasJournals, parseIdeasJournal, pruneIdeasJournal, readWildcardReply, rejectedIdeas, serializeIdeasJournal, wildcardStableId,
} = engine;

const NOW = new Date("2026-11-28T08:00:00.000Z");
const persona = (slug) => builtinWildcards("en").find((profile) => profile.slug === slug);
const target = { kind: "chapter", label: "Chapter 3: The harbour", chapter: 3 };

test("the reply of a voice: each item with an idea is a record, advisory and without a score; an item without one is counted as invalid; beyond the cap counted as omitted", () => {
  const items = [
    { title: "Tell it from the lighthouse", idea: "The lighthouse narrates the night.", why: "Nobody expects it.", changes: "Chapter 3 becomes a monologue.", chapters: [3, "chapter 7", 0, -2, "x"], secrets: "the letter, the debt", risk: "Too odd for some.", audacity: 14 },
    { title: "No idea here" },
    { idea: "An item without a title gets one from its idea, and no audacity takes the persona's." },
    ...Array.from({ length: WILDCARD_MAX_IDEAS_PER_VOICE }, (_, index) => ({ title: `Extra ${index}`, idea: `Idea ${index}`, why: "w", changes: "c", risk: "r", audacity: 5 })),
  ];
  const reading = readWildcardReply({ items, note: "Two were bold." }, persona("subversive"), { target, consultation: "c1" });
  assert.equal(reading.invalid, 1);
  assert.equal(reading.ideas.length, WILDCARD_MAX_IDEAS_PER_VOICE);
  assert.equal(reading.omitted, 2);
  assert.equal(reading.note, "Two were bold.");
  const [first, second] = reading.ideas;
  assert.equal(first.kind, "idea");
  assert.equal(first.advisory, true);
  assert.equal(first.audacity, 10);
  assert.deepEqual(first.changes, { chapters: [3, 7], secrets: ["the letter", "the debt"], summary: "Chapter 3 becomes a monologue." });
  assert.equal("score" in first, false);
  assert.equal(second.title.startsWith("An item without a title"), true);
  assert.equal(second.audacity, persona("subversive").audacity);
  // The same reply read again gives the same ids.
  assert.deepEqual(readWildcardReply({ items }, persona("subversive"), { target, consultation: "c1" }).ideas.map((idea) => idea.id), reading.ideas.map((idea) => idea.id));
  assert.notDeepEqual(readWildcardReply({ items }, persona("subversive"), { target, consultation: "c2" }).ideas.map((idea) => idea.id), reading.ideas.map((idea) => idea.id));
});

test("a sentinel gives findings with their evidence and severity; a reply that is a bare list or nothing at all is read", () => {
  const reading = readWildcardReply([{ title: "Spoiler", idea: "The letter is named before its time.", why: "Breaks reveal_in.", changes: "Cut one line.", risk: "None.", audacity: 1, evidence: "«the letter from Marta»", severity: "Critical" }], persona("secrets-guardian"), { target, consultation: "c3" });
  assert.equal(reading.ideas[0].kind, "finding");
  assert.equal(reading.ideas[0].severity, "critical");
  assert.equal(reading.ideas[0].evidence, "«the letter from Marta»");
  assert.deepEqual(readWildcardReply("not json", persona("poet"), { target, consultation: "c4" }), { ideas: [], invalid: 0, omitted: 0 });
  assert.deepEqual(WILDCARD_IDEAS_TOOL.parameters.required, ["items"]);
  // No field of a reply is a score: nothing the room says can gate a step.
  assert.equal(Object.keys(WILDCARD_IDEAS_TOOL.parameters.properties.items.items.properties).some((key) => /score|vote|grade/i.test(key)), false);
  assert.match(wildcardStableId("same"), /^[0-9a-f]{16}$/);
  assert.equal(wildcardStableId("same"), wildcardStableId("same"));
});

function entry(id, at, ideas, extra = {}) {
  return { id, at, by: "author", target, preset: "creative-room", voices: ["subversive"], ideas, ...extra };
}
function idea(id, decision) {
  return { id, kind: "idea", persona: { id: "wildcard:subversive", slug: "subversive", name: "The Subversive", group: "provocateur" }, title: `Idea ${id}`, idea: `Text of ${id}`, why: "w", changes: { chapters: [3], secrets: [], summary: "s" }, risk: "r", audacity: 7, advisory: true, ...(decision ? { decision } : {}) };
}

test("the journal of the room: written, read again the same, with a header that says nothing is applied by itself", () => {
  const text = appendIdeasJournal(null, entry("c1", "2026-11-27T10:00:00.000Z", [idea("i1", { verdict: "adopted", reason: "It lifts the chapter.", by: "director", at: "2026-11-27T10:05:00.000Z" })]), NOW);
  assert.equal(IDEAS_JOURNAL_FILE, "bible/ideas.yml");
  assert.match(text, /^# The journal of the room/);
  assert.match(text, /Nothing here is applied by itself/);
  assert.match(text, /^version: 1$/m);
  const read = parseIdeasJournal(text);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].ideas[0].decision.verdict, "adopted");
  assert.equal(serializeIdeasJournal(read), text);
  assert.ok(isAcceptedDecision(read.entries[0].ideas[0].decision));
  assert.equal(isAcceptedDecision({ verdict: "rejected", reason: "", by: "author", at: NOW.toISOString() }), false);
});

test("two copies merge: every consultation once, and an idea decided on two devices keeps the latest decision", () => {
  const first = appendIdeasJournal(null, entry("c1", "2026-11-27T10:00:00.000Z", [idea("i1"), idea("i2")]), NOW);
  const here = appendIdeasJournal(first, entry("c1", "2026-11-27T10:00:00.000Z", [idea("i1", { verdict: "rejected", reason: "Too far.", by: "author", at: "2026-11-27T11:00:00.000Z" })]), NOW);
  const there = appendIdeasJournal(first, { ...entry("c1", "2026-11-27T10:00:00.000Z", [idea("i1", { verdict: "adapted", reason: "Kept the image only.", by: "author", at: "2026-11-27T12:00:00.000Z", adaptation: "Only the image." })]) }, NOW);
  const other = appendIdeasJournal(there, entry("c2", "2026-11-28T07:00:00.000Z", [idea("i9")]), NOW);
  const merged = mergeIdeasJournals(here, other);
  assert.deepEqual(merged.entries.map((value) => value.id), ["c1", "c2"]);
  const decided = merged.entries[0].ideas.find((value) => value.id === "i1").decision;
  assert.equal(decided.verdict, "adapted");
  assert.equal(decided.adaptation, "Only the image.");
  assert.equal(merged.entries[0].ideas.length, 2);
  assert.deepEqual(mergeIdeasJournals(other, here), merged);
});

test("what a later version adds is kept: unknown keys of a consultation and of an idea survive a read and a write", () => {
  const text = [
    "version: 7",
    "future: top-level is not kept, but nothing breaks",
    "entries:",
    "  - id: c1",
    "    at: 2026-11-27T10:00:00.000Z",
    "    by: author",
    "    target: { kind: chapter, label: Chapter 3, chapter: 3 }",
    "    voices: [subversive]",
    "    mood: tense",
    "    ideas:",
    "      - id: i1",
    "        kind: idea",
    "        persona: { id: wildcard:subversive, slug: subversive, name: The Subversive, group: provocateur }",
    "        title: T",
    "        idea: The idea",
    "        why: w",
    "        changes: { chapters: [3], secrets: [], summary: s }",
    "        risk: r",
    "        audacity: 7",
    "        weight: 0.5",
    "  - id: broken",
    "    at: not a date",
    "    by: author",
  ].join("\n");
  const read = parseIdeasJournal(text);
  assert.equal(read.entries.length, 1);
  assert.deepEqual(read.entries[0].extra, { mood: "tense" });
  assert.deepEqual(read.entries[0].ideas[0].extra, { weight: 0.5 });
  const written = serializeIdeasJournal(read);
  assert.match(written, /mood: tense/);
  assert.match(written, /weight: 0.5/);
  assert.deepEqual(parseIdeasJournal("::: not yaml :::"), { entries: [] });
  assert.deepEqual(parseIdeasJournal(""), { entries: [] });
});

test("pruned to the last year, and the rejected ideas are given back newest first so the room does not propose them again", () => {
  const old = new Date(NOW.getTime() - (IDEAS_JOURNAL_KEEP_DAYS + 1) * 86_400_000).toISOString();
  const journal = mergeIdeasJournals(
    { entries: [entry("old", old, [idea("o1", { verdict: "rejected", reason: "old", by: "author", at: old })])] },
    { entries: [entry("c1", "2026-11-27T10:00:00.000Z", [idea("a", { verdict: "rejected", reason: "no", by: "director", at: "2026-11-27T10:00:00.000Z" }), idea("b", { verdict: "rejected", reason: "no", by: "author", at: "2026-11-27T11:00:00.000Z" }), idea("c", { verdict: "adopted", reason: "yes", by: "author", at: "2026-11-27T12:00:00.000Z" })])] },
  );
  assert.deepEqual(pruneIdeasJournal(journal, NOW).entries.map((value) => value.id), ["c1"]);
  assert.deepEqual(rejectedIdeas(journal, 2), ["Idea b", "Idea a"]);
});
