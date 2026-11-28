import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore, createFakeAutopilotAi, seedBookFiles } from "../dist/testing/index.js";

// A consultation of the room from a book: the wildcards of the book (built-in, the account's, the book's files), the material of the target, the context
// every voice shares, and the secrets each voice may know. Nothing is written: a book that never used the room stays as it was.

const {
  IDEAS_JOURNAL_FILE, appendIdeasJournal, consultWildcards, decideWildcardIdeas, emptyWildcard, loadBookSnapshot, loadWildcardPanel, mergeBookFileVersions,
  parseIdeasJournal, serializeWildcard, wildcardMaterial, wildcardRoomSecrets, wildcardTargetLabel,
} = engine;

const chapterRef = (number) => `chapter:${String(number).padStart(3, "0")}-ch`;
const secret = (name, reveal, truth) => `---\ntype: secret\nid: secret:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}\ntitle: ${name}\nreveal_in: ${chapterRef(reveal)}\n---\n\n# ${name}\n\n${truth}\n`;
const chapter = (number, title) => `---\ntype: chapter\nid: chapter:${String(number).padStart(3, "0")}-ch\nnumber: ${number}\ntitle: ${title}\nsummary: Summary of ${title}.\n---\n\n# ${title}\n`;
const scene = (number, title, body) => `---\ntype: paragraph\nnumber: ${number}\ntitle: ${title}\n---\n\n${body}\n`;

function book(extra = {}) {
  return new MemoryBookStore({
    ...seedBookFiles({ title: "The Glass Harbor" }),
    "characters/mira-vale.md": "---\ntype: character\nid: character:mira-vale\nname: Mira Vale\nsummary: A stubborn young glassmaker.\n---\n\nMira.\n",
    "secrets/the-debt.md": secret("The Debt", 1, "Orrin owes the council a fortune."),
    "secrets/the-wall.md": secret("The Wall Is Failing", 9, "The sea wall cracked years ago."),
    "chapters/001-ch/chapter.md": chapter(1, "Arrival"),
    "chapters/001-ch/001-quay.md": scene(1, "The Quay", "Mira stepped on the quay while the tide came in."),
    "chapters/002-ch/chapter.md": chapter(2, "The Harbour"),
    "chapters/002-ch/001-office.md": scene(1, "The Office", "Orrin smiled behind his desk, the ledger closed."),
    "chapters/002-ch/002-night.md": scene(2, "The Night", "The wind carried salt across the stone steps of the old town."),
    ...extra,
  });
}

test("the wildcards of a book: the built-in ones, changed and added to by the author's account and by the book's files", async () => {
  const poet = serializeWildcard({ ...engine.builtinWildcards("en").find((profile) => profile.slug === "poet"), enabled: false });
  const lawyer = serializeWildcard({ ...emptyWildcard("en", "sentinel"), id: "wildcard:custom:lawyer", slug: "lawyer", name: "The Lawyer", domain: "criminal law" });
  const store = book({ "wildcards/poet.md": poet, "wildcards/lawyer.md": lawyer, "wildcards/notes/ignored.md": "nested files are not wildcards" });
  const snapshot = await loadBookSnapshot(store);
  const account = [{ ...emptyWildcard("en"), id: "wildcard:custom:hacker", slug: "hacker", name: "The Hacker" }];
  const panel = await loadWildcardPanel(store, snapshot, { account });
  assert.equal(panel.length, 16);
  assert.equal(panel.find((profile) => profile.slug === "poet").enabled, false);
  assert.equal(panel.find((profile) => profile.slug === "poet").builtin, true);
  assert.equal(panel.find((profile) => profile.slug === "lawyer").source, "book");
  assert.equal(panel.find((profile) => profile.slug === "lawyer").path, "wildcards/lawyer.md");
  assert.equal(panel.find((profile) => profile.slug === "hacker").source, "account");
  // A book without any file of the room has the fourteen built-in ones.
  assert.equal((await loadWildcardPanel(book(), await loadBookSnapshot(book()))).length, 14);
});

