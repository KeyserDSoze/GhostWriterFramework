import { describe, expect, it } from "vitest";
import { anchorFromRange, locateAnchor } from "@/annotations/anchoring";
import { ANNOTATION_UI_ATTRIBUTE, boundaryIndex, buildTextModel, intersectRange, markHtml, plainTextOfHtml, rangeOffsets, type MarkedPassage } from "@/annotations/textModel";

function element(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

function passage(id: string, start: number, end: number, patch: Partial<MarkedPassage> = {}): MarkedPassage {
  return { id, start, end, underline: "wavy", color: "amber", icon: "pen", state: "exact", label: `To rewrite: note ${id}`, ...patch };
}

describe("the plain text of a scene", () => {
  it("is its text with every run of white space made one space, blocks apart, trimmed", () => {
    expect(plainTextOfHtml("<p>  The gate\n  stood   open.</p><p>Mara\twaited.</p>")).toBe("The gate stood open. Mara waited.");
    expect(plainTextOfHtml("<h2>One</h2><ul><li>two</li><li>three</li></ul>four<br>five")).toBe("One two three four five");
    expect(plainTextOfHtml("<p>non\u00a0breaking</p>")).toBe("non breaking");
  });

  it("is the same in every line-break mode of the reader: the modes only regroup lines and blocks", () => {
    const book = "<p>The gate stood open beneath a sky. Mara waited.</p>";
    const source = "<p>The gate stood open\nbeneath a sky.</p>\n<p>Mara waited.</p>";
    const dialogue = "<p>The gate stood open beneath a sky.</p><p>Mara waited.</p>";
    expect(plainTextOfHtml(source)).toBe(plainTextOfHtml(book));
    expect(plainTextOfHtml(dialogue)).toBe(plainTextOfHtml(book));
  });

  it("keeps the names of the canon (buttons in the reader) and leaves out what the annotations add", () => {
    expect(plainTextOfHtml(`<p>Then <button class="reader-entity-link">Mara</button> laughed<button ${ANNOTATION_UI_ATTRIBUTE}>icon</button>.</p>`)).toBe("Then Mara laughed.");
  });
});

describe("a selection in the reader", () => {
  it("is the same passage in the plain text, inside one text, across inline elements and around a name of the canon", () => {
    const host = element("<p>The <em>gate</em> stood open.</p><p>Then <button>Mara</button> laughed.</p>");
    const model = buildTextModel(host);
    expect(model.text).toBe("The gate stood open. Then Mara laughed.");
    const range = document.createRange();
    const first = host.querySelector("p")!.firstChild!;
    range.setStart(first, 0);
    const laughed = host.querySelectorAll("p")[1].lastChild!;
    range.setEnd(laughed, " laughed".length);
    const offsets = rangeOffsets(host, range)!;
    expect(model.text.slice(offsets.start, offsets.end)).toBe("The gate stood open. Then Mara laughed");
    // A boundary given as an element and a child index.
    const atEm = document.createRange();
    atEm.setStart(host.querySelector("p")!, 1);
    atEm.setEnd(host.querySelector("em")!, 1);
    const em = rangeOffsets(host, atEm)!;
    expect(model.text.slice(em.start, em.end)).toBe("gate");
    host.remove();
  });

  it("is cut to the scene it starts in: what is outside is left out, and a selection elsewhere is nothing", () => {
    const host = element("<section id='one'><p>First scene text.</p></section><section id='two'><p>Second scene.</p></section>");
    const one = host.querySelector("#one")!;
    const two = host.querySelector("#two")!;
    const range = document.createRange();
    range.setStart(one.querySelector("p")!.firstChild!, "First ".length);
    range.setEnd(two.querySelector("p")!.firstChild!, "Second".length);
    const inOne = rangeOffsets(one, range)!;
    expect(inOne.model.text.slice(inOne.start, inOne.end)).toBe("scene text.");
    const inTwo = rangeOffsets(two, range)!;
    expect(inTwo.model.text.slice(inTwo.start, inTwo.end)).toBe("Second");
    const outside = document.createRange();
    outside.selectNodeContents(two);
    expect(rangeOffsets(one, outside)).toBeNull();
    expect(intersectRange(outside, one)).toBeNull();
    host.remove();
  });

  it("a boundary inside what the annotations add falls just after it", () => {
    const host = element(`<p>Alpha<button ${ANNOTATION_UI_ATTRIBUTE}>x</button> beta</p>`);
    const model = buildTextModel(host);
    const icon = host.querySelector("button")!;
    expect(boundaryIndex(model, icon.firstChild!, 1)).toBe("Alpha".length);
    host.remove();
  });
});

describe("the marks of a scene", () => {
  const html = "<p>The gate stood open beneath a sky the color of old steel.</p><p>Mara <em>waited</em> by the wall.</p>";
  const text = plainTextOfHtml(html);
  const at = (quote: string) => {
    const start = text.indexOf(quote);
    return [start, start + quote.length] as const;
  };

  it("wrap the passage in a mark with its tag's style, and put after it a button that names the annotation", () => {
    const [start, end] = at("the color of old steel");
    const marked = markHtml(html, [passage("a-1", start, end)]);
    const host = element(marked);
    const marks = Array.from(host.querySelectorAll("mark.reader-annotation"));
    // The last word is a mark of its own, kept on one line with the icon; the two marks read as one passage.
    expect(marks.map((mark) => [mark.textContent, mark.getAttribute("data-mark-piece")])).toEqual([["the color of old ", "head"], ["steel", "tail"]]);
    for (const mark of marks) {
      expect(mark.getAttribute("data-annotation-id")).toBe("a-1");
      expect(mark.getAttribute("data-mark-underline")).toBe("wavy");
      expect(mark.getAttribute("data-mark-color")).toBe("amber");
    }
    const icon = marks[1].nextElementSibling as HTMLButtonElement;
    expect(icon.parentElement?.className).toBe("reader-annotation-tail");
    expect(Array.from(icon.parentElement!.childNodes).map((node) => node.nodeName)).toEqual(["MARK", "BUTTON"]);
    expect(icon.tagName).toBe("BUTTON");
    expect(icon.type).toBe("button");
    expect(icon.getAttribute("aria-label")).toBe("To rewrite: note a-1");
    expect(icon.hasAttribute(ANNOTATION_UI_ATTRIBUTE)).toBe(true);
    expect(icon.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The plain text is the same with the marks: anchors made on a marked page are anchors of the scene.
    expect(buildTextModel(host).text).toBe(text);
    host.remove();
  });

  it("cover a passage that crosses elements with one mark per piece, and one button after the last", () => {
    const [start, end] = at("Mara waited by the");
    const host = element(markHtml(html, [passage("a-1", start, end)]));
    const marks = Array.from(host.querySelectorAll("mark"));
    expect(marks.map((mark) => mark.textContent)).toEqual(["Mara ", "waited", " by ", "the"]);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(marks[3].nextElementSibling?.tagName).toBe("BUTTON");
    expect(buildTextModel(host).text).toBe(text);
    host.remove();
  });

  it("where two passages overlap, the shared piece carries both, in the style of the one that starts first", () => {
    const [aStart] = at("a sky the color");
    const [, bEnd] = at("color of old steel");
    const [bStart] = at("color of old steel");
    const [, aEnd] = at("a sky the color");
    const host = element(markHtml(html, [passage("a-2", bStart, bEnd, { color: "sky", underline: "dotted" }), passage("a-1", aStart, aEnd)]));
    const marks = Array.from(host.querySelectorAll("mark"));
    expect(marks.map((mark) => [mark.textContent, mark.getAttribute("data-annotation-ids"), mark.getAttribute("data-mark-color")])).toEqual([
      ["a sky the ", "a-1", "amber"],
      ["color", "a-1 a-2", "amber"],
      [" of old ", "a-2", "sky"],
      ["steel", "a-2", "sky"],
    ]);
    expect(marks[1].hasAttribute("data-annotation-overlap")).toBe(true);
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(marks[1].nextElementSibling?.getAttribute("data-annotation-id")).toBe("a-1");
    expect(marks[3].nextElementSibling?.getAttribute("data-annotation-id")).toBe("a-2");
    expect(buildTextModel(host).text).toBe(text);
    host.remove();
  });

  it("never put a button inside a name of the canon, and never read an annotation as HTML", () => {
    const withName = "<p>Then <button class=\"reader-entity-link\">Mara</button> laughed.</p>";
    const plain = plainTextOfHtml(withName);
    const start = plain.indexOf("Mara");
    const host = element(markHtml(withName, [passage("a-1", start, start + 4, { label: "<img src=x onerror=alert(1)>" })]));
    const icon = host.querySelector(`button[${ANNOTATION_UI_ATTRIBUTE}]`)!;
    expect(icon.parentElement?.className).toBe("reader-annotation-tail");
    expect(icon.parentElement?.parentElement?.tagName).toBe("P");
    expect(icon.previousElementSibling?.className).toBe("reader-entity-link");
    expect(icon.previousElementSibling?.querySelector("mark")?.textContent).toBe("Mara");
    expect(host.querySelector("img")).toBeNull();
    expect(icon.getAttribute("aria-label")).toBe("<img src=x onerror=alert(1)>");
    host.remove();
  });

  it("put the icons of passages that end on the same word together, in their order, after that word", () => {
    const [aStart, end] = at("the color of old steel");
    const [bStart] = at("old steel");
    const host = element(markHtml(html, [passage("a-1", aStart, end), passage("a-2", bStart, end, { color: "sky" })]));
    const tails = host.querySelectorAll(".reader-annotation-tail");
    expect(tails).toHaveLength(1);
    expect(Array.from(tails[0].children).map((child) => child.tagName === "MARK" ? child.textContent : child.getAttribute("data-annotation-id"))).toEqual(["steel", "a-1", "a-2"]);
    expect(buildTextModel(host).text).toBe(text);
    host.remove();
  });

  it("keep one word passages whole, and one place for the icons of two passages that end in the same name of the canon", () => {
    const [start, end] = at("steel");
    const single = element(markHtml(html, [passage("a-1", start, end)]));
    expect(Array.from(single.querySelectorAll("mark")).map((mark) => [mark.textContent, mark.hasAttribute("data-mark-piece")])).toEqual([["steel", false]]);
    single.remove();
    const withName = "<p>Then <button class=\"reader-entity-link\">Mara Vell</button> laughed.</p>";
    const plain = plainTextOfHtml(withName);
    const name = plain.indexOf("Mara");
    const host = element(markHtml(withName, [passage("a-1", name, name + 4), passage("a-2", name + 5, name + 9, { color: "sky" })]));
    expect(host.querySelectorAll(".reader-annotation-tail")).toHaveLength(1);
    expect(Array.from(host.querySelectorAll(`button[${ANNOTATION_UI_ATTRIBUTE}]`)).map((icon) => icon.getAttribute("data-annotation-id"))).toEqual(["a-1", "a-2"]);
    expect(host.querySelector(".reader-entity-link")?.parentElement?.className).toBe("reader-annotation-tail");
    expect(buildTextModel(host).text).toBe(plain);
    host.remove();
  });

  it("leave the page as it was without passages, or with a passage outside the text", () => {
    expect(markHtml(html, [])).toBe(html);
    const host = element(markHtml(html, [passage("a-1", text.length + 5, text.length + 9)]));
    expect(host.querySelector("mark")).toBeNull();
    host.remove();
  });

  it("go back to the marked passage after the scene was edited: anchor, edit, locate, mark", () => {
    const [start, end] = at("old steel");
    const anchor = anchorFromRange(text, start, end)!;
    const edited = "<p>It was cold. The gate stood open beneath a sky the color of old steel.</p><p>Mara <em>waited</em> by the wall.</p>";
    const editedText = plainTextOfHtml(edited);
    const match = locateAnchor(anchor, editedText);
    expect(match.state).toBe("moved");
    const host = element(markHtml(edited, [passage("a-1", match.start, match.end, { state: match.state })]));
    expect(Array.from(host.querySelectorAll("mark")).map((mark) => mark.textContent).join("")).toBe("old steel");
    expect(host.querySelector("mark")?.getAttribute("data-anchor-state")).toBe("moved");
    host.remove();
  });
});
