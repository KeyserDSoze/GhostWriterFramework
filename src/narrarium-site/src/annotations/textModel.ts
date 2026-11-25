import type { AnchorState } from "./anchoring";
import { markIconMarkup } from "./icons";
import type { MarkColor, MarkIcon, MarkUnderline } from "./model";

/**
 * The plain text of a scene as the reader shows it, and the way back from it to the page: the one text every anchor is written in.
 *
 * The text is the text of the rendered scene in document order, with every run of white space made one space and a space between blocks
 * (paragraphs, headings, list items, line breaks), trimmed. So it is the same whatever the reader's line-break mode (the modes only regroup lines and
 * blocks), and the same with or without the marks and their icons: what the annotations add to the page carries `data-annotation-ui` and is left out.
 */

export const ANNOTATION_UI_ATTRIBUTE = "data-annotation-ui";

const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const SKIPPED_ELEMENTS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export interface TextModelNode {
  node: Text;
  /** For each offset in the node (0 to its length), the place in the plain text that it falls on. */
  positions: number[];
}

export interface TextModel {
  text: string;
  nodes: TextModelNode[];
  byNode: Map<Node, TextModelNode>;
}

const isSpace = (character: string) => /\s/.test(character);

export function buildTextModel(root: Node): TextModel {
  const out: string[] = [];
  let length = 0;
  let pendingSpace = false;
  const nodes: TextModelNode[] = [];
  const byNode = new Map<Node, TextModelNode>();

  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      const textNode = node as Text;
      const value = textNode.data;
      const positions = new Array<number>(value.length + 1);
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (isSpace(character)) {
          pendingSpace = true;
          positions[index] = length;
          continue;
        }
        if (pendingSpace && length > 0) {
          out.push(" ");
          length += 1;
        }
        pendingSpace = false;
        positions[index] = length;
        out.push(character);
        length += 1;
      }
      positions[value.length] = length;
      const entry = { node: textNode, positions };
      nodes.push(entry);
      byNode.set(textNode, entry);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }
    const element = node as Element;
    if (SKIPPED_ELEMENTS.has(element.tagName) || element.hasAttribute(ANNOTATION_UI_ATTRIBUTE)) return;
    const block = BLOCK_ELEMENTS.has(element.tagName);
    if (block) pendingSpace = true;
    for (const child of Array.from(element.childNodes)) visit(child);
    if (block) pendingSpace = true;
  };

  visit(root);
  return { text: out.join(""), nodes, byNode };
}

/** Where a boundary of a DOM range (a node and an offset in it) falls in the plain text. */
export function boundaryIndex(model: TextModel, container: Node, offset: number): number {
  const entry = model.byNode.get(container);
  if (entry) return entry.positions[Math.max(0, Math.min(offset, entry.positions.length - 1))];
  const document = container.ownerDocument ?? (container as Document);
  const point = document.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  for (const candidate of model.nodes) {
    // The first text of the model at or after the boundary: its first place is the boundary's.
    if (point.comparePoint(candidate.node, 0) >= 0) return candidate.positions[0];
    if (point.comparePoint(candidate.node, candidate.node.length) >= 0) return candidate.positions[candidate.node.length];
  }
  return model.text.length;
}

/** The part of `range` inside `element`, or null when they do not meet. */
export function intersectRange(range: Range, element: Element): Range | null {
  const bounds = element.ownerDocument.createRange();
  bounds.selectNodeContents(element);
  // START_TO_END compares the range's end with the element's start; END_TO_START the range's start with the element's end.
  if (range.compareBoundaryPoints(Range.START_TO_END, bounds) <= 0 || range.compareBoundaryPoints(Range.END_TO_START, bounds) >= 0) return null;
  const result = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) result.setStart(bounds.startContainer, bounds.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) result.setEnd(bounds.endContainer, bounds.endOffset);
  return result.collapsed ? null : result;
}

/** The selection `range` in the plain text of `element` (a scene of the reader): null when it holds nothing of it. */
export function rangeOffsets(element: Element, range: Range): { model: TextModel; start: number; end: number } | null {
  const inside = intersectRange(range, element);
  if (!inside) return null;
  const model = buildTextModel(element);
  const start = boundaryIndex(model, inside.startContainer, inside.startOffset);
  const end = boundaryIndex(model, inside.endContainer, inside.endOffset);
  return end > start ? { model, start, end } : null;
}

// ─── Marks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MarkedPassage {
  /** The annotation's id. */
  id: string;
  start: number;
  end: number;
  underline: MarkUnderline;
  color: MarkColor;
  icon: MarkIcon;
  state: AnchorState;
  /** The accessible name of the control that opens the annotation: its tag and its note. */
  label: string;
}

interface Segment {
  start: number;
  end: number;
  passages: MarkedPassage[];
  /** A passage starts (ends) where the segment does: white space at that edge stays out of the mark. */
  trimStart: boolean;
  trimEnd: boolean;
}

function segmentsOf(passages: readonly MarkedPassage[], length: number): Segment[] {
  const clamped = passages
    .map((passage) => ({ ...passage, start: Math.max(0, Math.min(length, passage.start)), end: Math.max(0, Math.min(length, passage.end)) }))
    .filter((passage) => passage.end > passage.start);
  const bounds = [...new Set(clamped.flatMap((passage) => [passage.start, passage.end]))].sort((left, right) => left - right);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const start = bounds[index];
    const end = bounds[index + 1];
    const covering = clamped.filter((passage) => passage.start <= start && passage.end >= end)
      .sort((left, right) => left.start - right.start || (left.id < right.id ? -1 : 1));
    if (covering.length) {
      segments.push({ start, end, passages: covering, trimStart: covering.some((passage) => passage.start === start), trimEnd: covering.some((passage) => passage.end === end) });
    }
  }
  return segments;
}

