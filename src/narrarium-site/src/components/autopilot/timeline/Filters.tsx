import { useTranslation } from "react-i18next";
import { TIMELINE_FILTERS, type TimelineFilter } from "@/autopilot/timelineModel";

/**
 * One choice among five, as native radio buttons: one stop of the Tab key, the arrow keys move from one to the next and choose it, and a screen reader says
 * which of how many it is. They look like chips; the circle is not drawn, the chosen one is filled and every one has a ring when it has the focus.
 */
export function TimelineFilters({ bookId, value, counts, onChange }: { bookId: string; value: TimelineFilter; counts: Record<TimelineFilter, number>; onChange: (filter: TimelineFilter) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("autopilot.timeline.filter.label")} className="flex flex-wrap gap-1.5">
      {TIMELINE_FILTERS.map((filter) => (
        <label key={filter} className="relative inline-flex">
          <input type="radio" name={`autopilot-timeline-filter-${bookId}`} value={filter} checked={value === filter} onChange={() => onChange(filter)} className="peer sr-only" />
          <span className="inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground transition hover:bg-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ring-offset-background">
            {t(`autopilot.timeline.filter.${filter}`)}
            <span className="tabular-nums">{counts[filter]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
