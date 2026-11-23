import { useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, CheckCircle2, Clapperboard, Download, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReadFirstBlock } from "@/components/autopilot/result/ReadFirst";
import { ScoresBlock } from "@/components/autopilot/result/Scores";
import { useBandModel } from "@/components/autopilot/AutopilotControlBand";
import { finalReviewOf, finalVerdict, workedSince, workedTime, type FinalVerdict } from "@/autopilot/bandModel";
import { formatCost, formatCount, formatDate, formatDuration } from "@/autopilot/format";
import { scalettaHref } from "@/autopilot/pageRoute";
import { chapterScores, readFirst } from "@/autopilot/resultModel";
import { openAskDirector } from "@/store/askDirectorStore";
import { cn } from "@/lib/utils";

/** The words of the director are cut to a few lines when they are longer than this: the rest is one button away. */
const VERDICT_CLAMP_CHARACTERS = 280;

const VERDICT_TONE = {
  approve: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  revise: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  rewrite: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
} as const;

/**
 * What the director said of the whole book: the score, big, with its scale; the verdict in words with an icon (not told by colour alone); and the director's own words,
 * cut to a few lines when they are long, with a button that gives all of them. Nothing is shown that the engine did not say: no score, no verdict.
 */
function VerdictBlock({ verdict }: { verdict: FinalVerdict }) {
  const { t } = useTranslation();
  const wordsId = useId();
  const [open, setOpen] = useState(false);
  const { score, text } = verdict;
  const long = text.length > VERDICT_CLAMP_CHARACTERS;
  const Icon = verdict.verdict === "approve" ? CheckCircle2 : RotateCcw;
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.result.verdict.title")}</h3>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        {(score !== undefined || verdict.verdict) && (
          <div className="shrink-0 space-y-2 rounded-2xl border bg-muted/40 px-5 py-3">
            {score !== undefined && (
              <p className="leading-none">
                <span data-result-score aria-hidden="true" className="font-serif text-5xl font-semibold tabular-nums">{formatCount(score)}<span className="ml-0.5 text-xl font-medium text-muted-foreground">/10</span></span>
                <span className="sr-only">{t("autopilot.result.verdict.score", { score: formatCount(score) })}</span>
              </p>
            )}
            {verdict.verdict && (
              <p className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold", VERDICT_TONE[verdict.verdict])}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t(`autopilot.result.verdict.${verdict.verdict}`)}
              </p>
            )}
          </div>
        )}
        {text && (
          <div className="min-w-0 flex-1 basis-60 space-y-1.5">
            <p id={wordsId} data-result-words className={cn("whitespace-pre-line text-sm leading-relaxed", long && !open && "line-clamp-4")}>{text}</p>
            {long && (
              <button type="button" aria-expanded={open} aria-controls={wordsId} onClick={() => setOpen((value) => !value)} className="inline-flex min-h-6 items-center rounded-sm text-xs font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {open ? t("autopilot.result.verdict.showLess") : t("autopilot.result.verdict.showAll")}
              </button>
            )}
          </div>
        )}
      </div>
      {verdict.verdict && verdict.verdict !== "approve" && <p className="text-xs text-muted-foreground">{t("autopilot.result.verdict.reviseHint")}</p>}
    </div>
  );
}

/** The figures of the run. What is not there is left out: no time the engine did not count, no cost that is zero. */
function NumbersBlock({ items }: { items: Array<[string, ReactNode]> }) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.result.numbers.title")}</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-base font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** What to do with a book that is finished: read it, export it, ask the director, add chapters (the same way as the band: the configuration, with the number of chapters in front). */
function ActionsBar({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const root = `/app/books/${encodeURIComponent(bookId)}`;
  return (
    <div role="group" aria-label={t("autopilot.result.actions.label")} className="flex flex-wrap items-center gap-2 border-t pt-4">
      <Button asChild size="sm">
        <Link to={`${root}/reader`}><BookOpen className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.actions.read")}</Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link to={`${root}/export`}><Download className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.actions.export")}</Link>
      </Button>
      <Button size="sm" variant="outline" onClick={() => openAskDirector({ bookId, target: { kind: "book" } })}>
        <Clapperboard className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.actions.ask")}
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link to={scalettaHref(bookId)}><Plus className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.actions.add")}</Link>
      </Button>
    </div>
  );
}

