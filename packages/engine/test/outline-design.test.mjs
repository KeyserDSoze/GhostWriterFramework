import test from "node:test";
import assert from "node:assert/strict";
import * as engine from "../dist/index.js";
import { MemoryBookStore } from "../dist/testing/index.js";

// The design of a chapter of the Synopsis (`design:` in `outline/chapters/<NNN>.md`): read softly, written whole by the autopilot and field by field by the author,
// part of the fingerprint of the entry only when it says something, and kept (the keys the engine does not know too) through every edit of the outline.

const {
  OUTLINE_DESIGN_KEYS,
  applyDesignPatch,
  composeOutlineEdits,
  designFingerprint,
  designText,
  isDesignEmpty,
  missingDesignFields,
  normalizeDesignPatch,
  outlineChanges,
  outlineEditNeedsHash,
  outlineEntryDigest,
  outlineIndex,
  parseOutline,
  readOutlineChapter,
  readOutlineDesign,
  serializeOutlineChapter,
  wholeDesignPatch,
  outlineDesignGaps,
} = engine;

const FULL = {
  goal: "Mira learns the keeper lied.",
  pov: ["Mira Vale"],
  characters: ["Mira Vale", "Orrin Hale"],
  setting: "The lighthouse: lamp room",
  time: "Three days after the storm",
  events: ["Mira climbs to the lamp room", "She finds the torn logbook"],
  scenes: ["Dusk on the stairs", "The logbook"],
  conflicts: ["Mira against Orrin"],
  emotions: "From suspicion to grief",
  reveals: ["secret:the-wall-is-failing"],
  withholds: ["Who tore the page"],
  clues: ["Wet boots on a dry day"],
  previous: "Picks up the storm of chapter 2.",
  next: "Sets up the night crossing.",
  ending: "The lamp goes out.",
  cliffhanger: true,
  notes: "Keep Orrin sympathetic: no flashbacks.",
};

test("a design is read softly: every field of its kind, a line taken for a list, and what cannot be read is said and left out", () => {
  const { design, problems } = readOutlineDesign({ ...FULL, pov: "Mira Vale", cliffhanger: "yes", events: ["One", { odd: true }, 3], ending: ["not", "text"], extra: { kept: true } });
  assert.deepEqual(design.pov, ["Mira Vale"], "a lone line is a list of one");
  assert.equal(design.cliffhanger, true);
  assert.deepEqual(design.events, ["One", "3"]);
  assert.equal(design.ending, undefined, "a list where a text belongs is not read");
  assert.equal("extra" in design, false, "a key the engine does not know is not part of what it reads");
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /design\.events: an item is not a line of text/);
  assert.match(problems.join("\n"), /design\.ending must be text/);
  assert.deepEqual(readOutlineDesign("a sentence"), { problems: ["design must be a mapping of fields («a sentence» is not): it is not read"] });
  assert.deepEqual(readOutlineDesign(undefined), { problems: [] });
  assert.deepEqual(readOutlineDesign({}), { problems: [] }, "an empty design is no design");
  assert.equal(isDesignEmpty({ goal: "  ", pov: [] }), true);
  assert.deepEqual(missingDesignFields({ goal: "x", events: ["a"] }), ["pov", "ending"]);
  assert.deepEqual(OUTLINE_DESIGN_KEYS.slice(0, 3), ["goal", "pov", "characters"]);
});

test("a change of a design is field by field: a value sets, null and empty take away, the rest stays, and an edit over the limits is cut and said", () => {
  const base = { goal: "Old goal", ending: "Old ending", mood: "an author's key" };
  const { patch, problems } = normalizeDesignPatch({ goal: "  New goal ", ending: null, events: "- One\n- Two\n", scenes: [], wrong: "x" });
  assert.deepEqual(patch, { goal: "New goal", ending: null, events: ["One", "Two"], scenes: null });
  assert.deepEqual(problems, []);
  assert.deepEqual(applyDesignPatch(base, patch), { goal: "New goal", events: ["One", "Two"], mood: "an author's key" }, "the author's own key stays, after the engine's");
  assert.equal(applyDesignPatch(base, null), undefined, "null takes the design away");
  assert.equal(applyDesignPatch({ goal: "x" }, { goal: null }), undefined, "nothing left is no design");
  const long = normalizeDesignPatch({ notes: "x".repeat(5000), clues: Array.from({ length: 50 }, (_, index) => `Clue ${index}`) });
  assert.equal(long.patch.notes.length, 4000);
  assert.equal(long.patch.clues.length, 40);
  assert.equal(long.problems.length, 2);
  const whole = wholeDesignPatch({ goal: "Only a goal" });
  assert.equal(Object.keys(whole).length, OUTLINE_DESIGN_KEYS.length, "written whole: every field set or taken away");
  assert.equal(whole.events, null);
});

