import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterRound } from "narrarium-engine";
import { formatCount } from "@/autopilot/format";

const vote = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * How the votes went from round to round: a bar for the director's vote of each round, and a lighter one for the readers' average where they read (the first round, and the
 * ones the review policy has them read again). A picture, so one image to a screen reader with what it shows said in words: the table beside it has every figure. The height of a
 * bar is the vote, out of ten, and the figure is written over it: nothing is told by colour.
 */
export function RoundsTrend({ rounds }: { rounds: readonly ChapterRound[] }) {
  const { t } = useTranslation();
  const votes = rounds.map((round) => vote(round.director));
  const said = votes.filter((value): value is number => value !== null).map(formatCount).join(" → ");
  const readersSaid = rounds.map((round) => vote(round.readers)).filter((value): value is number => value !== null).map(formatCount).join(" → ");
  if (!said) return null;
  const label = [t("autopilot.chapterPanel.rounds.chart", { votes: said }), readersSaid ? t("autopilot.chapterPanel.rounds.chartReaders", { score: readersSaid }) : null].filter(Boolean).join(" ");
  return (
    <div role="img" aria-label={label} className="mx-auto flex h-28 max-w-md items-end gap-4 border-b border-border px-1">
      {rounds.map((round, index) => {
        const director = votes[index];
        const read = vote(round.readers);
        return (
          <div key={index} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div className="flex h-full w-full items-end justify-center gap-1">
              {director !== null && (
                <div className="flex h-full w-8 flex-col items-center justify-end">
                  <span className="text-xs font-semibold tabular-nums">{formatCount(director)}</span>
                  <div className="w-full rounded-t-sm bg-primary" style={{ height: `${Math.max(4, director * 8)}%` }} />
                </div>
              )}
              {read !== null && (
                <div className="flex h-full w-6 flex-col items-center justify-end">
                  <span className="text-xs tabular-nums text-muted-foreground">{formatCount(read)}</span>
                  <div className="w-full rounded-t-sm border border-primary bg-primary/20" style={{ height: `${Math.max(4, read * 8)}%` }} />
                </div>
              )}
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The rounds of review the plan recorded for the chapter, as a table, after the picture of their votes. A reading of the readers on their own (`ChapterRound.reading`: they read the
 * chapter again after its corrections, or only for their vote) is a row of the table with no vote of the director, and says so in the place of the verdict. The table scrolls sideways
 * on a narrow screen, and can be reached with the keyboard to do it.
 */
export function Rounds({ rounds }: { rounds: readonly ChapterRound[] }) {
  const { t } = useTranslation();
  const id = useId();
  if (!rounds.length) return <p className="text-sm text-muted-foreground">{t("autopilot.chapterPanel.rounds.none")}</p>;
  const dash = <span aria-hidden="true">—</span>;
  return (
    <div className="space-y-3">
      <RoundsTrend rounds={rounds} />
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-primary" />{t("autopilot.chapterPanel.rounds.director")}</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-primary bg-primary/20" />{t("autopilot.chapterPanel.rounds.readers")}</span>
      </div>
      <div role="region" aria-labelledby={id} tabIndex={0} data-own-arrows="" className="relative overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table aria-labelledby={id} className="w-full border-collapse text-sm">
          <caption id={id} className="sr-only">{t("autopilot.chapterPanel.rounds.title")}</caption>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.round")}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t("autopilot.chapterPanel.rounds.director")}</th>
              <th scope="col" className="px-2 py-1 text-right font-medium">{t("autopilot.chapterPanel.rounds.readers")}</th>
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.verdict")}</th>
              <th scope="col" className="px-2 py-1 text-left font-medium">{t("autopilot.chapterPanel.rounds.fixes")}</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round, index) => (
              <tr key={index} data-round-reading={round.reading} className="border-b last:border-b-0">
                <th scope="row" className="px-2 py-1 text-left font-normal tabular-nums">{index + 1}</th>
                <td className="px-2 py-1 text-right tabular-nums">{vote(round.director) !== null ? formatCount(round.director!) : <>{dash}<span className="sr-only">{t("autopilot.map.table.none")}</span></>}</td>
                <td className="px-2 py-1 text-right tabular-nums">{vote(round.readers) !== null ? formatCount(round.readers!) : <>{dash}<span className="sr-only">{t("autopilot.map.table.none")}</span></>}</td>
                <td className="px-2 py-1">{round.reading ? t(`autopilot.chapterPanel.rounds.reading.${round.reading}`) : round.verdict ? t(`autopilot.chapterPanel.rounds.${round.verdict}`) : dash}</td>
                <td className="px-2 py-1">{round.accepted !== undefined || round.rejected !== undefined ? t("autopilot.chapterPanel.rounds.fixesValue", { accepted: round.accepted ?? 0, rejected: round.rejected ?? 0 }) : dash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