function rawSpan(entry: TextModelNode, start: number, end: number): [number, number] | null {
  const value = entry.node.data;
  let from = -1;
  let to = -1;
  for (let index = 0; index < value.length; index += 1) {
    const at = entry.positions[index];
    if (at >= start && at < end) {
      if (from < 0) from = index;
      to = index;
    }
  }
  if (from < 0 || !value.slice(from, to + 1).trim()) return null;
  return [from, to + 1];
}

/**
 * The HTML of a scene with its marks: each passage wrapped in `<mark>` elements (one per piece of text it covers; where two passages overlap the
 * piece carries both ids and the style of the one that starts first), and after the last piece of each passage a button with its icon, which a
 * keyboard reaches and a screen reader names. Everything is made with the DOM, from text and fixed markup: nothing of the annotations is read as HTML.
 */
export function markHtml(html: string, passages: readonly MarkedPassage[], parser: DOMParser = new DOMParser()): string {
  if (!passages.length) return html;
  const document = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = document.body.firstElementChild;
  if (!root) return html;
  const model = buildTextModel(root);
  const operations: Array<{ entry: TextModelNode; order: number; from: number; to: number; segment: Segment }> = [];
  for (const segment of segmentsOf(passages, model.text.length)) {
    const pieces: Array<{ entry: TextModelNode; order: number; from: number; to: number; segment: Segment }> = [];
    model.nodes.forEach((entry, order) => {
      const span = rawSpan(entry, segment.start, segment.end);
      if (span) pieces.push({ entry, order, from: span[0], to: span[1], segment });
    });
    // White space between the pieces of a passage stays marked (the line goes on under it); at the passage's own edges it stays out.
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    if (first && segment.trimStart) while (first.from < first.to && isSpace(first.entry.node.data[first.from])) first.from += 1;
    if (last && segment.trimEnd) while (last.to > last.from && isSpace(last.entry.node.data[last.to - 1])) last.to -= 1;
    operations.push(...pieces.filter((piece) => piece.to > piece.from));
  }
  // From the end of each text node backwards, so that splitting a node leaves the offsets of the pieces before it as they were.
  operations.sort((left, right) => left.order - right.order || right.from - left.from);
  const lastPiece = new Map<string, Element>();
  for (const operation of operations) {
    const node = operation.entry.node;
    node.splitText(operation.to);
    const middle = node.splitText(operation.from);
    const mark = document.createElement("mark");
    const primary = operation.segment.passages[0];
    mark.className = "reader-annotation";
    mark.setAttribute("data-annotation-id", primary.id);
    mark.setAttribute("data-annotation-ids", operation.segment.passages.map((passage) => passage.id).join(" "));
    mark.setAttribute("data-mark-underline", primary.underline);
    mark.setAttribute("data-mark-color", primary.color);
    mark.setAttribute("data-anchor-state", primary.state);
    if (operation.segment.passages.length > 1) mark.setAttribute("data-annotation-overlap", "");
    middle.replaceWith(mark);
    mark.append(middle);
  }
  for (const mark of Array.from(root.querySelectorAll("mark.reader-annotation"))) {
    for (const id of (mark.getAttribute("data-annotation-ids") ?? "").split(" ")) if (id) lastPiece.set(id, mark);
  }
  const ending = new Map<Element, MarkedPassage[]>();
  for (const passage of passages) {
    const mark = lastPiece.get(passage.id);
    if (!mark) continue;
    // A button is never put inside another control (a name of the canon is a button in the reader): the icons go after it.
    const anchor = mark.parentElement?.closest("button, a") ?? mark;
    ending.set(anchor, [...(ending.get(anchor) ?? []), passage]);
  }
  for (const [anchor, ended] of ending) {
    const tail = document.createElement("span");
    tail.className = "reader-annotation-tail";
    if (anchor.tagName === "MARK") {
      // The icons stay on the line of the last word of the passage: the word and the icons go in a piece that does not break, and the rest of the
      // passage (in a mark of its own, with the same ids) breaks as the text does.
      const text = anchor.firstChild?.nodeType === TEXT_NODE ? (anchor.firstChild as Text) : null;
      const lastSpace = text ? text.data.search(/\s(?=\S+\s*$)/) : -1;
      if (text && lastSpace >= 0) {
        const word = text.splitText(lastSpace + 1);
        const head = anchor.cloneNode(false) as Element;
        head.setAttribute("data-mark-piece", "head");
        anchor.setAttribute("data-mark-piece", "tail");
        anchor.before(head);
        head.append(text);
        anchor.append(word);
      }
    }
    anchor.replaceWith(tail);
    tail.append(anchor);
    for (const passage of ended) {
      const icon = document.createElement("button");
      icon.type = "button";
      icon.className = "reader-annotation-icon";
      icon.setAttribute(ANNOTATION_UI_ATTRIBUTE, "");
      icon.setAttribute("data-annotation-id", passage.id);
      icon.setAttribute("data-mark-color", passage.color);
      icon.setAttribute("aria-label", passage.label);
      icon.innerHTML = markIconMarkup(passage.icon);
      tail.append(icon);
    }
  }
  return root.innerHTML;
}

/** The plain text of a scene's HTML, as the reader would show it. */
export function plainTextOfHtml(html: string, parser: DOMParser = new DOMParser()): string {
  const document = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const root = document.body.firstElementChild;
  return root ? buildTextModel(root).text : "";
}
