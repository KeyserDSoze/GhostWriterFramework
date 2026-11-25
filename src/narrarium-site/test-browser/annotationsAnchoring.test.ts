import { describe, expect, it } from "vitest";
import {
  CONTEXT_LENGTH,
  anchorFromRange,
  approximateMatches,
  contextScore,
  editDistance,
  fuzzyLocate,
  locateAnchor,
  listPosition,
  locateInChapter,
  similarity,
} from "@/annotations/anchoring";
import type { TextAnchor } from "@/annotations/model";

const SCENE = "The gate stood open beneath a sky the color of old steel. Mara waited by the wall, counting the lanterns. "
  + "Nobody came for a long time, and when the bell rang at last she was no longer sure she wanted to go in.";

/** The anchor of the first copy of `quote` in `text`, as the reader makes it from a selection. */
function anchorOf(text: string, quote: string, occurrence = 0): TextAnchor {
  let at = -1;
  for (let index = 0; index <= occurrence; index += 1) at = text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`${quote} is not in the text`);
  const anchor = anchorFromRange(text, at, at + quote.length);
  if (!anchor) throw new Error("no anchor");
  return { quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, offset: anchor.offset };
}

describe("an anchor made from a selection", () => {
  it("keeps the quote, up to 32 characters around it and where it starts", () => {
    const at = SCENE.indexOf("the color of old steel");
    const anchor = anchorFromRange(SCENE, at, at + "the color of old steel".length)!;
    expect(anchor.quote).toBe("the color of old steel");
    expect(anchor.offset).toBe(at);
    expect(anchor.prefix).toBe(SCENE.slice(at - CONTEXT_LENGTH, at));
    expect(anchor.prefix).toHaveLength(32);
    expect(anchor.suffix).toBe(SCENE.slice(at + anchor.quote.length, at + anchor.quote.length + 32));
  });

  it("leaves out the white space at the edges of the selection, and a selection that is only white space is nothing", () => {
    const at = SCENE.indexOf(" Mara waited");
    const anchor = anchorFromRange(SCENE, at, at + " Mara waited ".length)!;
    expect(anchor.quote).toBe("Mara waited");
    expect(anchor.offset).toBe(at + 1);
    expect(anchorFromRange("a   b", 1, 4)).toBeNull();
    expect(anchorFromRange(SCENE, 10, 10)).toBeNull();
  });

  it("has shorter surroundings at the start and the end of the text, and accepts the ends in either order", () => {
    const first = anchorFromRange(SCENE, 4, 0)!;
    expect(first).toMatchObject({ quote: "The", prefix: "", offset: 0 });
    const end = SCENE.length;
    const last = anchorFromRange(SCENE, end - 3, end + 50)!;
    expect(last).toMatchObject({ quote: "in.", suffix: "" });
  });

  it("never cuts a character outside the Basic Multilingual Plane in two", () => {
    const text = "Lei rise 😀 e se ne andò";
    const emoji = text.indexOf("😀");
    // A selection that ends between the two halves of the emoji takes the whole emoji.
    expect(anchorFromRange(text, emoji, emoji + 1)!.quote).toBe("😀");
    // A selection that starts in its second half takes it from its first.
    expect(anchorFromRange(text, emoji + 1, emoji + 4)!.quote).toBe("😀 e");
    const longPrefix = `${"x".repeat(31)}😀abc`;
    const anchor = anchorFromRange(longPrefix, longPrefix.indexOf("abc"), longPrefix.length)!;
    expect(anchor.prefix.charCodeAt(0)).not.toBe(0xde00);
    expect(() => encodeURIComponent(anchor.prefix)).not.toThrow();
  });
});

describe("the measures of likeness", () => {
  it("count the edits between two strings", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
    expect(similarity("abcd", "abce")).toBe(0.75);
    expect(similarity("", "")).toBe(1);
  });

  it("find a pattern with a few edits, the best place first", () => {
    const text = "a sky the colour of old stele, and old steel again";
    const matches = approximateMatches("old steel", text, 2);
    expect(matches[0]).toMatchObject({ errors: 0 });
    expect(text.slice(matches[0].start, matches[0].end)).toBe("old steel");
    expect(matches.some((match) => match.errors > 0 && text.slice(match.start, match.end).startsWith("old ste") && match.start < text.indexOf(","))).toBe(true);
    expect(approximateMatches("", "text", 1)).toEqual([]);
  });

  it("weigh the surroundings of a place against the anchor's", () => {
    const anchor = anchorOf(SCENE, "Mara waited");
    const at = SCENE.indexOf("Mara waited");
    expect(contextScore(anchor, SCENE, at, at + "Mara waited".length)).toBe(1);
    expect(contextScore(anchor, `${SCENE} Mara waited`, SCENE.length + 1, SCENE.length + 12)).toBeLessThan(0.75);
  });
});

