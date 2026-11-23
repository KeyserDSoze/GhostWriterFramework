import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_VIEWPORT, estimateHeight, metricsOf, offsetsOf, windowOf, type PaneMetrics } from "@/components/autopilot/calls/textWindow";
import type { TextBuffer } from "@/components/autopilot/calls/textBuffer";
import { TARGET } from "@/components/autopilot/calls/ui";
import { cn } from "@/lib/utils";

/** How far from the end of the text the reader may be and still be following it, in pixels. */
const FOLLOW_SLACK = 24;

/** The heights of the blocks of a text: estimated from their lines until a block is drawn, then measured. A text that starts again forgets them. */
class BlockHeights {
  private key = "";
  private lengths: number[] = [];
  private estimates: number[] = [];
  private readonly measured = new Map<number, { length: number; height: number }>();

  heights(blocks: readonly string[], metrics: PaneMetrics, key: string): number[] {
    if (key !== this.key) {
      this.key = key;
      this.lengths = [];
      this.estimates = [];
      this.measured.clear();
    }
    if (blocks.length < this.lengths.length) {
      this.lengths.length = blocks.length;
      this.estimates.length = blocks.length;
    }
    const heights = new Array<number>(blocks.length);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (this.lengths[index] !== block.length) {
        this.lengths[index] = block.length;
        this.estimates[index] = estimateHeight(block, metrics);
      }
      const measured = this.measured.get(index);
      heights[index] = measured && measured.length === block.length ? measured.height : this.estimates[index];
    }
    return heights;
  }

  /** Keeps what a drawn block measures; says whether it changed anything. */
  measure(index: number, length: number, height: number): boolean {
    const known = this.measured.get(index);
    if (known && known.length === length && Math.abs(known.height - height) < 0.5) return false;
    this.measured.set(index, { length, height });
    return true;
  }
}

/** One block of the text, drawn once: a full block never changes, so it is never drawn again. It says how tall it is once drawn. */
const Block = memo(function Block({ index, length, text, raw, measureKey, onMeasure }: { index: number; length: number; text: string; raw: boolean; measureKey: number; onMeasure: (index: number, length: number, height: number) => void }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const height = element.current?.offsetHeight ?? 0;
    if (height > 0) onMeasure(index, length, height);
  }, [index, length, text, raw, measureKey, onMeasure]);
  return <div ref={element} data-text-block={index} className={raw ? "w-max min-w-full whitespace-pre" : "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"}>{text}</div>;
});

const later = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
};

export interface TextPaneProps {
  /** The name of the region, for a screen reader: which text of which call. */
  label: string;
  buffer: TextBuffer;
  /** The version of the text the owner drew it at (it changes at most four times a second). */
  version: number;
  raw: boolean;
  /** The text is still arriving: the region is busy, and it keeps the end in sight unless the reader scrolls up. */
  streaming: boolean;
  /** Drawn after the text: what the live events have that the record does not yet. */
  extra?: string;
  /** What the region says while it has no text at all. */
  placeholder?: ReactNode;
  /** The text is code (JSON laid out): a fixed-width font, its lines still wrapped. */
  mono?: boolean;
  className?: string;
}

/**
 * A text of a call in a region of its own that scrolls: the text in blocks, of which only the ones near where the reader is are drawn (the others are
 * an empty room of their height), so that a response of megabytes is a few dozen elements. It is never a live region: what streams in is not read
 * out. While the text arrives it is busy, and it keeps its end in sight; when the reader scrolls up it stays where they are, and «Follow the text» takes
 * them back to the end. It scrolls by jumps, never smoothly. In Raw the text is exact, in a fixed-width font, and its long lines scroll sideways inside it.
 */
