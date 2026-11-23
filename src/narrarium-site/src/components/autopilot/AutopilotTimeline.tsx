import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EyeOff, ListChecks, Loader2 } from "lucide-react";
import type { AutopilotActivity, AutopilotFinalReview, ChapterRound } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { TimelineFilters } from "@/components/autopilot/timeline/Filters";
import { TimelineGroupView } from "@/components/autopilot/timeline/Group";
import { TimelineLive } from "@/components/autopilot/timeline/Live";
import { formatClock } from "@/autopilot/format";
import { useAutopilotStore } from "@/autopilot/store";
import { buildTimeline, filterCounts, filterTimeline, locateTask, type TimelineFilter } from "@/autopilot/timelineModel";
import { taskElementId, taskIdOfHash } from "@/autopilot/liveText";
import { useTimelinePrefs } from "@/autopilot/timelinePrefs";

export interface AutopilotTimelineProps {
  bookId: string;
  /** The log of the steps is still being read. */
  loading?: boolean;
  /** The steps of the log, oldest first, as the snapshot of the book has them. */
  activities: readonly AutopilotActivity[];
  /** The title of a chapter of the plan, for the header of its groups; asked only for the chapters that are shown. */
  chapterTitle?: (number: number) => string | undefined;
  /** The name of the ghostwriter the outline gives a chapter, when it is not the book's, for the header of its groups. */
  chapterGhostwriter?: (number: number) => string | undefined;
  /** The rounds of review the plan recorded for a chapter, oldest first, for the numbers of the rounds and their votes; asked only for the chapters the log has. */
  chapterRounds?: (number: number) => readonly ChapterRound[] | undefined;
  /** What the engine says of the whole book, for the header of its review. */
  finalReview?: Pick<AutopilotFinalReview, "verdict" | "score"> | null;
  currency?: string;
  /** How much of the text that streams the band above the history shows (its characters; 0 where the band shows none): the block of the step that runs shows the text only when there is more of it. */
  shownAbove?: number;
}

/**
 * Everything that happened in a book, as one list: the steps of the log and what happened around them (the notes of the readers, the specialists and
 * the director, the retries, the runs), in groups for each chapter and round, the one in hand open. At its top the text the step that runs is writing.
 * It replaces the list of the steps and the live feed that said the same things twice. The page that holds it does not draw it again for what it
 * does not show: it is kept as it is until the log, the events of the book or what the author chose change.
 */
export const AutopilotTimeline = memo(function AutopilotTimeline({ bookId, loading = false, activities, chapterTitle, chapterGhostwriter, chapterRounds, finalReview, currency, shownAbove = 0 }: AutopilotTimelineProps) {
  const { t } = useTranslation();
  const feed = useAutopilotStore((state) => state.feed);
  const running = useAutopilotStore((state) => state.live[bookId]?.activity ?? null);
  const [prefs, change] = useTimelinePrefs(bookId);
  const events = useMemo(() => feed.filter((entry) => entry.event.bookId === bookId).map((entry) => entry.event), [feed, bookId]);
  const timeline = useMemo(() => buildTimeline({ activities, events, running, since: prefs.since, rounds: chapterRounds, finalReview }), [activities, events, running, prefs.since, chapterRounds, finalReview]);
  const counts = useMemo(() => filterCounts(timeline), [timeline]);
  const shown = useMemo(() => filterTimeline(timeline, prefs.filter), [timeline, prefs.filter]);
  // Which groups the author opened or closed; the others are open or closed as the timeline says (the one in hand is open).
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => setChosen((current) => ({ ...current, [key]: !(current[key] ?? key === shown.open) })), [shown.open]);

  // A link to a step (`#task-<id>`, from the mini-player, the band or the page of every book) shows it, whatever hides it: «Hide until now» and the filter
  // are taken back when they hide it, its group opens, and its row opens (the page then scrolls to it and gives it the focus). Once for each visit of the
  // link; a step the log does not have yet is looked for again when the log changes. The step that runs is the block at the top, always there.
  const location = useLocation();
  const target = taskIdOfHash(location.hash);
  const [reveal, setReveal] = useState<{ group: string; row: string; activityId: string } | null>(null);
  const followed = useRef<string | null>(null);
  const showTask = useCallback((activityId: string, visit: string): boolean => {
    const everything = prefs.since ? buildTimeline({ activities, events, running, since: null, rounds: chapterRounds, finalReview }) : timeline;
    const at = locateTask(everything, activityId);
    if (!at) return false;
    followed.current = visit;
    const hiddenUntilNow = Boolean(prefs.since) && !locateTask(timeline, activityId);
    const filtered = !locateTask(filterTimeline(everything, prefs.filter), activityId);
    if (hiddenUntilNow || filtered) change({ ...(hiddenUntilNow ? { since: null } : {}), ...(filtered ? { filter: "all" } : {}) });
    setChosen((current) => (current[at.group] ? current : { ...current, [at.group]: true }));
    setReveal({ group: at.group, row: at.row, activityId });
    return true;
  }, [activities, events, running, chapterRounds, finalReview, prefs.since, prefs.filter, timeline, change]);
  useEffect(() => {
    if (!target || loading) return;
    const visit = `${location.key}:${target}`;
    if (followed.current === visit) return;
    if (running?.id === target) {
      followed.current = visit;
      return;
    }
    showTask(target, visit);
  }, [target, location.key, loading, running?.id, showTask]);
  // The block of the step that runs had the focus and the step is over: the focus goes to its row, which takes its place.
  const [refocus, setRefocus] = useState<string | null>(null);
  const focusLost = useCallback((activityId: string) => {
    if (showTask(activityId, `refocus:${activityId}`)) setRefocus(activityId);
  }, [showTask]);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const element = document.getElementById(taskElementId(refocus)) ?? document.getElementById(taskElementId(reveal?.row ?? ""));
    element?.focus({ preventScroll: true });
  }, [refocus, reveal]);
  // What a screen reader is told when the author changes what is shown, and only then: the list changes under the author's hand with every step.
  const [announcement, setAnnouncement] = useState("");
  const choose = (filter: TimelineFilter) => {
    change({ filter });
    setAnnouncement(t("autopilot.timeline.announce", { filter: t(`autopilot.timeline.filter.${filter}`), count: counts[filter] }));
  };
  const everything = counts.all;
  const nothing = !loading && everything === 0 && !timeline.groups.some((group) => group.running);

  // A book that never ran has nothing to list: not a card with a title and a button that do nothing, but one line that says what happens once it starts.
  if (nothing && !prefs.since) return <p className="text-sm text-muted-foreground">{t("autopilot.activity.idle")}</p>;

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
          {everything > 0 && <TimelineFilters bookId={bookId} value={prefs.filter} counts={counts} onChange={choose} />}
          <TimelineLive bookId={bookId} shownAbove={shownAbove} onFocusLost={focusLost} />
          {shown.groups.length === 0 && everything > 0 ? (
            <div className="space-y-2 rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>{t("autopilot.timeline.empty")}</p>
              <Button variant="outline" size="sm" onClick={() => choose("all")}>{t("autopilot.timeline.showAll")}</Button>
            </div>
          ) : (
            <ol className="space-y-2">
              {shown.groups.map((group) => <TimelineGroupView key={group.key} group={group} open={chosen[group.key] ?? group.key === shown.open} onToggle={toggle} chapterTitle={chapterTitle} chapterGhostwriter={chapterGhostwriter} currency={currency} revealRow={reveal?.group === group.key ? reveal.row : undefined} />)}
            </ol>
          )}
        </>
      )}
      <p role="status" className="sr-only">{announcement}</p>
    </section>
  );
});
