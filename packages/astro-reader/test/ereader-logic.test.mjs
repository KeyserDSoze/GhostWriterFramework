import assert from "node:assert/strict";
import test from "node:test";
import { rangeFromPoints, rangeInBlock, resolveRange, textBetween } from "../cli-dist/lib/ereader/anchors.js";
import { DEFAULT_PREFS, LINE_HEIGHTS, ReaderStore, ReaderStoreError, TEXT_SIZES, sortInBookOrder } from "../cli-dist/lib/ereader/store.js";
import { READER_PALETTES, contrastRatio } from "../cli-dist/lib/ereader/themes.js";
import { READER_LABELS, formatLabel, readerLabels, readerLanguage } from "../cli-dist/lib/reader-i18n.js";

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 24, 12, 0, clock++));

test("everything the reader keeps is under the id of the book, so two books on one origin never mix", () => {
  const storage = memoryStorage();
  const one = new ReaderStore(storage, "github-1", now);
  const two = new ReaderStore(storage, "github-2", now);
  one.addBookmark({ chapter: "001-a", scene: "001-s", block: 0 }, "First words");
  two.writePrefs({ ...DEFAULT_PREFS, theme: "dark" });
  assert.equal(two.listBookmarks().length, 0);
  assert.equal(one.readPrefs().theme, "auto");
  assert.ok([...storage.map.keys()].every((key) => /^narrarium-reader:github-[12]:(bookmarks|prefs)$/.test(key)));
});

test("several bookmarks: added in any order, listed in book order, one per place, deleted one by one", () => {
  const store = new ReaderStore(memoryStorage(), "b", now);
  const late = store.addBookmark({ chapter: "002-b", scene: "001-x", block: 4 }, "Later on");
  const early = store.addBookmark({ chapter: "001-a", scene: "002-y", block: 1 }, "Earlier");
  const earliest = store.addBookmark({ chapter: "001-a", scene: "001-x", block: 9 }, "First");
  assert.equal(store.addBookmark({ chapter: "001-a", scene: "002-y", block: 1 }, "again").id, early.id, "the same place is one bookmark");
  assert.equal(store.listBookmarks().length, 3);
  const order = { chapters: ["001-a", "002-b"], scenes: { "001-a": ["001-x", "002-y"], "002-b": ["001-x"] } };
  assert.deepEqual(sortInBookOrder(store.listBookmarks(), order).map((entry) => entry.id), [earliest.id, early.id, late.id]);
  assert.equal(store.findBookmark({ chapter: "002-b", scene: "001-x", block: 4 })?.id, late.id);
  assert.equal(store.removeBookmark(early.id), true);
  assert.equal(store.removeBookmark(early.id), false);
  assert.deepEqual(store.listBookmarks().map((entry) => entry.id).sort(), [earliest.id, late.id].sort());
});

test("highlights and notes: added, edited (an empty note leaves a highlight), moved, deleted, listed by chapter", () => {
  const store = new ReaderStore(memoryStorage(), "b", now);
  const range = { chapter: "001-a", scene: "001-x", startBlock: 0, startOffset: 4, endBlock: 0, endOffset: 9, quote: "quick" };
  const highlight = store.addAnnotation(range, "highlight");
  const note = store.addAnnotation({ ...range, chapter: "002-b" }, "note", "  Remember this.  ");
  assert.equal(note.note, "Remember this.");
  assert.equal(store.addAnnotation(range, "note", "   ").kind, "highlight", "a note without words is a highlight");
  assert.deepEqual(store.listAnnotations("002-b").map((entry) => entry.id), [note.id]);
  const edited = store.updateNote(highlight.id, "Now a note");
  assert.equal(edited.kind, "note");
  assert.notEqual(edited.updatedAt, edited.createdAt);
  assert.equal(store.updateNote(highlight.id, "").kind, "highlight");
  store.moveAnnotation(note.id, { startBlock: 2, startOffset: 0, endBlock: 2, endOffset: 5 });
  assert.equal(store.listAnnotations("002-b")[0].startBlock, 2);
  assert.equal(store.removeAnnotation(note.id), true);
  assert.equal(store.listAnnotations().length, 2);
});

test("what cannot be read is empty, never an error; malformed entries are dropped; settings are clamped", () => {
  const storage = memoryStorage();
  const store = new ReaderStore(storage, "b", now);
  storage.setItem("narrarium-reader:b:bookmarks", "{not json");
  storage.setItem("narrarium-reader:b:annotations", JSON.stringify({ v: 1, items: [{ id: "x", kind: "note", chapter: "c", scene: "s", startBlock: 0, startOffset: 0, endBlock: 0, endOffset: 1, quote: "a" }, { id: "y", kind: "nonsense" }, null, "text"] }));
  storage.setItem("narrarium-reader:b:prefs", JSON.stringify({ v: 1, theme: "neon", size: 99, leading: 1, mode: "paged", sceneTitles: "yes" }));
  storage.setItem("narrarium-reader:b:position", JSON.stringify({ v: 1, chapter: "", scene: "s", block: 0 }));
  assert.deepEqual(store.listBookmarks(), []);
  assert.deepEqual(store.listAnnotations().map((entry) => entry.id), ["x"]);
  const prefs = store.readPrefs();
  assert.equal(prefs.theme, DEFAULT_PREFS.theme);
  assert.equal(prefs.size, DEFAULT_PREFS.size);
  assert.equal(prefs.leading, 1);
  assert.equal(prefs.mode, "paged");
  assert.equal(prefs.sceneTitles, true);
  assert.equal(store.readPosition(), null);
  assert.ok(TEXT_SIZES.includes(100) && LINE_HEIGHTS.length > 3);
});

