import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DirectorOpinionRecord } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { formatCount, formatDateTime } from "@/autopilot/format";
import { trendByChapter, trendByDate, type TrendPoint } from "@/director/sheetModel";
import { cn } from "@/lib/utils";

type TrendMode = "chapter" | "date";

/** The rows of the table before the author asks for more. */
const ROWS = 10;

const H = 170;
const PAD = { left: 30, right: 14, top: 12, bottom: 28 };

/** The width the chart has, in pixels, so that its words keep their size on a phone (a picture scaled to fit would shrink them). */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver !== "function") return undefined;
    const measure = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width) || fallback));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);
  return { ref, width };
}

/**
 * The scores as a line over the scale from 0 to 10, with the approval score of now as a dashed line. A picture: one image to a screen reader, with
 * what it shows said in words (`label`); the table under it has every figure. A plain SVG, with no library, drawn at the width it has.
 */
function TrendChart({ points, threshold, mode, label }: { points: readonly TrendPoint[]; threshold: number; mode: TrendMode; label: string }) {
  const { ref, width: W } = useWidth(600);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (points.length === 1 ? innerW / 2 : (index * innerW) / (points.length - 1));
  const y = (score: number) => PAD.top + innerH * (1 - Math.min(10, Math.max(0, score)) / 10);
  const every = Math.max(1, Math.ceil(points.length / Math.max(4, Math.floor(innerW / 36))));
  return (
    <div ref={ref} className="w-full max-w-3xl">
    <svg role="img" aria-label={label} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
      {[0, 5, 10].map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
          <text x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground text-xs">{tick}</text>
        </g>
      ))}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(threshold)} y2={y(threshold)} className="stroke-amber-700 dark:stroke-amber-400" strokeWidth={1.5} strokeDasharray="6 4" />
      {points.length > 1 && <polyline points={points.map((point, index) => `${x(index)},${y(point.score)}`).join(" ")} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />}
      {points.map((point, index) => (
        <circle key={point.path} cx={x(index)} cy={y(point.score)} r={4.5} className={point.verdict === "approve" ? "fill-primary stroke-primary" : "fill-card stroke-primary"} strokeWidth={2} />
      ))}
      {mode === "chapter" && points.map((point, index) => (index % every === 0 || index === points.length - 1) && (
        <text key={`label-${point.path}`} x={x(index)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-xs">{point.chapter}</text>
      ))}
    </svg>
    </div>
  );
}

/**
 * How the director's scores went: the saved opinions by chapter (the book keeps the last opinion on each chapter) or by date (the book's and the
 * scenes' too), as a picture with the approval score of now as a line, and as a table with every figure for whoever reads it with a screen reader.
 */
export function OpinionTrend({ records, threshold }: { records: readonly DirectorOpinionRecord[]; threshold: number }) {
  const { t } = useTranslation();
  const id = useId();
  const byChapter = useMemo(() => trendByChapter(records), [records]);
  const byDate = useMemo(() => trendByDate(records), [records]);
  const [chosen, setChosen] = useState<TrendMode | null>(null);
  const [rows, setRows] = useState(ROWS);
  if (!records.length) return null;
  const mode: TrendMode = chosen ?? (byChapter.length ? "chapter" : "date");
  const points = mode === "chapter" ? byChapter : byDate;
  const scores = points.map((point) => point.score);
  const values = { count: points.length, min: formatCount(Math.min(...scores)), max: formatCount(Math.max(...scores)), threshold: formatCount(threshold) };
  const label = t(mode === "chapter" ? "director.trend.chartChapters" : "director.trend.chartDates", values);
  const shown = points.slice(0, rows);
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-base font-semibold">{t("director.trend.title")}</h3>
        <div role="radiogroup" aria-label={t("director.trend.show")} className="inline-flex rounded-lg border border-layer p-0.5">
          {(["chapter", "date"] as const).map((value) => {
            const disabled = value === "chapter" && !byChapter.length;
            return (
              <label key={value} className={cn("relative inline-flex min-h-11 cursor-pointer items-center sm:min-h-9", disabled && "cursor-not-allowed opacity-60")}>
                <input type="radio" name={`${id}-mode`} value={value} checked={mode === value} disabled={disabled} onChange={() => { setChosen(value); setRows(ROWS); }} className="peer sr-only" />
                <span className="rounded-md px-3 py-1.5 text-sm font-medium peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {t(value === "chapter" ? "director.trend.byChapter" : "director.trend.byDate")}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <TrendChart points={points} threshold={threshold} mode={mode} label={label} />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <svg aria-hidden="true" width="24" height="6" className="shrink-0"><line x1="0" x2="24" y1="3" y2="3" className="stroke-amber-700 dark:stroke-amber-400" strokeWidth={1.5} strokeDasharray="6 4" /></svg>
        {t("director.trend.threshold", { value: formatCount(threshold) })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t("director.trend.columns.what")}</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t("director.trend.columns.when")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("director.trend.columns.score")}</th>
              <th scope="col" className="py-1.5 font-medium">{t("director.trend.columns.verdict")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((point) => (
              <tr key={point.path} className="border-t border-layer">
                <td className="py-1.5 pr-3">{point.title}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">{formatDateTime(point.createdAt)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatCount(point.score)}/10</td>
                <td className="py-1.5">{t(`director.opinion.verdict.${point.verdict}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {points.length > rows && (
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setRows((count) => count + ROWS * 5)}>
          {t("director.trend.more", { count: Math.min(ROWS * 5, points.length - rows) })}
        </Button>
      )}
    </section>
  );
}