test("an entry without a design keeps the fingerprint it always had, and a design is part of it however its YAML is written", async () => {
  const plain = { title: "The Lighthouse", body: "Mira climbs.", ghostwriter: "noir" };
  // The fingerprint of an entry before designs existed, computed as it always was.
  const legacy = (await engine.sha256Hex(JSON.stringify(["outline-chapter", "The Lighthouse", "noir", "Mira climbs."]))).slice(0, 16);
  assert.equal(await outlineEntryDigest(plain), legacy);
  assert.equal(await outlineEntryDigest({ ...plain, design: {} }), legacy, "an empty design is no design");
  assert.equal(await outlineEntryDigest({ ...plain, design: { goal: "  ", pov: [] } }), legacy);
  const designed = await outlineEntryDigest({ ...plain, design: { goal: "Learn the truth" } });
  assert.notEqual(designed, legacy);
  assert.equal(await outlineEntryDigest({ ...plain, design: { goal: "Learn the truth\r\n" } }), designed, "line endings and spaces do not count");
  assert.equal(designFingerprint({ b: 1, a: [" x ", ""] }), designFingerprint({ a: ["x"], b: 1 }), "keys in order, empty values gone");
  assert.notEqual(await outlineEntryDigest({ ...plain, design: { goal: "Learn the truth", mood: "a key of the author" } }), designed, "a key the engine does not know counts too");
});

test("the autopilot's design survives the YAML: written, read back, and the entry is still the autopilot's own", async () => {
  const tricky = {
    ...FULL,
    goal: "Mira: «why?» — # not a comment; 'quotes' and \"double\"",
    notes: "Line one\nLine two: with a colon\n  indented",
    time: "2026-11-26",
    setting: "yes",
    events: ["- dash first", "1e3", "true", "null", "@at", "a: b"],
  };
  const patch = wholeDesignPatch(tricky);
  const design = engine.outlineDesignOf({ design: patch });
  const digest = await outlineEntryDigest({ title: "T", body: "B", design });
  const content = serializeOutlineChapter({ number: 3, title: "T", body: "B", design: patch, origin: "autopilot", digest });
  const { entry, warnings } = await readOutlineChapter("outline/chapters/003.md", 3, content);
  assert.deepEqual(warnings, []);
  assert.equal(entry.contentDigest, digest, "the fingerprint read is the one written");
  assert.equal(entry.intact, true);
  assert.equal(entry.design.goal, tricky.goal);
  assert.equal(entry.design.time, "2026-11-26", "a date stays text");
  assert.equal(entry.design.setting, "yes", "a word YAML 1.1 took for a boolean stays text");
  assert.deepEqual(entry.design.events, tricky.events);
  assert.equal(entry.design.notes, "Line one\nLine two: with a colon\n  indented");
  assert.ok(content.indexOf("design:") > content.indexOf("digest:"), "the design comes after the keys of the entry");
});

test("an entry of an older book (no design) reads as it always did, and an author's touch to a design makes the entry the author's", async () => {
  const old = "---\ntype: outline-chapter\nid: outline-chapter:002\nnumber: 2\ntitle: The Storm\norigin: autopilot\ndigest: DIGEST\n---\n\nThe storm breaks.\n";
  const digest = await outlineEntryDigest({ title: "The Storm", body: "The storm breaks." });
  const { entry } = await readOutlineChapter("outline/chapters/002.md", 2, old.replace("DIGEST", digest));
  assert.equal(entry.intact, true);
  assert.equal(entry.design, undefined);
  const touched = old.replace("DIGEST", digest).replace("---\n\nThe storm", "design:\n  goal: The storm breaks the wall.\n---\n\nThe storm");
  const read = await readOutlineChapter("outline/chapters/002.md", 2, touched);
  assert.equal(read.entry.intact, false, "a design added by hand is the author's");
  assert.equal(read.entry.design.goal, "The storm breaks the wall.");
});

test("an empty entry of the autopilot with no digest is a place it fills (the entries of a new book of a given size, the ones a design adds); any word in it is the author's", async () => {
  const placeholder = serializeOutlineChapter({ number: 4, origin: "autopilot" });
  assert.equal((await readOutlineChapter("outline/chapters/004.md", 4, placeholder)).entry.intact, true);
  const titled = serializeOutlineChapter({ number: 4, title: "Mine", origin: "autopilot" });
  assert.equal((await readOutlineChapter("outline/chapters/004.md", 4, titled)).entry.intact, false);
  const authors = serializeOutlineChapter({ number: 4, origin: "author" });
  assert.equal((await readOutlineChapter("outline/chapters/004.md", 4, authors)).entry.intact, false, "an empty entry of the author stays the author's");
  const designed = serializeOutlineChapter({ number: 4, origin: "autopilot", design: { goal: "x" } });
  assert.equal((await readOutlineChapter("outline/chapters/004.md", 4, designed)).entry.intact, false);
});

