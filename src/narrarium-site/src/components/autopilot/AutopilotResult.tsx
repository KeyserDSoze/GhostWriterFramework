import { Suspense, lazy, useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, CheckCircle2, Clapperboard, Download, Loader2, Plus, RotateCcw, Target } from "lucide-react";
import { chapterReading, type BookRoundMode, type ReviewRecord } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { ReadFirstBlock } from "@/components/autopilot/result/ReadFirst";
import { ScoresBlock } from "@/components/autopilot/result/Scores";
import { TargetsBlock } from "@/components/autopilot/result/Targets";
import { useBandModel } from "@/components/autopilot/AutopilotControlBand";
import { finalReviewOf, finalVerdict, workedSince, workedTime, type FinalVerdict } from "@/autopilot/bandModel";
import { formatCost, formatCount, formatDate, formatDuration, voteText } from "@/autopilot/format";
import { scalettaHref } from "@/autopilot/pageRoute";
import type { OpenChapter } from "@/autopilot/chapterReading";
import { chapterScores, readFirst, reviewRounds } from "@/autopilot/resultModel";
import { withAutopilotTranslations } from "@/i18n/autopilot";
import { useBackGestureClose } from "@/components/layout/historyStep";
import { openAskDirector } from "@/store/askDirectorStore";
import { cn } from "@/lib/utils";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

// «Review the book again» is a chunk of its own: nothing of it is loaded until the author opens it.
import { AnnotationsRunLine } from "@/components/autopilot/result/AnnotationsRunLine";
const ReviewBookDialog = lazy(withAutopilotTranslations(() => import("@/components/autopilot/result/ReviewBookDialog")));
// A chapter read in a window over the result is one too: its text, its type and its folder reading are loaded with the first chapter that is opened.
const ChapterReadingModal = lazy(withAutopilotTranslations(() => import("@/components/autopilot/result/ChapterReadingModal")));
// «The book as a whole»: the book's vote under its target and what the director asked of it (the corrections of a review's book-level round), a chunk of its own.
const BookRoundBlock = lazy(withAutopilotTranslations(() => import("@/components/autopilot/result/BookRound")));

/** Shown while the window of a chapter is on its way, after a short wait so that a chunk that comes at once leaves no flash. */
function OpeningChapter() {
  const { t } = useTranslation();
  return (
    <div role="status" className="pointer-events-none fixed left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-layer bg-background px-4 py-2 text-sm shadow-lg animate-in fade-in-0 duration-200 [animation-delay:250ms] [animation-fill-mode:backwards]">
      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{t("autopilot.result.reading.opening")}
    </div>
  );
}

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

/** How a review of the book ended, in one line: its rounds, its target, what the lowest chapter and the book came to. */
function LastReviewLine({ record }: { record: ReviewRecord }) {
  const { t } = useTranslation();
  return (
    <p data-result-review className="text-xs text-muted-foreground">
      {t(`autopilot.result.review.${record.outcome}`, { count: record.rounds, target: voteText(record.targetScore), from: voteText(record.from.book), to: voteText(record.to.book), lowest: voteText(record.to.lowest) })}
    </p>
  );
}

/**
 * What to do with a book that is finished: review it again (the first action, when the page can offer it), read it, export it, ask the director, add chapters (the
 * same way as the band: the configuration, with the number of chapters in front).
 */
