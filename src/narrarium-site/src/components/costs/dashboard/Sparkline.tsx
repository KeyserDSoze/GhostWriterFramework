import { useTranslation } from "react-i18next";
import { viewMoney } from "@/costs/money";
import type { TrendPoint } from "@/costs/dashboardModel";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";

/** The name of a month of a trend in the language of the page: «Nov». */
function pointName(period: string, locale: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(year, month - 1, 1));
}

/**
 * What a row spent over six months, as bars. A bar is the amount of its month in the currency of the settings (converted with a rate of the settings where
 * there is one); an amount that has no rate is drawn by its own figure (the largest of its currencies), so that a row spent in another currency still has a
 * shape, and the text says every amount in its own currency. Said to a screen reader as text, month by month, in the one formatter of money.
 */
export function Sparkline({ points, className }: { points: readonly TrendPoint[]; className?: string }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  if (!points.length) return null;
  const values = points.map((point) => {
    const view = viewMoney(point.money, money);
    return view.shown ? view.shown.amount : Math.max(0, ...view.others.map((other) => other.amount));
  });
  const max = Math.max(...values);
  const spoken = points.filter((point) => Object.keys(point.money).length > 0).map((point) => `${pointName(point.period, locale)} ${money.totals(point.money)}`);
  const label = t("costs.dashboard.trend.months", { values: spoken.length ? spoken.join(", ") : t("costs.dashboard.trend.none") });
  const width = 48;
  const gap = 1;
  const bar = (width - gap * (points.length - 1)) / points.length;
  return (
    <svg data-sparkline role="img" aria-label={label} viewBox={`0 0 ${width} 16`} width={width} height={16} className={cn("shrink-0 overflow-visible text-primary", className)}>
      <title>{label}</title>
      <line x1={0} y1={15.5} x2={width} y2={15.5} className="stroke-border" strokeWidth={1} />
      {values.map((value, index) => {
        const height = max > 0 ? Math.max(value > 0 ? 1.5 : 0, (value / max) * 15) : 0;
        return <rect key={points[index].period} x={index * (bar + gap)} y={15 - height} width={bar} height={height} rx={0.5} className="fill-current" />;
      })}
    </svg>
  );
}
