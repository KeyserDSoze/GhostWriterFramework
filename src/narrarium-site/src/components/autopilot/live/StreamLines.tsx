import { memo, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { activityTitle } from "@/autopilot/format";
import { PHONE_SCREENS, STREAM_LINES, STREAM_LINES_PHONE, streamTail, taskHref } from "@/autopilot/liveText";
import { useThrottledStream } from "@/autopilot/useLiveText";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

/** The height of the lines: three, or two on a phone, of `leading-5` (1.25rem each), so that they grow with the text when it is enlarged. */
const HEIGHT: Record<number, string> = { 2: "max-h-10", 3: "max-h-[3.75rem]" };

/** The top line of a text that goes on above it fades, and can still be read. */
const FADE = "linear-gradient(to bottom, rgb(0 0 0 / 0.35), black 1.25rem)";

/**
 * Whether the text in `box` (its one child) is taller than the room the box gives it. The box keeps the end of the text at its bottom, so what does not
 * fit goes out at the top, where the box's scroll height does not count it: the text is measured instead.
 */
export function cutAtTop(box: HTMLElement | null): boolean {
  const text = box?.firstElementChild;
  if (!box || !text) return false;
  const style = getComputedStyle(box);
  const room = box.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  return text.getBoundingClientRect().height > room + 1;
}

/**
 * The last lines of the text the step of a book is writing: the end of the tail the live events carry, three lines (two on a phone), the newest at the
 * bottom and what does not fit cut at the top, with a fade there when it is cut. It follows the text at most four times a second and is never read
 * out as it changes: it is not a live region (the polite status of the surface says when a step answers and when it is done). The whole block leads
 * to the step on the Autopilot page, where it is written in full. A step that answers with a value has no prose: it shows nothing here (the line of
 * the answer says how much has arrived).
 */
export const StreamLines = memo(function StreamLines({ bookId, lines, className, preview = false }: { bookId: string; lines?: 2 | 3; className?: string; preview?: boolean }) {
  const { t } = useTranslation();
  const stream = useThrottledStream(bookId);
  const phone = useMediaQuery(PHONE_SCREENS);
  const count = lines ?? (phone ? STREAM_LINES_PHONE : STREAM_LINES);
  const box = useRef<HTMLSpanElement>(null);
  const text = stream && !stream.answering ? streamTail(stream.preview, stream.characters) : "";
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    setCut(cutAtTop(box.current));
  }, [text, count]);
  if (!stream || !text) return null;
  const step = activityTitle(t, stream.activity);
  return (
    <Link
      to={taskHref(bookId, stream.activity.id)}
      data-stream-lines={count}
      data-band-preview={preview ? "" : undefined}
      aria-label={t("autopilot.liveText.open", { step })}
      className={cn("-mx-1.5 block rounded-lg px-1.5 py-1 transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    >
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium">{t("autopilot.liveText.writing")}</span>
        <span className="tabular-nums">{t("autopilot.characters", { count: stream.characters })}</span>
      </span>
      <span
        ref={box}
        data-stream-text
        className={cn("mt-0.5 flex flex-col justify-end overflow-hidden whitespace-pre-line break-words font-serif text-sm leading-5 text-foreground/90 [overflow-wrap:anywhere]", HEIGHT[count])}
        style={cut ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
      >
        <span>{text}</span>
      </span>
    </Link>
  );
});