describe("finding a passage again in its scene", () => {
  it("exact: the text did not change", () => {
    const anchor = anchorOf(SCENE, "the color of old steel");
    const match = locateAnchor(anchor, SCENE);
    expect(match).toMatchObject({ state: "exact", start: anchor.offset, similarity: 1 });
    expect(SCENE.slice(match.start, match.end)).toBe("the color of old steel");
  });

  it("moved: text was added before the passage", () => {
    const anchor = anchorOf(SCENE, "counting the lanterns");
    const edited = `It was cold. ${SCENE}`;
    const match = locateAnchor(anchor, edited);
    expect(match.state).toBe("moved");
    expect(edited.slice(match.start, match.end)).toBe("counting the lanterns");
    expect(match.start).toBe(anchor.offset + "It was cold. ".length);
  });

  it("moved: text was removed before the passage", () => {
    const anchor = anchorOf(SCENE, "the bell rang at last");
    const edited = SCENE.replace("Nobody came for a long time, and when", "When");
    const match = locateAnchor(anchor, edited);
    expect(match.state).toBe("moved");
    expect(edited.slice(match.start, match.end)).toBe("the bell rang at last");
  });

  it("a quote that is there more than once: the copy whose surroundings match wins, also after edits around it", () => {
    const text = "She said no. He asked again, slowly, and she said no. Then the door closed and she said no once more.";
    // The lower-case copies: the first after «slowly, and», the second after «closed and».
    const afterSlowly = anchorOf(text, "she said no", 0);
    const afterClosed = anchorOf(text, "she said no", 1);
    expect(locateAnchor(afterClosed, text)).toMatchObject({ state: "exact", start: afterClosed.offset });
    expect(locateAnchor(afterSlowly, text)).toMatchObject({ state: "exact", start: afterSlowly.offset });
    // Words added at the start shift every copy: the surroundings still tell which one was marked.
    const shifted = `Morning came. ${text}`;
    const moved = locateAnchor(afterSlowly, shifted);
    expect(moved.state).toBe("moved");
    expect(moved.start).toBe(afterSlowly.offset + "Morning came. ".length);
    expect(shifted.slice(moved.start - 12, moved.start)).toBe("slowly, and ");
    // The sentences reordered: the copy at the old offset is another one, and it does not win over the right surroundings.
    const reordered = "Then the door closed and she said no once more. She said no. He asked again, slowly, and she said no.";
    const found = locateAnchor(afterClosed, reordered);
    expect(found.state).toBe("moved");
    expect(reordered.slice(found.start, found.end + 10)).toBe("she said no once more");
  });

  it("copies with the same surroundings: the one nearest the place it was marked", () => {
    const text = "tick tock ".repeat(20).trim();
    // Every copy of «tick» from the fourth to the sixteenth has the same 32 characters before and after it.
    for (const occurrence of [5, 9, 14]) {
      const anchor = anchorOf(text, "tick", occurrence);
      expect(locateAnchor(anchor, text)).toMatchObject({ state: "exact", start: anchor.offset });
      // Two copies added at the start: the nearest copy to the old place with the same surroundings is the one two copies before.
      const longer = `tick tock tick tock ${text}`;
      expect(locateAnchor(anchor, longer)).toMatchObject({ state: "exact", start: anchor.offset });
    }
  });

  it("edited: a word of the passage was changed", () => {
    const anchor = anchorOf(SCENE, "Mara waited by the wall, counting the lanterns");
    const edited = SCENE.replace("waited by the wall", "stood by the wall");
    const match = locateAnchor(anchor, edited);
    expect(match.state).toBe("edited");
    expect(edited.slice(match.start, match.end)).toBe("Mara stood by the wall, counting the lanterns");
    expect(match.similarity).toBeGreaterThan(0.8);
    expect(match.similarity).toBeLessThan(1);
  });

  it("edited: a typo fixed and the punctuation changed", () => {
    const text = "The gate stood open beneath a sky the colour of old stele; Mara waited.";
    const anchor = anchorOf(text, "a sky the colour of old stele");
    const edited = text.replace("colour of old stele;", "color of old steel,");
    const match = locateAnchor(anchor, edited);
    expect(match.state).toBe("edited");
    expect(edited.slice(match.start, match.end)).toBe("a sky the color of old steel");
  });

  it("edited: the passage was rewritten between surroundings that did not change", () => {
    const anchor = anchorOf(SCENE, "Nobody came for a long time");
    const edited = SCENE.replace("Nobody came for a long time", "The square stayed empty until dusk");
    const match = locateAnchor(anchor, edited);
    expect(match.state).toBe("edited");
    expect(edited.slice(match.start, match.end)).toBe("The square stayed empty until dusk");
    expect(match.similarity).toBeLessThan(0.65);
  });

  it("orphaned: the passage was deleted, and nothing like it is left", () => {
    const anchor = anchorOf(SCENE, "counting the lanterns");
    const edited = SCENE.replace(", counting the lanterns", "");
    expect(locateAnchor(anchor, edited)).toMatchObject({ state: "orphaned", start: -1, end: -1 });
    expect(locateAnchor(anchor, "")).toMatchObject({ state: "orphaned" });
    expect(locateAnchor({ ...anchor, quote: "" }, SCENE)).toMatchObject({ state: "orphaned" });
  });

  it("orphaned: a short quote is not found again in a word that only looks like it", () => {
    const text = "The cat sat on the mat.";
    const anchor = anchorOf(text, "cat");
    const rewritten = "A car stopped by the road outside the house.";
    expect(locateAnchor(anchor, rewritten).state).toBe("orphaned");
    // With its surroundings intact it is found, edited.
    expect(locateAnchor(anchor, "The cab sat on the mat.")).toMatchObject({ state: "edited" });
  });

  it("orphaned: a passage rewritten completely, surroundings and all", () => {
    const anchor = anchorOf(SCENE, "Nobody came for a long time");
    expect(locateAnchor(anchor, "Everything here is different now, every single word of it.").state).toBe("orphaned");
  });

  it("a long passage in a long scene is found from its head and its tail", () => {
    const sentence = (index: number) => `Sentence number ${index} of a very long scene says something different about the harbour and the ships. `;
    const text = Array.from({ length: 400 }, (_, index) => sentence(index)).join("");
    const start = text.indexOf("Sentence number 100 ");
    const end = text.indexOf("Sentence number 160 ");
    const anchor = anchorFromRange(text, start, end)!;
    expect(anchor.quote.length * text.length).toBeGreaterThan(4_000_000);
    const edited = text.replace("number 130 of a very long scene", "number 130 of a rather long scene");
    const match = fuzzyLocate(anchor, edited)!;
    expect(match.state).toBe("edited");
    expect(Math.abs(match.start - start)).toBeLessThan(5);
    expect(locateAnchor(anchor, edited).state).toBe("edited");
  });
});

