import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { DesignRound } from "narrarium-engine";
import { voteText } from "@/autopilot/format";

export interface DesignRoundsProps {
  rounds: readonly DesignRound[];
  /** The vote the design must reach, when its policy says one. */
  target?: number;
}

const WIDTH = 320;
const HEIGHT = 140;
const PAD = { left: 30, right: 12, top: 12, bottom: 26 };

/**
 * The reviews of a design (Phase 4 of #108): how the votes went, review after review, in a chart (the director's, the readers' average, the target), and what the reviewers
 * said in each (`DesignRound.texts`): the director's judgement, the devil's advocate, the changes and the critical inconsistencies, and every reader's reaction with its
 * counter-proposal. The chart says its figures in words too, and the list under it is the text of the same figures.
 */
export default function DesignRounds({ rounds, target }: DesignRoundsProps) {
  const { t } = useTranslation();
  const id = useId();
  if (!rounds.length) return null;
  const x = (index: number) => PAD.left + (rounds.length === 1 ? (WIDTH - PAD.left - PAD.right) / 2 : (index * (WIDTH - PAD.left - PAD.right)) / (rounds.length - 1));
  const y = (score: number) => PAD.top + ((10 - Math.min(10, Math.max(0, score))) * (HEIGHT - PAD.top - PAD.bottom)) / 10;
  const points = (values: Array<number | undefined>) => values.map((value, index) => (value === undefined ? null : `${x(index)},${y(value)}`)).filter(Boolean).join(" ");
  const director = rounds.map((round) => round.score);
  const readers = rounds.map((round) => round.readers);
  const description = [
    ...rounds.map((round) => t("design.studio.rounds.chart.point", { round: round.round, score: voteText(round.score), readers: round.readers !== undefined ? voteText(round.readers) : t("design.studio.rounds.chart.noReaders") })),
    target !== undefined ? t("design.studio.rounds.chart.target", { score: voteText(target) }) : "",
  ].filter(Boolean).join(" ");
  return (
    <div className="space-y-3">
      <figure className="space-y-1">
        <svg role="img" aria-labelledby={`${id}-title ${id}-desc`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full max-w-sm" data-design-chart="">
          <title id={`${id}-title`}>{t("design.studio.rounds.chart.title")}</title>
          <desc id={`${id}-desc`}>{description}</desc>
          {[0, 5, 10].map((score) => (
            <g key={score}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(score)} y2={y(score)} className="text-border" stroke="currentColor" strokeWidth={0.5} />
              <text x={PAD.left - 6} y={y(score) + 4} textAnchor="end" className="fill-muted-foreground text-xs">{score}</text>
            </g>
          ))}
          {target !== undefined && <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(target)} y2={y(target)} className="text-amber-800 dark:text-amber-300" stroke="currentColor" strokeWidth={1} strokeDasharray="4 3" data-chart-target="" />}
          {readers.some((value) => value !== undefined) && <polyline points={points(readers)} fill="none" className="text-muted-foreground" stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 2" />}
          <polyline points={points(director)} fill="none" className="text-primary" stroke="currentColor" strokeWidth={2} />
          {rounds.map((round, index) => (
            <g key={`${round.round}-${round.at}`}>
              <circle cx={x(index)} cy={y(round.score)} r={3} className="text-primary" fill="currentColor" />
              <text x={x(index)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-xs">{round.round}</text>
            </g>
          ))}
        </svg>
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><span aria-hidden="true" className="mr-1 inline-block h-0.5 w-4 bg-primary align-middle" />{t("design.studio.rounds.chart.director")}</span>
          {readers.some((value) => value !== undefined) && <span><span aria-hidden="true" className="mr-1 inline-block w-4 border-t border-dashed border-muted-foreground align-middle" />{t("design.studio.rounds.chart.readers")}</span>}
          {target !== undefined && <span><span aria-hidden="true" className="mr-1 inline-block w-4 border-t border-dashed border-amber-800 align-middle dark:border-amber-300" />{t("design.studio.rounds.chart.targetLegend", { score: voteText(target) })}</span>}
        </figcaption>
      </figure>
      <ol data-design-rounds className="space-y-2 text-sm">
        {rounds.map((round) => (
          <li key={`${round.round}-${round.at}`} data-design-round={round.round}>
            <span>
              {t("design.studio.rounds.row", { round: round.round, score: voteText(round.score), verdict: t(`design.studio.rounds.verdict.${round.verdict}`) })}
              {round.readers !== undefined && <> · {t("design.studio.rounds.readers", { score: voteText(round.readers) })}</>}
              {round.critical > 0 && <> · {t("design.studio.rounds.critical", { count: round.critical })}</>}
              {round.findings > 0 && <> · {t("design.studio.rounds.findings", { count: round.findings })}</>}
            </span>
            {round.texts && <RoundTexts round={round} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function RoundTexts({ round }: { round: DesignRound }) {
  const { t } = useTranslation();
  const texts = round.texts!;
  return (
    <details className="mt-1 rounded-lg border border-layer bg-background/60" data-round-texts={round.round}>
      <summary className="flex min-h-9 cursor-pointer items-center rounded-lg px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("design.studio.rounds.said", { round: round.round })}</summary>
      <dl className="space-y-2 border-t px-3 pb-3 pt-2 text-sm">
        {texts.summary && <Said label={t("design.studio.rounds.summary")} text={texts.summary} />}
        {texts.counterProposal && <Said label={t("design.studio.rounds.counter")} text={texts.counterProposal} />}
        {texts.critical?.length ? <SaidList label={t("design.studio.rounds.criticalSaid")} items={texts.critical} /> : null}
        {texts.changes?.length ? <SaidList label={t("design.studio.rounds.changes")} items={texts.changes} /> : null}
        {texts.readers?.length ? (
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">{t("design.studio.rounds.readersSaid")}</dt>
            <dd>
              <ul className="space-y-1.5">
                {texts.readers.map((reader) => (
                  <li key={reader.slug} data-round-reader={reader.slug}>
                    <span className="font-medium">{reader.name}</span> <span className="text-muted-foreground">({voteText(reader.score)})</span>: <span className="whitespace-pre-line">{reader.text}</span>
                    {reader.counterProposal && <span className="block text-muted-foreground">{t("design.studio.rounds.readerCounter", { text: reader.counterProposal })}</span>}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function Said({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-line break-words">{text}</dd>
    </div>
  );
}

function SaidList({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd><ul className="list-disc space-y-0.5 pl-5">{items.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul></dd>
    </div>
  );
}