test("the position is kept and read back; a full storage is reported as a ReaderStoreError", () => {
  const store = new ReaderStore(memoryStorage(), "b", now);
  store.writePosition({ chapter: "003-c", scene: "002-s", block: 7 });
  assert.deepEqual({ ...store.readPosition(), at: undefined }, { chapter: "003-c", scene: "002-s", block: 7, at: undefined });
  const full = new ReaderStore({ getItem: () => null, setItem: () => { throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} }, "b", now);
  assert.throws(() => full.addBookmark({ chapter: "c", scene: "s", block: 0 }, "x"), ReaderStoreError);
  assert.deepEqual(full.listBookmarks(), []);
});

const SCENE = ["The quick brown fox.", "It jumped over the lazy dog.", "Then it slept."];

test("a selection becomes a range of the scene with its quote, across blocks too, without the spaces at its ends", () => {
  const inBlock = rangeFromPoints(SCENE, { block: 0, offset: 10 }, { block: 0, offset: 4 });
  assert.deepEqual(inBlock, { startBlock: 0, startOffset: 4, endBlock: 0, endOffset: 9, quote: "quick" }, "ordered, and the trailing space left out");
  const across = rangeFromPoints(SCENE, { block: 0, offset: 16 }, { block: 1, offset: 9 });
  assert.equal(across.quote, "fox.\nIt jumped");
  assert.equal(textBetween(SCENE, across), across.quote);
  assert.equal(rangeFromPoints(SCENE, { block: 0, offset: 3 }, { block: 0, offset: 4 }), null, "a space alone is no range");
  assert.equal(rangeFromPoints(SCENE, { block: 7, offset: 0 }, { block: 0, offset: 1 }), null);
  assert.deepEqual(rangeInBlock(SCENE, across, 0), { start: 16, end: 20 });
  assert.deepEqual(rangeInBlock(SCENE, across, 1), { start: 0, end: 9 });
  assert.equal(rangeInBlock(SCENE, across, 2), null);
});

test("a note finds its text again after the scene changed, the nearest occurrence first, and is detached when the text is gone", () => {
  const range = rangeFromPoints(SCENE, { block: 1, offset: 3 }, { block: 1, offset: 9 });
  assert.equal(range.quote, "jumped");
  assert.deepEqual(resolveRange(SCENE, range), { startBlock: 1, startOffset: 3, endBlock: 1, endOffset: 9 });
  const edited = ["A new first paragraph.", "The quick brown fox.", "Suddenly it jumped over the lazy dog.", "Then it slept."];
  assert.deepEqual(resolveRange(edited, range), { startBlock: 2, startOffset: 12, endBlock: 2, endOffset: 18 });
  const twice = ["it jumped.", "It jumped over the lazy dog.", "and it jumped again"];
  assert.deepEqual(resolveRange(twice, { ...range, startOffset: 4, endOffset: 10 }), { startBlock: 1, startOffset: 3, endBlock: 1, endOffset: 9 });
  assert.equal(resolveRange(["Nothing of it is left."], range), null);
});

test("every theme meets WCAG 2.2 AA: text 4.5:1, interface and focus 3:1", () => {
  for (const [name, palette] of Object.entries(READER_PALETTES)) {
    for (const [foreground, background, minimum] of [
      ["text", "bg", 7],
      ["text", "surface", 4.5],
      ["muted", "bg", 4.5],
      ["muted", "surface", 4.5],
      ["accent", "bg", 4.5],
      ["accent", "surface", 4.5],
      ["onAccent", "accent", 4.5],
      ["markText", "mark", 4.5],
      ["control", "bg", 3],
      ["control", "surface", 3],
      ["focus", "bg", 3],
      ["focus", "surface", 3],
    ]) {
      const ratio = contrastRatio(palette[foreground], palette[background]);
      assert.ok(ratio >= minimum, `${name}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, under ${minimum}:1`);
    }
  }
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
});

test("the labels follow the language of the book: Italian for it, English otherwise, with the same keys and no empty one", () => {
  assert.equal(readerLanguage("it"), "it");
  assert.equal(readerLanguage("it-IT"), "it");
  assert.equal(readerLanguage("en"), "en");
  assert.equal(readerLanguage("fr"), "en");
  assert.equal(readerLanguage(undefined), "en");
  assert.equal(readerLabels("it").contents, "Indice");
  const english = Object.keys(READER_LABELS.en).sort();
  assert.deepEqual(Object.keys(READER_LABELS.it).sort(), english);
  for (const language of ["en", "it"]) {
    for (const [key, value] of Object.entries(READER_LABELS[language])) {
      assert.ok(typeof value === "string" && value.trim(), `${language}.${key} is empty`);
      const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
      assert.equal(placeholders(value), placeholders(READER_LABELS.en[key]), `${language}.${key} has other placeholders`);
    }
  }
  assert.equal(formatLabel("Chapter {number} of {total}", { number: 2, total: 9 }), "Chapter 2 of 9");
});