describe("finding a passage again in its chapter", () => {
  const opening = { paragraph: "001-opening", text: SCENE };
  const second = { paragraph: "002-the-bell", text: "The bell rang twice. Mara counted the lanterns again and went in." };

  it("in its own scene first", () => {
    const anchor = { ...anchorOf(SCENE, "counting the lanterns"), paragraph: "001-opening" };
    expect(locateInChapter(anchor, [opening, second])).toMatchObject({ state: "exact", paragraph: "001-opening" });
  });

  it("moved to another scene, verbatim", () => {
    const anchor = { ...anchorOf(SCENE, "Mara waited by the wall"), paragraph: "001-opening" };
    const without = { ...opening, text: SCENE.replace("Mara waited by the wall, counting the lanterns. ", "") };
    const withIt = { ...second, text: `Mara waited by the wall, counting the lanterns. ${second.text}` };
    const match = locateInChapter(anchor, [without, withIt]);
    expect(match).toMatchObject({ state: "moved", paragraph: "002-the-bell", start: 0 });
  });

  it("the scene was deleted or renamed: the passage is looked for in the others", () => {
    const anchor = { ...anchorOf(SCENE, "the color of old steel"), paragraph: "009-gone" };
    expect(locateInChapter(anchor, [opening, second])).toMatchObject({ state: "moved", paragraph: "001-opening" });
  });

  it("edited in its own scene wins over a copy elsewhere with other surroundings", () => {
    const anchor = { ...anchorOf(SCENE, "Mara waited by the wall"), paragraph: "001-opening" };
    const edited = { ...opening, text: SCENE.replace("Mara waited by the wall", "Mara waited near the wall") };
    const elsewhere = { ...second, text: "Years later, Mara waited by the wall of another city." };
    expect(locateInChapter(anchor, [edited, elsewhere])).toMatchObject({ state: "edited", paragraph: "001-opening" });
  });

  it("moved to another scene and edited there", () => {
    const anchor = { ...anchorOf(SCENE, "Nobody came for a long time, and when the bell rang"), paragraph: "001-opening" };
    const without = { ...opening, text: "The gate stood open." };
    const withIt = { ...second, text: "Nobody came for a very long time, and when the bell rang she went in." };
    expect(locateInChapter(anchor, [without, withIt])).toMatchObject({ state: "edited", paragraph: "002-the-bell" });
  });

  it("orphaned: nowhere in the chapter, and it keeps the scene it was marked in", () => {
    const anchor = { ...anchorOf(SCENE, "counting the lanterns"), paragraph: "001-opening" };
    expect(locateInChapter(anchor, [{ ...opening, text: "Nothing." }, { ...second, text: "Nothing else." }])).toMatchObject({ state: "orphaned", paragraph: "001-opening", start: -1 });
    expect(locateInChapter(anchor, [])).toMatchObject({ state: "orphaned", paragraph: "001-opening" });
  });

  it("in a list, stand where the passage is now, or, orphaned, where it was", () => {
    const anchor = anchorOf(SCENE, "counting the lanterns");
    expect(listPosition(anchor, { state: "moved", start: 12 })).toBe(12);
    expect(listPosition(anchor, { state: "orphaned", start: -1 })).toBe(anchor.offset);
    expect(listPosition(anchor, null)).toBe(anchor.offset);
  });
});
