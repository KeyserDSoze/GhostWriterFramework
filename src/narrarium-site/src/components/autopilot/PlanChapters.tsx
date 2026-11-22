import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle2, PenLine } from "lucide-react";
import type { PlannedChapter } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/autopilot/format";
import { PLAN_FULL_LIST_LIMIT, PLAN_REVEAL_STEP, chapterInProgress, countRun, mergeRanges, nextReveal, planSegments, type PlanRange, type RunCounts } from "@/autopilot/planWindow";
import { useBooksStore } from "@/store/booksStore";
import { cn } from "@/lib/utils";

/** Width of the chapter number: as many digits as the highest number needs, so the titles line up. */
function numberColumn(digits: number): string {
  if (digits <= 3) return "w-7";
  return digits === 4 ? "w-9" : digits === 5 ? "w-11" : digits === 6 ? "w-12" : "w-14";
}

interface RowProps {
  bookId: string;
  chapter: PlannedChapter;
  /** Position in the plan: how the row asks to stay in the list once it was opened. */
  index: number;
  /** Digits of the highest chapter number of the plan. */
  digits: number;
  linked: boolean;
  current: boolean;
  /** Long plans build the scenes of a chapter only once it is opened. */
  lazy: boolean;
  /** The name of the ghostwriter the outline gives the chapter, when it is not the book's. */
  ghostwriter?: string;
  onOpen: (index: number) => void;
}

const PlanChapterRow = memo(function PlanChapterRow({ bookId, chapter, index, digits, linked, current, lazy, ghostwriter, onOpen }: RowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const statusClass = chapter.status === "done" ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300" : chapter.status === "review" ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : chapter.status === "writing" ? "bg-sky-500/15 text-sky-800 dark:text-sky-300" : "bg-muted text-muted-foreground";
  return (
    <li data-plan-chapter={lazy ? index : undefined}>
      <details
        className={cn("rounded-lg border", current && "border-primary/50")}
        onToggle={(event) => {
          const opened = event.currentTarget.open;
          setOpen(opened);
          if (opened) onOpen(index);
        }}
      >
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <span className={cn(numberColumn(digits), "shrink-0 text-xs tabular-nums text-muted-foreground")}>{chapter.number}.</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{chapter.title}</span>
          {ghostwriter && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><PenLine className="h-3.5 w-3.5" aria-hidden="true" />{t("autopilot.plan.ghostwriter", { name: ghostwriter })}</span>}
          {chapter.score !== undefined && <span className="text-xs text-muted-foreground">{t("autopilot.plan.score", { score: chapter.score })}</span>}
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", statusClass)}>{chapter.imported ? t("autopilot.plan.imported") : t(`autopilot.plan.status.${chapter.status}`)}</span>
        </summary>
        {(!lazy || open) && (
          <div className="space-y-2 border-t px-3 py-2 text-sm">
            {chapter.summary && <p className="text-muted-foreground">{chapter.summary}</p>}
            {chapter.scenes.length > 0 && (
              <ol className="space-y-1 text-xs">
                {chapter.scenes.map((scene) => (
                  <li key={scene.number} className="flex gap-2">
                    <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{scene.number}.</span>
                    <span className="min-w-0 flex-1"><span className="font-medium">{scene.title}</span>{scene.summary || scene.goal ? <span className="text-muted-foreground"> — {scene.summary || scene.goal}</span> : null}</span>
                    {scene.words ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatCount(scene.words)}</span> : null}
                    {scene.status !== "planned" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
                  </li>
                ))}
              </ol>
            )}
            {linked && <Button asChild size="sm" variant="outline"><Link to={`/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter.slug)}`}>{t("common.open")}</Link></Button>}
          </div>
        )}
      </details>
    </li>
  );
});

const RUN_KINDS = ["imported", "approved", "active", "planned"] as const;

/** "182 chapters approved", "1,300 chapters planned", or "300 chapters: 120 approved, 180 planned" for a mix. */
function useRunSummary(counts: RunCounts, size: number): string {
  const { t } = useTranslation();
  const present = RUN_KINDS.filter((kind) => counts[kind] > 0);
  if (present.length === 1) return t(`autopilot.plan.run.${present[0]}`, { count: size });
  return t("autopilot.plan.run.mixed", { count: size, details: present.map((kind) => t(`autopilot.plan.run.detail.${kind}`, { count: counts[kind] })).join(", ") });
}

/** Stands for chapters that are not listed: a button that lists the next ones. */
function PlanRunLine({ chapters, run, onReveal }: { chapters: readonly PlannedChapter[]; run: PlanRange; onReveal: (run: PlanRange) => void }) {
  const { t } = useTranslation();
  const size = run.to - run.from + 1;
  const counts = useMemo(() => countRun(chapters, run), [chapters, run.from, run.to]);
  const summary = useRunSummary(counts, size);
  const first = chapters[run.from].number;
  const last = chapters[run.to].number;
  const all = nextReveal(run).to >= run.to;
  return (
    <li>
      <button
        type="button"
        aria-expanded="false"
        data-plan-run={run.from}
        onClick={() => onReveal(run)}
        className="flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{summary}</span>
          <span className="block text-xs text-muted-foreground">{first === last ? t("autopilot.plan.run.rangeOne", { number: first }) : t("autopilot.plan.run.range", { from: first, to: last })}</span>
        </span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{all ? t("autopilot.plan.run.showAll") : t("autopilot.plan.run.showMore", { count: PLAN_REVEAL_STEP })}</span>
      </button>
    </li>
  );
}

