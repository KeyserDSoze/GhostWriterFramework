import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, ListChecks, Loader2 } from "lucide-react";
import type { AutopilotActivity } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { TimelineFilters } from "@/components/autopilot/timeline/Filters";
import { TimelineGroupView } from "@/components/autopilot/timeline/Group";
import { TimelineLive } from "@/components/autopilot/timeline/Live";
import { formatClock } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { buildTimeline, filterCounts, filterTimeline, type TimelineFilter } from "@/autopilot/timelineModel";
import { useTimelinePrefs } from "@/autopilot/timelinePrefs";

export interface AutopilotTimelineProps {
  bookId: string;
  /** The log of the steps is still being read. */
  loading?: boolean;
  /** The steps of the log, oldest first, as the snapshot of the book has them. */
  activities: readonly AutopilotActivity[];
  /** The title of a chapter of the plan, for the header of its groups; asked only for the chapters that are shown. */
  chapterTitle?: (number: number) => string | undefined;
  currency?: string;
}

/**
 * Everything that happened in a book, as one list: the steps of the log and what happened around them (the notes of the readers, the specialists and
 * the director, the retries, the runs), in groups for each chapter and round, the one in hand open. At its top the text the step that runs is writing.
 * It replaces the list of the steps and the live feed that said the same things twice. The page that holds it does not draw it again for what it
 * does not show: it is kept as it is until the log, the events of the book or what the author chose change.
 */
export const AutopilotTimeline = memo(function AutopilotTimeline({ bookId, loading = false, activities, chapterTitle, currency }: AutopilotTimelineProps) {
  const { t } = useTranslation();
  const feed = useAutopilotStore((state) => state.feed);
  const running = useAutopilotStore((state) => state.live[bookId]?.activity ?? null);
  const [prefs, change] = useTimelinePrefs(bookId);
  const events = useMemo(() => feed.filter((entry) => entry.event.bookId === bookId).map((entry) => entry.event), [feed, bookId]);
  const timeline = useMemo(() => buildTimeline({ activities, events, running, since: prefs.since }), [activities, events, running, prefs.since]);
  const counts = useMemo(() => filterCounts(timeline), [timeline]);
  const shown = useMemo(() => filterTimeline(timeline, prefs.filter), [timeline, prefs.filter]);
  // Which groups the author opened or closed; the others are open or closed as the timeline says (the one in hand is open).
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => setChosen((current) => ({ ...current, [key]: !(current[key] ?? key === shown.open) })), [shown.open]);
  // What a screen reader is told when the author changes what is shown, and only then: the list changes under the author's hand with every step.
  const [announcement, setAnnouncement] = useState("");
  const choose = (filter: TimelineFilter) => {
    change({ filter });
    setAnnouncement(t("autopilot.timeline.announce", { filter: t(`autopilot.timeline.filter.${filter}`), count: counts[filter] }));
  };
  const everything = counts.all;
  const nothing = !loading && everything === 0 && !timeline.groups.some((group) => group.running);

  return (
    <section data-autopilot-timeline aria-labelledby="autopilot-timeline-title" className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="autopilot-timeline-title" className="flex items-center gap-2 text-base font-semibold"><ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />{t("autopilot.activity.title")}</h2>
        <Button variant="ghost" size="sm" disabled={everything === 0} onClick={() => change({ since: new Date().toISOString() })}>
          <EyeOff className="h-4 w-4" aria-hidden="true" />{t("autopilot.timeline.hide")}
        </Button>
      </div>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</p>
      ) : (
        <>
          {prefs.since && (
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{everything === 0 ? t("autopilot.timeline.nothingNew") : t("autopilot.timeline.hidden", { count: timeline.hidden, time: formatClock(prefs.since) })}</span>
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => change({ since: null })}>{t("autopilot.timeline.showHidden")}</Button>
            </p>
          )}
          {nothing && !prefs.since && <p className="text-sm text-muted-foreground">{t("autopilot.activity.empty")}</p>}
          {everything > 0 && <TimelineFilters bookId={bookId} value={prefs.filter} counts={counts} onChange={choose} />}
          <TimelineLive bookId={bookId} />
          {shown.groups.length === 0 && everything > 0 ? (
            <div className="space-y-2 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>{t("autopilot.timeline.empty")}</p>
              <Button variant="outline" size="sm" onClick={() => choose("all")}>{t("autopilot.timeline.showAll")}</Button>
            </div>
          ) : (
            <ol className="space-y-2">
              {shown.groups.map((group) => <TimelineGroupView key={group.key} group={group} open={chosen[group.key] ?? group.key === shown.open} onToggle={toggle} chapterTitle={chapterTitle} currency={currency} />)}
            </ol>
          )}
        </>
      )}
      <p role="status" className="sr-only">{announcement}</p>
    </section>
  );
});