function ActionsBar({ bookId, onReview }: { bookId: string; onReview?: () => void }) {
  const { t } = useTranslation();
  const root = `/app/books/${encodeURIComponent(bookId)}`;
  return (
    <div role="group" aria-label={t("autopilot.result.actions.label")} className="flex flex-wrap items-center gap-2 border-t pt-4">
      {onReview && (
        <Button size="sm" data-result-review-again onClick={onReview}>
          <Target className="h-4 w-4" aria-hidden="true" />{t("autopilot.result.actions.review")}
        </Button>
      )}
      <Button asChild size="sm" variant={onReview ? "outline" : "default"}>
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
  /** What «Review the book again» needs to say what it costs: the book, its working branch and its structure. Without it the action is not offered. */
  review?: { book: BookEntry; branch: string; structure?: BookStructure };
}

/**
 * The result of a book that is finished, under the band: the director's verdict on the whole book, the figures of the run (the time the engine counted, the cost, the
 * tokens), how the chapters scored (a picture, the order, and the table with the rounds of the review and the readers), the chapters to read first and why, and what to do
 * next. It reads what the engine says (`finalReview`, `workedMs`, the rounds of the plan) and, for a state that an older engine wrote, what the log says; it shows what is
 * there and nothing that is not.
 */
export function AutopilotResult({ bookId, linkedSlugs, wide = true, review }: AutopilotResultProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const model = useBandModel(bookId);
  const chapters = model?.state?.plan?.chapters;
  // The readers that do not count are left out of the average of a vote whose readers are known.
  const left = model?.state?.options.review?.readersExcluded;
  const scores = useMemo(() => chapterScores(chapters ?? [], new Set(left)), [chapters, left]);
  // The targets are shown when the readers gave a vote, or the author asked something of them.
  const hasReadings = useMemo(() => (chapters ?? []).some((chapter) => chapterReading(chapter.rounds) !== null), [chapters]);
  const first = useMemo(() => readFirst(scores), [scores]);
  const rounds = useMemo(() => reviewRounds(scores), [scores]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  // What the window starts with for the whole book, when the settings of the book have the round off: the block of the book's vote asks for it, the action of the bar does not.
  const [bookRoundAsked, setBookRoundAsked] = useState<BookRoundMode | undefined>(undefined);
  // The chapter read in a window (by its folder), and the link that opened it, which has the focus again when the window closes.
  const [reading, setReading] = useState<{ slug: string; opener: HTMLElement } | null>(null);
  const openChapter = useCallback<OpenChapter>((slug, opener) => setReading({ slug, opener }), []);
  const goToChapter = useCallback((slug: string) => setReading((current) => (current ? { ...current, slug } : current)), []);
  const closeChapter = useCallback(() => setReading(null), []);
  // On a phone the window is the screen: the back gesture closes it and the page stays. Its step in the history is kept here, which is there while the window opens and closes (a window that
  // is closed before its step is made, by Escape at once, still gives it back).
  const followLink = useBackGestureClose(reading !== null, closeChapter, "chapter-reading");
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
  // The rounds of review, summed over the chapters, with the most a chapter had («3 rounds of review»; the table has each chapter's).
  if (rounds) numbers.push([t("autopilot.result.numbers.rounds"), <>{formatCount(rounds.rounds)}<span className="ml-1.5 inline-block text-xs font-normal text-muted-foreground">{t("autopilot.result.numbers.roundsMost", { count: rounds.most })}</span></>]);
  const titleOf = (number: number) => byNumber.get(number)?.title;
  const lastReview = state?.reviews?.[state.reviews.length - 1];
  const lastAnnotations = state?.annotationRuns?.[state.annotationRuns.length - 1];
  const openReview = review && state ? (bookRound?: BookRoundMode) => { setBookRoundAsked(bookRound); setReviewOpened(true); setReviewing(true); } : undefined;
  // The chapter links open the chapter in a window when the book can be read here (its working copy is the one the page has); without, they are links.
  const readHere = review && state ? openChapter : undefined;

  return (
    <section data-autopilot-result aria-labelledby={titleId} className="space-y-5 rounded-2xl border border-layer bg-card p-4 shadow-sm sm:p-5">
      <h2 id={titleId} className="text-base font-semibold">{t("autopilot.result.title")}</h2>
      <div className={cn("grid gap-6", wide && "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]")}>
        <div className="min-w-0 space-y-2">
          {verdict && <VerdictBlock verdict={verdict} />}
          {lastReview && <LastReviewLine record={lastReview} />}
          {lastAnnotations && <AnnotationsRunLine record={lastAnnotations} />}
        </div>
        <NumbersBlock items={numbers} />
      </div>
      {state && (hasReadings || state.options.review?.readersTarget !== undefined || Object.keys(state.options.review?.readerTargets ?? {}).length > 0) && <TargetsBlock bookId={bookId} state={state} structure={review?.structure} />}
      {state && (typeof state.finalReview?.score === "number" || (lastReview?.bookRounds?.length ?? 0) > 0) && (
        <Suspense fallback={null}>
          <BookRoundBlock bookId={bookId} state={state} structure={review?.structure} linkedSlugs={linkedSlugs} onReview={openReview ? () => openReview("ask") : undefined} />
        </Suspense>
      )}
      {scores.length > 0 && (
        <div className={cn("grid gap-6", wide && "grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]")}>
          <ScoresBlock bookId={bookId} scores={scores} linkedSlugs={linkedSlugs} titleOf={titleOf} onOpenChapter={readHere} />
          <ReadFirstBlock bookId={bookId} items={first} linkedSlugs={linkedSlugs} titleOf={titleOf} onOpenChapter={readHere} />
        </div>
      )}
      <ActionsBar bookId={bookId} onReview={openReview ? () => openReview() : undefined} />
      {reading && review && state && (
        <Suspense fallback={<OpeningChapter />}>
          <ChapterReadingModal bookId={bookId} book={review.book} branch={review.branch} state={state} linkedSlugs={linkedSlugs} slug={reading.slug} onNavigate={goToChapter} onClose={closeChapter} returnFocusTo={reading.opener} onLinkClick={followLink} />
        </Suspense>
      )}
      {reviewOpened && review && state && (
        <Suspense fallback={null}>
          <ReviewBookDialog open={reviewing} onClose={() => setReviewing(false)} book={review.book} branch={review.branch} structure={review.structure} state={state} initialBookRound={bookRoundAsked} />
        </Suspense>
      )}
    </section>
  );
}
