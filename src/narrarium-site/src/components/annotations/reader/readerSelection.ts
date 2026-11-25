import { anchorFromRange } from "@/annotations/anchoring";
import type { TextAnchor } from "@/annotations/model";
import { rangeOffsets } from "@/annotations/textModel";

/** A passage selected in the reader: the scene it starts in and its anchor in the plain text of that scene. */
export interface ReaderSelection {
  chapterSlug: string;
  paragraphSlug: string;
  paragraphNumber: string;
  anchor: TextAnchor;
  /** The selected range, kept: the browser hides the selection as soon as the focus moves into a menu or a dialog. */
  range: Range;
}

/**
 * The selection of the page as a passage of the reader: the part of it in the first scene it touches (a selection across two scenes is cut to the first),
 * or null when it holds no text of a scene of `flow`.
 */
export function readerSelectionOf(flow: Element | null, selection: Selection | null): ReaderSelection | null {
  if (!flow || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!flow.contains(range.startContainer) && !flow.contains(range.endContainer) && !range.intersectsNode(flow)) return null;
  for (const scene of Array.from(flow.querySelectorAll<HTMLElement>("[data-reader-paragraph]"))) {
    const prose = scene.querySelector(".reader-prose");
    const chapterSlug = scene.dataset.chapterSlug;
    const paragraphSlug = scene.dataset.paragraphSlug;
    if (!prose || !chapterSlug || !paragraphSlug || !range.intersectsNode(prose)) continue;
    const offsets = rangeOffsets(prose, range);
    if (!offsets) continue;
    const anchor = anchorFromRange(offsets.model.text, offsets.start, offsets.end);
    if (!anchor) continue;
    return {
      chapterSlug,
      paragraphSlug,
      paragraphNumber: scene.dataset.paragraphNumber ?? "",
      anchor: { quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, offset: anchor.offset },
      range: range.cloneRange(),
    };
  }
  return null;
}

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

/** The passage being annotated stays visible while the focus is in the menu or the dialog (CSS Custom Highlight API, where the browser has it). */
export function showPendingPassage(range: Range | null): void {
  const registry = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || !Highlight) return;
  if (range) registry.set("annotation-pending", new Highlight(range));
  else registry.delete("annotation-pending");
}
