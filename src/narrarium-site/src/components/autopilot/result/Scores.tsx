import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { initialRows, moreRows, scoreSeries, scoreSummary, sortScores, type ChapterScore, type ScoreOrder } from "@/autopilot/resultModel";
import { formatCount } from "@/autopilot/format";
import { cn } from "@/lib/utils";

/** The title of a chapter of the plan, asked only for the ones that are shown: a plan has no maximum number of chapters. */
export type TitleOf = (number: number) => string | undefined;

const chapterHref = (bookId: string, slug: string) => `/app/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(slug)}`;

/**
 * The final score of each chapter, as bars (one for each chapter, or one for each group of chapters in a long book). A picture, so it is one image to a screen reader, with
 * what it shows said in words: the table under it has every figure. The height of a bar is the score, so nothing is told by colour.
 */
function ScoreBars({ scores }: { scores: readonly ChapterScore[] }) {
  const { t } = useTranslation();
  const summary = scoreSummary(scores);
  const bars = useMemo(() => scoreSeries(scores), [scores]);
  if (!summary || !bars.length) return null;
  const label = t("autopilot.result.scores.chart", { first: summary.first, last: summary.last, min: formatCount(summary.lowest.score), minChapter: summary.lowest.number, max: formatCount(summary.highest.score), maxChapter: summary.highest.number, average: formatCount(summary.average) });
  return (
    <div role="img" aria-label={label} className="flex h-20 items-end gap-px border-b border-border">
      {bars.map((bar) => (
        <div key={bar.from} data-bar className="min-w-px flex-1 rounded-t-[2px] bg-primary" style={{ height: `${Math.max(3, Math.min(100, bar.value * 10))}%` }} />
      ))}
    </div>
  );
}

const ORDERS: ScoreOrder[] = ["chapter", "lowest"];

/** One choice of two, as native radio buttons: one stop of the Tab key, the arrow keys choose, and a screen reader says which of how many. They look like chips. */
function OrderChoice({ bookId, value, onChange }: { bookId: string; value: ScoreOrder; onChange: (order: ScoreOrder) => void }) {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t("autopilot.result.scores.order.label")} className="flex flex-wrap gap-1.5">
      {ORDERS.map((order) => (
        <label key={order} className="relative inline-flex">
          <input type="radio" name={`autopilot-result-order-${bookId}`} value={order} checked={value === order} onChange={() => onChange(order)} className="peer sr-only" />
          <span className="inline-flex min-h-7 cursor-pointer items-center rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground transition hover:bg-muted peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 ring-offset-background">
            {t(`autopilot.result.scores.order.${order}`)}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * A score, or, for a chapter or a round that has none, words that say so: not a bare dash, which a screen reader may not say at all. A round that sent the chapter back (`revised`
 * holds the words) has a sign before its score, so that the digits of the column stay under one another at the right edge, and the words after it for whoever does not see the sign:
 * the verdict is never told by a colour, and a screen reader hears the score first.
 */
function ScoreCell({ value, none, strong = false, revised }: { value: number | null; none: string; strong?: boolean; revised?: string }) {
  return (
    <td className={cn("px-2 py-1 text-right tabular-nums", strong && "font-semibold")}>
      {value === null ? <><span aria-hidden="true">—</span><span className="sr-only">{none}</span></> : <>{revised && <><span aria-hidden="true" data-round-verdict="revise">↻</span>{"\u00a0"}</>}{formatCount(value)}{revised && <span className="sr-only"> {revised}</span>}</>}
    </td>
  );
}

/**
 * How the director judged the chapters: the picture of the final scores, the order they are listed in, and the table of all of them (the final score, the score of each
 * round of the review, the readers' average). A long book is a window of the table with a button for the rest; the lowest scores first is one click.
 */
export function ScoresBlock({ bookId, scores, linkedSlugs, titleOf }: { bookId: string; scores: readonly ChapterScore[]; linkedSlugs: ReadonlySet<string>; titleOf: TitleOf }) {
  const { t } = useTranslation();
  const titleId = useId();
  const captionId = useId();
  const [order, setOrder] = useState<ScoreOrder>("chapter");
  const [shown, setShown] = useState<number | null>(null);
  const sorted = useMemo(() => sortScores(scores, order), [scores, order]);
  const total = sorted.length;
  const first = initialRows(total);
  const limit = shown === null ? first : Math.min(shown, total);
  const rounds = useMemo(() => scores.reduce((most, entry) => Math.max(most, entry.roundCount), 0), [scores]);
  const readers = useMemo(() => scores.some((entry) => entry.readers !== null), [scores]);
  const next = moreRows(limit, total);
  const none = t("autopilot.result.scores.none");
  const revised = t("autopilot.result.scores.revised");
  // The sign is explained once, when a cell on show has it.
  const anyRevised = sorted.slice(0, limit).some((entry) => entry.verdicts?.includes("revise"));
  if (!total) return null;

  return (
    <div className="min-w-0 space-y-3">
      <h3 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("autopilot.result.scores.title")}</h3>
      <ScoreBars scores={scores} />
      <OrderChoice bookId={bookId} value={order} onChange={(value) => setOrder(value)} />
      <p id={captionId} className="sr-only">{t("autopilot.result.scores.caption")}</p>
      <div role="region" aria-labelledby={titleId} tabIndex={0} className="relative overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table aria-labelledby={titleId} aria-describedby={captionId} className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("autopilot.result.scores.chapter")}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.scores.final")}</th>
              {Array.from({ length: rounds }, (_, index) => <th key={index} scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.scores.round", { number: index + 1 })}</th>)}
              {readers && <th scope="col" className="px-2 py-1.5 text-right font-medium">{t("autopilot.result.scores.readers")}</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((entry) => {
              const title = titleOf(entry.number)?.trim();
              const label = title ? `${entry.number} · ${title}` : String(entry.number);
              return (
                <tr key={entry.number} className="border-b last:border-b-0">
                  <th scope="row" className="min-w-[8rem] px-2 py-1 text-left font-normal">
                    {linkedSlugs.has(entry.slug) ? <Link to={chapterHref(bookId, entry.slug)} className="inline-flex min-h-6 items-center underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</Link> : label}
                  </th>
                  <ScoreCell value={entry.final} none={none} strong />
                  {Array.from({ length: rounds }, (_, index) => <ScoreCell key={index} value={entry.rounds[index] ?? null} none={none} revised={entry.verdicts?.[index] === "revise" ? revised : undefined} />)}
                  {readers && <ScoreCell value={entry.readers} none={none} />}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {anyRevised && <p className="text-xs text-muted-foreground">{t("autopilot.result.scores.reviseLegend")}</p>}
      {(limit < total || total > first) && (
        <button type="button" onClick={() => setShown(limit < total ? next : null)} className="inline-flex min-h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {limit < total ? (next === total ? t("autopilot.result.scores.showAll", { count: total }) : t("autopilot.result.scores.showMore", { count: next - limit })) : t("autopilot.result.scores.showFewer")}
        </button>
      )}
    </div>
  );
}