test("an edit of the author changes the design field by field, keeps the author's keys, and a move or an edit of the text keeps the design", async () => {
  const content = "---\ntype: outline-chapter\nid: outline-chapter:001\nnumber: 1\ntitle: One\norigin: author\ndesign:\n  goal: Old goal\n  ending: Old ending\n  mood: grey\n---\n\nText.\n";
  const outline = await parseOutline([{ path: "outline/chapters/001.md", content, hash: "h1" }, { path: "outline/chapters/002.md", content: serializeOutlineChapter({ number: 2, title: "Two", origin: "author" }), hash: "h2" }]);
  const edited = outlineChanges({ outline, edit: { kind: "update", number: 1, entry: { design: { goal: "New goal", ending: null, events: ["A", "B"] } } } });
  const after = await readOutlineChapter("outline/chapters/001.md", 1, edited.changes[0].content);
  assert.deepEqual(after.entry.design, { goal: "New goal", events: ["A", "B"] });
  assert.equal(after.entry.frontmatter.design.mood, "grey", "the author's own key of the design stays");
  assert.equal(after.entry.body, "Text.");
  const text = outlineChanges({ outline, edit: { kind: "update", number: 1, entry: { body: "New text." } } });
  assert.equal((await readOutlineChapter("outline/chapters/001.md", 1, text.changes[0].content)).entry.design.goal, "Old goal", "an edit of the text keeps the design");
  const moved = outlineChanges({ outline, edit: { kind: "move", from: 1, to: 2 } });
  const now2 = moved.changes.find((change) => change.path === "outline/chapters/002.md");
  assert.equal((await readOutlineChapter("outline/chapters/002.md", 2, now2.content)).entry.design.goal, "Old goal", "a move carries the design");
  const cleared = outlineChanges({ outline, edit: { kind: "update", number: 1, entry: { design: null } } });
  assert.equal((await readOutlineChapter("outline/chapters/001.md", 1, cleared.changes[0].content)).entry.frontmatter.design, undefined);
  const cut = outlineChanges({ outline, edit: { kind: "update", number: 1, entry: { design: { notes: "x".repeat(4500) } } } });
  assert.equal(cut.warnings.filter((warning) => warning.code === "text-too-long").length, 1, "a design over the limits is cut, and said");
});

test("a series of edits composes designs like any field: the steps name it, it asks for the hash of what it replaces, and the changed entries are told", async () => {
  const store = new MemoryBookStore({
    "outline/chapters/001.md": serializeOutlineChapter({ number: 1, title: "One", body: "Text.", origin: "author" }),
  });
  const files = await store.list();
  const source = { index: outlineIndex(files.map((file) => [file.path, file.hash])), read: (path) => store.read(path) };
  const hash = files.find((file) => file.path === "outline/chapters/001.md").hash;
  const composed = await composeOutlineEdits(source, [{ kind: "update", number: 1, entry: { design: { goal: "A goal", pov: ["Mira"] } }, expectedHash: hash }], { requireHash: outlineEditNeedsHash });
  assert.deepEqual(composed.steps, [{ kind: "update", number: 1, created: false, fields: ["design"], origin: 1 }]);
  assert.deepEqual(composed.changed, [1]);
  assert.equal(outlineEditNeedsHash({ kind: "update", number: 1, entry: { design: { goal: "x" } } }), true, "a design replaces what someone read");
  assert.equal(outlineEditNeedsHash({ kind: "update", number: 1, entry: { title: "x" } }), false);
  await assert.rejects(composeOutlineEdits(source, [{ kind: "update", number: 1, entry: { design: { goal: "x" } } }], { requireHash: outlineEditNeedsHash }), (error) => error.code === "expected_hash_required");
});

test("the soft warnings of the designs: an entry with a design that lacks a key field is said, an entry with no design says nothing", () => {
  const findings = outlineDesignGaps([{ number: 2, design: { goal: "g", pov: ["p"], events: ["e"], ending: "x" } }, { number: 1, design: { goal: "g" } }, { number: 3 }]);
  assert.deepEqual(findings, [{ code: "design-incomplete", severity: "info", chapter: 1, fields: ["pov", "events", "ending"] }]);
  assert.equal(engine.designFindingText(findings[0], "en"), "The design of chapter 1 does not say: point of view, main events, ending.");
  assert.equal(engine.designFindingText(findings[0], "it"), "Il progetto del capitolo 1 non dice: punto di vista, eventi principali, chiusura.");
});

test("a design as text for a prompt: a line a field, within its share", () => {
  const text = designText(FULL, 10_000);
  assert.match(text, /^Narrative goal: Mira learns the keeper lied\.$/m);
  assert.match(text, /^Cliffhanger: yes$/m);
  assert.match(text, /^Main events: Mira climbs to the lamp room; She finds the torn logbook$/m);
  assert.ok(designText(FULL, 120).length <= 120);
  assert.equal(designText(undefined), "");
});
