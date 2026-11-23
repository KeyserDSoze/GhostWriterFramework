import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { ModelAnswering } from "@/components/autopilot/band/parts";
import { cutAtTop } from "@/components/autopilot/live/StreamLines";
import { taskElementId } from "@/autopilot/liveText";
import { useAutopilotStore } from "@/autopilot/store";
import { cn } from "@/lib/utils";

/**
 * The step that runs, at the top of the timeline: the text it writes, whole, and why it does it and what comes next. Not its title or its time: the
 * band says them, once. It follows the store by itself, so that the list under it is not drawn again for every chunk of text, and it is not a live
 * region: nothing in it is read out as it comes.
 *
 * It is there for as long as a step runs, with the anchor of the step (`#task-<id>`): the lines of the mini-player, of the band and of the page of every
 * book lead here, and it takes the focus they send. The text is in it when there is more of it than the band above it shows (`shownAbove`). When the step it holds is over while it has the focus, `onFocusLost` says so, and the timeline gives
 * the focus to the step's row, which takes its place.
 */
export const TimelineLive = memo(function TimelineLive({ bookId, shownAbove = 0, onFocusLost }: { bookId: string; shownAbove?: number; onFocusLost?: (activityId: string) => void }) {
  const { t } = useTranslation();
  const live = useAutopilotStore((state) => state.live[bookId] ?? null);
  const block = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const focused = useRef(false);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  const activityId = live?.activity.id;
  // The focus is somewhere else as soon as something else takes it.
  useEffect(() => {
    const away = (event: FocusEvent) => {
      if (!block.current?.contains(event.target as Node | null)) focused.current = false;
    };
    document.addEventListener("focusin", away);
    return () => document.removeEventListener("focusin", away);
  }, []);
  useEffect(() => () => {
    // The step is over (or another began) with the focus still here: the block it was in is gone, and the focus with it.
    const nowhere = !document.activeElement || document.activeElement === document.body;
    if (activityId && focused.current && nowhere) lost.current?.(activityId);
    focused.current = false;
  }, [activityId]);
  const answering = live?.bytes !== undefined;
  const whole = live && !answering ? live.preview.trim() : "";
  // The text is here when it has more to show than the band above shows of it (`shownAbove` characters, none where the band shows none): never the same text twice.
  const text = whole.replace(/\s+/g, " ").length > shownAbove ? whole : "";
  // The top of a text taller than the box fades, and only then: a short text is read whole.
  useLayoutEffect(() => {
    setCut(cutAtTop(textBox.current));
  }, [text]);
  if (!live) return null;
  const { activity, characters } = live;
  return (
    <div
      ref={block}
      id={taskElementId(activity.id)}
      tabIndex={-1}
      onFocus={() => { focused.current = true; }}
      data-timeline-live
      className="scroll-mt-8 space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
        {t("autopilot.timeline.live")}
      </p>
      {activity.reason && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.why")}:</span> {activity.reason}</p>}
      {activity.next && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.next")}:</span> {activity.next}</p>}
      {text && (
        <p ref={textBox} className={cn("flex max-h-40 flex-col justify-end overflow-hidden whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-serif text-xs italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]", cut && "[mask-image:linear-gradient(to_bottom,transparent,black_35%)]")}><span>{text}</span></p>
      )}
      {text && characters > 0 && <p className="text-xs tabular-nums text-muted-foreground">{t("autopilot.characters", { count: characters })}</p>}
      <ModelAnswering bookId={bookId} />
    </div>
  );
});