export interface AutopilotResultProps {
  bookId: string;
  /** The chapters the book has, by their folder: a chapter that is not among them is named, and not linked. */
  linkedSlugs: ReadonlySet<string>;
  /** The page has room for two columns. */
  wide?: boolean;
}

/**
 * The result of a book that is finished, under the band: the director's verdict on the whole book, the figures of the run (the time the engine counted, the cost, the
 * tokens), how the chapters scored (a picture, the order, and the table with the rounds of the review and the readers), the chapters to read first and why, and what to do
 * next. It reads what the engine says (`finalReview`, `workedMs`, the rounds of the plan) and, for a state that an older engine wrote, what the log says; it shows what is
 * there and nothing that is not.
 */
export function AutopilotResult({ bookId, linkedSlugs, wide = true }: AutopilotResultProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const model = useBandModel(bookId);
  const chapters = model?.state?.plan?.chapters;
  const scores = useMemo(() => chapterScores(chapters ?? []), [chapters]);
  const first = useMemo(() => readFirst(scores), [scores]);
  // The title of a chapter is asked for the rows that are drawn: the plan is searched, and never read whole.
  const byNumber = useMemo(() => new Map((chapters ?? []).map((chapter) => [chapter.number, chapter] as const)), [chapters]);
  if (!model || !model.completed) return null;

  const { summary, state, activities, currency } = model;
  const verdict = finalVerdict(activities, finalReviewOf(summary, state));
  const worked = workedTime(activities, summary.stats.workedMs);
  const { progress, stats } = summary;
  const numbers: Array<[string, ReactNode]> = [];
  if (progress.chapters > 0) numbers.push([t("autopilot.result.numbers.chapters"), formatCount(progress.chapters)]);
  if (progress.scenesWritten > 0) numbers.push([t("autopilot.result.numbers.scenes"), formatCount(progress.scenesWritten)]);
  if (progress.words > 0) numbers.push([t("autopilot.result.numbers.words"), formatCount(progress.words)]);
  // A book that is older than the count says since when its time is counted; the one whose count began with it has nothing to add.
  const since = workedSince(summary.stats, state?.createdAt);
  if (worked.milliseconds > 0) {
    numbers.push([t("autopilot.result.numbers.time"), worked.complete
      ? <>{formatDuration(worked.milliseconds)}{since && <span className="ml-1.5 inline-block text-xs font-normal text-muted-foreground">{t("autopilot.result.numbers.timeSince", { date: formatDate(since) })}</span>}</>
      : t("autopilot.result.numbers.timeAtLeast", { time: formatDuration(worked.milliseconds) })]);
  }
  if (stats.cost > 0) numbers.push([t("autopilot.result.numbers.cost"), formatCost(stats.cost, currency)]);
  if (stats.inputTokens + stats.outputTokens > 0) numbers.push([t("autopilot.result.numbers.tokens"), formatCount(stats.inputTokens + stats.outputTokens)]);
  if (stats.aiCalls > 0) numbers.push([t("autopilot.result.numbers.calls"), formatCount(stats.aiCalls)]);
  const titleOf = (number: number) => byNumber.get(number)?.title;

  return (
    <section data-autopilot-result aria-labelledby={titleId} className="space-y-5 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id={titleId} className="text-base font-semibold">{t("autopilot.result.title")}</h2>
      <div className={cn("grid gap-6", wide && "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]")}>
        {verdict && <VerdictBlock verdict={verdict} />}
        <NumbersBlock items={numbers} />
      </div>
      {scores.length > 0 && (
        <div className={cn("grid gap-6", wide && "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]")}>
          <ScoresBlock bookId={bookId} scores={scores} linkedSlugs={linkedSlugs} titleOf={titleOf} />
          <ReadFirstBlock bookId={bookId} items={first} linkedSlugs={linkedSlugs} titleOf={titleOf} />
        </div>
      )}
      <ActionsBar bookId={bookId} />
    </section>
  );
}