interface PlanChaptersProps {
  bookId: string;
  chapters: readonly PlannedChapter[];
  linkedSlugs: ReadonlySet<string>;
  /** Number of the chapter under review, drawn with a colored border. */
  reviewNumber: number | undefined;
}

/**
 * The chapters of the plan. Up to `PLAN_FULL_LIST_LIMIT` of them are all listed. A longer plan lists a window (the
 * first and last chapters and the ones around the chapter in progress) and stands in for the others with buttons that
 * list them fifty at a time, so a book of any length opens at once. What the author opened stays listed while the
 * window follows the run.
 */
export const PlanChapters = memo(function PlanChapters({ bookId, chapters, linkedSlugs, reviewNumber }: PlanChaptersProps) {
  const [opened, setOpened] = useState<PlanRange[]>([]);
  const ghostwriterName = useGhostwriterName(bookId);
  const listRef = useRef<HTMLOListElement>(null);
  const afterReveal = useRef<{ revealed: PlanRange; exhausted: boolean } | null>(null);
  const focus = useMemo(() => chapterInProgress(chapters), [chapters]);
  const digits = useMemo(() => String(chapters.reduce((highest, entry) => Math.max(highest, entry.number), 0)).length, [chapters]);
  const windowed = chapters.length > PLAN_FULL_LIST_LIMIT;
  const segments = useMemo(() => (windowed ? planSegments(chapters.length, focus, opened) : []), [windowed, chapters.length, focus, opened]);

  const keep = useCallback((index: number) => setOpened((current) => mergeRanges([...current, { from: index, to: index }])), []);
  const reveal = useCallback((run: PlanRange) => {
    const revealed = nextReveal(run);
    afterReveal.current = { revealed, exhausted: revealed.to >= run.to };
    setOpened((current) => mergeRanges([...current, revealed]));
  }, []);

  // The run's button normally stays where it is and keeps the focus. When the run was shown whole, the focus goes to its first chapter.
  useLayoutEffect(() => {
    const pending = afterReveal.current;
    if (!pending) return;
    afterReveal.current = null;
    const target = pending.exhausted
      ? listRef.current?.querySelector<HTMLElement>(`[data-plan-chapter="${pending.revealed.from}"] summary`)
      : listRef.current?.querySelector<HTMLElement>(`[data-plan-run="${pending.revealed.to + 1}"]`);
    if (target && document.activeElement !== target) target.focus();
  });

  const row = (index: number) => {
    const chapter = chapters[index];
    return <PlanChapterRow key={`${chapter.number}:${chapter.slug}`} bookId={bookId} chapter={chapter} index={index} digits={digits} linked={linkedSlugs.has(chapter.slug)} current={reviewNumber === chapter.number} lazy={windowed} ghostwriter={chapter.ghostwriter ? ghostwriterName(chapter.ghostwriter) : undefined} onOpen={keep} />;
  };

  if (!windowed) return <ol className="space-y-1.5" ref={listRef}>{chapters.map((_, index) => row(index))}</ol>;

  let hiddenRuns = 0;
  return (
    <ol className="space-y-1.5" ref={listRef}>
      {segments.flatMap((segment) => {
        if (segment.kind === "hidden") return [<PlanRunLine key={`run-${hiddenRuns++}`} chapters={chapters} run={segment} onReveal={reveal} />];
        return Array.from({ length: segment.to - segment.from + 1 }, (_, offset) => row(segment.from + offset));
      })}
    </ol>
  );
});

/** The name of a ghostwriter of the book from its slug, as the book's files say it; the slug itself for one the book does not list. */
export function useGhostwriterName(bookId: string): (slug: string) => string {
  const ghostwriters = useBooksStore((state) => state.structures[bookId]?.ghostwriters);
  return useCallback((slug: string) => ghostwriters?.find((entry) => entry.slug === slug)?.name?.trim() || slug, [ghostwriters]);
}

/** The most chapter numbers a sentence lists before it says how many more there are. */
const LISTED_NUMBERS = 20;

/**
 * The chapters the plan let go because the author deleted their entry of the Outline (`plan.removedChapters`): the following chapters keep their
 * numbers, so the book has a gap there. Said once, under the list, with the way to the Outline.
 */
export function RemovedChapters({ bookId, numbers }: { bookId: string; numbers: readonly number[] | undefined }) {
  const { t } = useTranslation();
  if (!numbers?.length) return null;
  const listed = numbers.slice(0, LISTED_NUMBERS).map((number) => formatCount(number)).join(", ");
  const text = numbers.length > LISTED_NUMBERS ? t("autopilot.plan.removedMore", { numbers: listed, count: numbers.length - LISTED_NUMBERS }) : listed;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <p className="min-w-0 flex-1">{t("autopilot.plan.removed", { count: numbers.length, numbers: text })}</p>
      <Link to={`/app/books/${encodeURIComponent(bookId)}/outline`} className="font-medium text-foreground underline underline-offset-4">{t("autopilot.plan.openOutline")}</Link>
    </div>
  );
}