export const TextPane = memo(function TextPane({ label, buffer, version, raw, streaming, extra = "", placeholder, mono = false, className }: TextPaneProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const cache = useRef<BlockHeights | null>(null);
  cache.current ??= new BlockHeights();
  // The size of its font and of its lines, in pixels, as the page lays it out (read, never set).
  const [view, setView] = useState({ top: 0, height: 0, width: 0, fontPx: 0, linePx: 0 });
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  followingRef.current = following;
  const [measured, setMeasured] = useState(0);
  const [measureKey, setMeasureKey] = useState(0);
  const follows = streaming && following;

  // The size of the region and of its lines, read when it is laid out and when it changes size (the blocks are measured again then).
  const readView = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    const fontPx = Number.parseFloat(style?.fontSize ?? "") || 0;
    const linePx = Number.parseFloat(style?.lineHeight ?? "") || 0;
    const next = { top: element.scrollTop, height: element.clientHeight, width: element.clientWidth, fontPx, linePx };
    setView((before) => (before.top === next.top && before.height === next.height && before.width === next.width && before.fontPx === next.fontPx && before.linePx === next.linePx ? before : next));
  }, []);
  useLayoutEffect(() => {
    readView();
    const element = scroller.current;
    if (!element || typeof ResizeObserver !== "function") return undefined;
    let cancel: (() => void) | null = null;
    const observer = new ResizeObserver(() => {
      cancel?.();
      cancel = later(() => {
        readView();
        setMeasureKey((key) => key + 1);
      });
    });
    observer.observe(element);
    return () => {
      cancel?.();
      observer.disconnect();
    };
  }, [readView, raw]);

  const metrics = useMemo(() => metricsOf(view.width, view.fontPx, view.linePx, !raw, raw || mono), [view.width, view.fontPx, view.linePx, raw, mono]);
  // The blocks as they were at the version the owner drew: the buffer grows in place between two drawings, and a drawing for another reason (a
  // measure, a scroll) shows the same text as the one before it.
  const blocks = useMemo(() => buffer.blocks.slice(), [buffer, version, buffer.generation]);
  // The heights change with the blocks, with how the pane lays them out, and with what is measured of them.
  const offsets = useMemo(() => offsetsOf((cache.current as BlockHeights).heights(blocks, metrics, `${buffer.generation}:${raw}:${metrics.perLine}:${metrics.lineHeight}`)), [blocks, buffer.generation, metrics, raw, measured]);
  const viewport = view.height > 0 ? view.height : DEFAULT_VIEWPORT;
  const total = offsets[offsets.length - 1];
  const top = follows ? Math.max(0, total - viewport) : view.top;
  const { start, end, before, after } = windowOf(offsets, top, viewport, viewport);
  const last = blocks.length - 1;

  const onMeasure = useCallback((index: number, length: number, height: number) => {
    if ((cache.current as BlockHeights).measure(index, length, height)) setMeasured((count) => count + 1);
  }, []);

  // While it follows, the end of the text stays in sight after every drawing (a jump, never a smooth scroll).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (follows && element) element.scrollTop = element.scrollHeight;
  });

  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), []);
  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    if (streaming) {
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
      if (atEnd !== followingRef.current) setFollowing(atEnd);
    }
    if (!pending.current) {
      pending.current = later(() => {
        pending.current = null;
        readView();
      });
    }
  };

  const follow = () => {
    setFollowing(true);
    const element = scroller.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      // The button goes away under the finger: the reader goes on from the text it took them to.
      element.focus({ preventScroll: true });
    }
  };

  const empty = blocks.length === 0 && !extra;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div
        ref={scroller}
        role="region"
        aria-label={label}
        aria-busy={streaming || undefined}
        tabIndex={0}
        onScroll={onScroll}
        data-text-pane
        data-raw={raw ? "" : undefined}
        className={cn(
          "relative max-h-[min(60vh,28rem)] min-w-0 max-w-full overflow-y-auto rounded-md border bg-muted/30 px-2 py-1.5 leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5 sm:py-2",
          raw ? "overflow-x-auto font-mono text-xs" : cn("overflow-x-hidden", mono ? "font-mono text-xs" : "text-sm"),
        )}
      >
        {empty ? (
          <p className="text-sm text-muted-foreground">{placeholder}</p>
        ) : blocks.length === 0 ? (
          <div className={raw ? "w-max min-w-full whitespace-pre" : "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"}>{extra}</div>
        ) : (
          <>
            {before > 0 && <div aria-hidden="true" data-text-gap style={{ height: before }} />}
            {Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              return <Block key={index} index={index} length={blocks[index].length} text={index === last ? blocks[index] + extra : blocks[index]} raw={raw} measureKey={measureKey} onMeasure={onMeasure} />;
            })}
            {after > 0 && <div aria-hidden="true" data-text-gap style={{ height: after }} />}
          </>
        )}
      </div>
      {streaming && !following && (
        <Button type="button" variant="outline" size="sm" onClick={follow} data-follow-text className={cn("h-auto", TARGET)}>
          <ArrowDownToLine aria-hidden="true" />
          {t("autopilot.calls.pane.follow")}
        </Button>
      )}
    </div>
  );
});
