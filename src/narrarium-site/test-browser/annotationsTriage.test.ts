import { describe, expect, it } from "vitest";
import { SWIPE_DISTANCE, estimateBulkFix, loadPassed, savePassed, swipeAction, triageActionOfKey, triageQueue } from "@/annotations/triage";
import type { NoteItem } from "@/annotations/notesView";

const item = (id: string, status: string, chapterOrder: number, sceneOrder: number, offset: number, chapter = `c${chapterOrder}`): NoteItem => ({
  annotation: { id, status, chapter, offset, quote: "q", comment: "" } as never, tagName: "t", chapterTitle: chapter, chapterOrder, sceneTitle: "s", sceneNumber: "001", sceneOrder,
});
const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });

describe("the triage queue", () => {
  const items = [item("b", "open", 1, 0, 5), item("a", "open", 0, 0, 9), item("l", "later", 0, 0, 1), item("h", "handled", 0, 0, 2), item("d", "dismissed", 0, 0, 3), item("c", "open", 0, 1, 0)];
  it("holds the open notes in the order of the book, not the ones put off, handled or dismissed", () => {
    expect(triageQueue(items, new Set()).map((entry) => entry.annotation.id)).toEqual(["a", "c", "b"]);
  });
  it("leaves out the notes passed over and, when asked, the other chapters", () => {
    expect(triageQueue(items, new Set(["a"])).map((entry) => entry.annotation.id)).toEqual(["c", "b"]);
    expect(triageQueue(items, new Set(), "c1").map((entry) => entry.annotation.id)).toEqual(["b"]);
  });
  it("counts a note with no status as open", () => {
    expect(triageQueue([item("n", undefined as never, 0, 0, 0)], new Set())).toHaveLength(1);
  });
});

describe("the keys of the triage", () => {
  it("maps one letter to each action, in either case", () => {
    expect(["h", "L", "d", "f", "p", "s", "r"].map((letter) => triageActionOfKey(key(letter)))).toEqual(["handled", "later", "dismissed", "fix", "paragraph", "skip", "reason"]);
  });
  it("ignores other keys and anything pressed with a modifier, which belongs to the browser or the app", () => {
    expect(triageActionOfKey(key("x"))).toBeNull();
    expect(triageActionOfKey(key("h", { ctrlKey: true }))).toBeNull();
    expect(triageActionOfKey(key("h", { metaKey: true }))).toBeNull();
    expect(triageActionOfKey(key("h", { altKey: true }))).toBeNull();
    expect(triageActionOfKey(key("H", { shiftKey: true }))).toBeNull();
  });
});

describe("the swipe", () => {
  it("decides only for a long, mostly horizontal movement: right is handled, left is later", () => {
    expect(swipeAction(SWIPE_DISTANCE, 0)).toBe("handled");
    expect(swipeAction(-SWIPE_DISTANCE - 20, 10)).toBe("later");
    expect(swipeAction(SWIPE_DISTANCE - 1, 0)).toBeNull();
    expect(swipeAction(150, 120)).toBeNull();
  });
});

describe("what is kept between sittings", () => {
  const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data }; };
  it("keeps the notes passed over for each book and forgets them when none is left", () => {
    const storage = memory();
    savePassed(storage, "one", new Set(["a", "b"]));
    expect([...loadPassed(storage, "one")]).toEqual(["a", "b"]);
    expect(loadPassed(storage, "two").size).toBe(0);
    savePassed(storage, "one", new Set());
    expect(storage.data.size).toBe(0);
  });
  it("starts over from damaged or missing storage", () => {
    expect(loadPassed({ getItem: () => "{nope" }, "x").size).toBe(0);
    expect(loadPassed({ getItem: () => "{\"a\":1}" }, "x").size).toBe(0);
    expect(loadPassed(undefined, "x").size).toBe(0);
    expect(loadPassed({ getItem: () => JSON.stringify(["a", 3, null]) }, "x")).toEqual(new Set(["a"]));
  });
});

describe("the estimate of fixing several notes", () => {
  it("is one call per note and grows with the notes", () => {
    const one = estimateBulkFix([{ quote: "abc", comment: "" }]);
    const two = estimateBulkFix([{ quote: "abc", comment: "" }, { quote: "x".repeat(400), comment: "y".repeat(400) }]);
    expect(one.calls).toBe(1);
    expect(two.calls).toBe(2);
    expect(two.inputTokens).toBeGreaterThan(one.inputTokens * 2);
    expect(estimateBulkFix([])).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });
});
