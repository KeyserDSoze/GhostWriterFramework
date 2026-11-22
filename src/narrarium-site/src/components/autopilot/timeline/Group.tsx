import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TimelineRowView } from "@/components/autopilot/timeline/Row";
import { formatCount } from "@/autopilot/format";
import { GROUP_ROWS, MAX_ROWS, ROW_STEP, nextLimit, type TimelineGroup } from "@/autopilot/timelineModel";
import { cn } from "@/lib/utils";

/**
 * What a group is called: its chapter and its round (with the title of the chapter when the plan has it), or what its steps are; and, once the
 * director has judged it, the verdict and the score. One text: two chapters that were both approved with 8/10 do not say the same thing twice.
 */
function useGroupLabel(group: TimelineGroup, chapterTitle: ((number: number) => string | undefined) | undefined): string {
  const { t } = useTranslation();
  let label: string;
  if (group.kind !== "chapter") {
    label = t(`autopilot.timeline.group.${group.kind}`);
  } else {
    const title = chapterTitle?.(group.chapterNumber ?? 0)?.trim();
    label = title
      ? t("autopilot.timeline.group.chapterTitled", { chapter: group.chapterNumber, title, round: group.round })
      : t("autopilot.timeline.group.chapter", { chapter: group.chapterNumber, round: group.round });
  }
  if (!group.result) return label;
  const score = formatCount(group.result.score);
  // The plan records the vote of a round and not its verdict: a round whose review the log no longer has says the vote, and says whose it is.
  return group.result.verdict ? `${label} · ${t(`director.opinion.verdict.${group.result.verdict}`)} ${score}/10` : `${label} · ${t("autopilot.plan.score", { score })}`;
}

/**
 * A chapter and its round, or what is not about a chapter: a header that opens and closes it, and its rows when it is open. A closed group has no
 * rows in the page at all; an open one draws a window of them, and gives more when the author asks.
 */
export const TimelineGroupView = memo(function TimelineGroupView({ group, open, onToggle, chapterTitle, currency }: { group: TimelineGroup; open: boolean; onToggle: (key: string) => void; chapterTitle?: (number: number) => string | undefined; currency?: string }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(GROUP_ROWS);
  const label = useGroupLabel(group, chapterTitle);
  const regionId = `autopilot-timeline-${group.key.replace(/:/g, "-")}`;
  // A group whose first step is still running has nothing to open yet.
  const expandable = group.rows.length > 0;
  const total = Math.min(group.rows.length, MAX_ROWS);
  const left = total - Math.min(limit, total);
  // What the plan recorded of the round besides its vote: the readers' average (the first round only) and what the director decided. Only what is there, and no zero.
  const details = group.result
    ? [
        group.result.readers !== undefined ? t("autopilot.timeline.round.readers", { score: formatCount(group.result.readers) }) : "",
        group.result.accepted ? t("autopilot.timeline.round.accepted", { count: group.result.accepted }) : "",
        group.result.rejected ? t("autopilot.timeline.round.rejected", { count: group.result.rejected }) : "",
      ].filter(Boolean).join(" · ")
    : "";
  const content = (
    <>
      <span className="min-w-0 flex-1 basis-44 text-sm font-medium">{label}</span>
      {group.running && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-accent-foreground">{t("autopilot.timeline.group.running")}</span>}
      {group.failed > 0 && <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-800 dark:text-red-300">{t("autopilot.timeline.group.failed", { count: group.failed })}</span>}
      {group.steps > 0 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("autopilot.timeline.group.steps", { count: group.steps })}</span>}
    </>
  );
  return (
    <li data-timeline-group={group.key} className={cn("rounded-xl border", group.running && "border-primary/40")}>
      <h3>
        {expandable ? (
          <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => onToggle(group.key)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden="true" />
            {content}
          </button>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">{content}</div>
        )}
      </h3>
      {open && expandable && (
        <div id={regionId} className="space-y-1.5 border-t p-2">
          {details && <p data-timeline-round className="px-1 text-xs text-muted-foreground">{details}</p>}
          <ol className="space-y-1.5">
            {group.rows.slice(0, Math.min(limit, total)).map((row) => <TimelineRowView key={row.key} row={row} currency={currency} />)}
          </ol>
          {left > 0 && (
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setLimit(nextLimit(limit, group.rows.length))}>
              {t("autopilot.timeline.more", { count: Math.min(ROW_STEP, left) })}
            </Button>
          )}
        </div>
      )}
    </li>
  );
});