test("the secrets a voice may know: the threshold lists only those already revealed at the chapter; the author's list every one with its rule", async () => {
  const store = book();
  const snapshot = await loadBookSnapshot(store);
  const atTwo = await wildcardRoomSecrets(store, snapshot, 2);
  assert.match(atTwo.threshold, /The Debt: revealed in chapter 1\.\n {2}Truth: Orrin owes the council a fortune\./);
  assert.doesNotMatch(atTwo.threshold, /Wall|sea wall/);
  assert.match(atTwo.author, /The Wall Is Failing: HIDDEN until chapter 9/);
  assert.match(atTwo.author, /sea wall cracked/);
  assert.match((await wildcardRoomSecrets(store, snapshot, 1)).threshold, /The Debt: revealed in this chapter/);
  // Without a chapter (a plan, a conversation) nothing is reached.
  assert.equal((await wildcardRoomSecrets(store, snapshot)).threshold, "");
  assert.deepEqual(await wildcardRoomSecrets(new MemoryBookStore(seedBookFiles()), await loadBookSnapshot(new MemoryBookStore(seedBookFiles())), 3), { threshold: "", author: "" });
});

test("the material of each target, and how a person names it in the language of the book", async () => {
  const store = book();
  const snapshot = await loadBookSnapshot(store);
  const chapterText = await wildcardMaterial(store, snapshot, { kind: "chapter", label: "", chapter: 2 });
  assert.match(chapterText, /=== SCENE 1: The Office ===[\s\S]*=== SCENE 2: The Night ===/);
  const sceneText = await wildcardMaterial(store, snapshot, { kind: "paragraph", label: "", chapter: 2, paragraph: 2 });
  assert.match(sceneText, /END OF THE PREVIOUS SCENE:\n.*ledger closed/);
  assert.match(sceneText, /=== SCENE 2: The Night ===/);
  const selection = await wildcardMaterial(store, snapshot, { kind: "selection", label: "", chapter: 2, paragraph: 2 }, "salt across the stone");
  assert.match(selection, /^THE SELECTED PASSAGE:\nsalt across the stone/);
  assert.match(selection, /THE SCENE IT IS IN/);
  assert.match(await wildcardMaterial(store, snapshot, { kind: "book", label: "" }), /1\. Arrival — Summary of Arrival\.\n2\. The Harbour/);
  assert.equal(await wildcardMaterial(store, snapshot, { kind: "plan", label: "" }, "  The plan.  "), "The plan.");
  assert.equal(wildcardTargetLabel({ kind: "paragraph", chapter: 2, paragraph: 1 }, snapshot), "Chapter 2: The Harbour, scene 1: The Office");
  const italian = { ...snapshot, book: { ...snapshot.book, language: "it" } };
  assert.equal(wildcardTargetLabel({ kind: "chapter", chapter: 2 }, italian), "Capitolo 2: The Harbour");
  assert.equal(wildcardTargetLabel({ kind: "selection", chapter: 2, paragraph: 2 }, italian), "Selezione — Capitolo 2: The Harbour, scena 2: The Night");
});

