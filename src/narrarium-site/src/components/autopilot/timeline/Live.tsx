import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { PREVIEW_CHARACTERS } from "@/components/autopilot/band/parts";
import { useAutopilotStore } from "@/autopilot/store";

/**
 * The step that runs, at the top of the timeline: the text it writes, whole, and why it does it and what comes next. Not its title or its time: the
 * band says them, once. It follows the store by itself, so that the list under it is not drawn again for every chunk of text, and it is not a live
 * region: nothing in it is read out as it comes. The text is shown when it has more to show than the one line of the band.
 */
export const TimelineLive = memo(function TimelineLive({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const live = useAutopilotStore((state) => state.live[bookId] ?? null);
  if (!live) return null;
  const { activity, preview, characters } = live;
  const text = preview.trim();
  const long = text.replace(/\s+/g, " ").length > PREVIEW_CHARACTERS;
  if (!long && !activity.reason && !activity.next) return null;
  return (
    <div data-timeline-live className="space-y-1.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("autopilot.timeline.live")}
      </p>
      {activity.reason && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.why")}:</span> {activity.reason}</p>}
      {activity.next && <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground/80">{t("autopilot.next")}:</span> {activity.next}</p>}
      {long && (
        <p className="max-h-40 overflow-hidden whitespace-pre-wrap rounded-md bg-background/70 p-2 font-serif text-xs italic leading-relaxed text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">{text}</p>
      )}
      {long && characters > 0 && <p className="text-xs tabular-nums text-muted-foreground">{t("autopilot.characters", { count: characters })}</p>}
    </div>
  );
});