test("a consultation: the voices of a preset, each told what it may know; the ideas rejected before; nothing written to the book", async () => {
  const rejected = appendIdeasJournal(null, {
    id: "room-old", at: "2026-11-20T10:00:00.000Z", by: "author", target: { kind: "chapter", label: "Chapter 2", chapter: 2 }, voices: ["subversive"],
    ideas: [{ id: "idea-0000000000000001", kind: "idea", persona: { id: "wildcard:subversive", slug: "subversive", name: "The Subversive", group: "provocateur" }, title: "Tell it backwards", idea: "Start from the flood.", why: "w", changes: { chapters: [2], secrets: [], summary: "" }, risk: "r", audacity: 9, advisory: true, decision: { verdict: "rejected", reason: "Not this book.", by: "author", at: "2026-11-20T10:05:00.000Z" } }],
  }, new Date("2026-11-28T00:00:00.000Z"));
  const store = book({ [IDEAS_JOURNAL_FILE]: rejected });
  const before = store.toObject();
  const ai = createFakeAutopilotAi();
  const result = await consultWildcards({ store, ai, target: { kind: "chapter", chapter: 2 }, preset: "quality-check", by: "author", bookId: "book", now: () => new Date("2026-11-28T08:00:00.000Z") });
  assert.deepEqual(result.asked.map((profile) => profile.slug), ["ledger-keeper", "continuity-keeper", "secrets-guardian", "domain-expert"]);
  assert.equal(ai.calls.length, 4);
  for (const call of ai.calls) {
    assert.equal(call.cacheKey, "book/wildcards");
    assert.match(call.user, /WHAT THE ROOM READS: chapter — Chapter 2: The Harbour/);
    assert.match(call.user, /The Office ===[\s\S]*ledger closed/);
    assert.match(call.user, /ALREADY REJECTED[\s\S]*Tell it backwards/);
    assert.match(call.user, /Mira Vale/, "the canon is shared");
  }
  const guardian = ai.calls.find((call) => call.label === "wildcards:secrets-guardian").user;
  assert.match(guardian, /sea wall cracked years ago/);
  for (const call of ai.calls.filter((entry) => entry.label !== "wildcards:secrets-guardian")) {
    assert.doesNotMatch(call.user, /sea wall cracked/, call.label);
    assert.match(call.user, /Orrin owes the council/, "a secret already revealed is known");
  }
  assert.equal(result.ideas.length, 8);
  assert.ok(result.ideas.every((idea) => idea.kind === "finding" && idea.changes.chapters[0] === 2));
  assert.deepEqual(result.entry.voices, result.asked.map((profile) => profile.slug));
  assert.equal(result.entry.preset, "quality-check");
  assert.equal(result.entry.at, "2026-11-28T08:00:00.000Z");
  assert.ok(result.entry.ideas.every((idea) => !idea.decision));
  assert.deepEqual(store.toObject(), before, "consulting writes nothing");
  assert.equal(store.commits.length, 0);
});

test("the decisions taken on a consultation go into the journal with it, and two devices' journals merge without a conflict", async () => {
  const store = book();
  const result = await consultWildcards({ store, ai: createFakeAutopilotAi(), target: { kind: "paragraph", chapter: 2, paragraph: 1 }, voices: ["poet", "naive"], by: "copilot" });
  assert.equal(result.target.label, "Chapter 2: The Harbour, scene 1: The Office");
  const [first, second] = result.ideas;
  const at = "2026-11-28T09:00:00.000Z";
  const decided = decideWildcardIdeas(result.entry, new Map([[first.id, { verdict: "adopted", reason: "Yes.", by: "author", at }], [second.id, { verdict: "rejected", reason: "No.", by: "author", at }]]));
  assert.equal(decided.ideas[0].decision.verdict, "adopted");
  assert.equal(decided.ideas[2].decision, undefined);
  const here = appendIdeasJournal(null, decided, new Date(at));
  const there = appendIdeasJournal(null, { ...result.entry, id: "room-elsewhere" }, new Date(at));
  const merged = parseIdeasJournal(mergeBookFileVersions(IDEAS_JOURNAL_FILE, here, there, new Date(at)));
  assert.deepEqual(merged.entries.map((entry) => entry.id).sort(), [result.entry.id, "room-elsewhere"].sort());
  assert.equal(mergeBookFileVersions("bible/world.md", "a", "b"), null);
});

test("a book file of the room that cannot be read is never asked, and the warning names it", async () => {
  const store = book({ "wildcards/broken.md": "---\nname: [unclosed\ngroup: provocateur\n---\nBody" });
  const ai = createFakeAutopilotAi();
  const result = await consultWildcards({ store, ai, target: { kind: "chapter", chapter: 1 }, voices: ["broken", "poet"], by: "author" });
  assert.deepEqual(result.asked.map((profile) => profile.slug), ["poet"]);
  assert.ok(result.warnings.some((warning) => warning.startsWith("wildcards/broken.md:")));
  const none = await consultWildcards({ store, ai, target: { kind: "chapter", chapter: 1 }, voices: ["broken"], by: "author" });
  assert.equal(none.asked.length, 0);
  assert.equal(none.ideas.length, 0);
});
