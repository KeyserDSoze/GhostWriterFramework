import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Coins } from "lucide-react";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import type { MoneyTotals } from "@/costs/money";
import { localDay, localMonth } from "@/costs/period";
import { inMonth, summarize } from "@/costs/usageViews";
import { useMoney } from "@/costs/useMoney";
import "@/i18n/costs";

const spent = (totals: MoneyTotals) => Object.values(totals).some((value) => Number.isFinite(value) && value !== 0);

/**
 * What was spent today and this month, in the top bar, a link to the dashboard of the costs: every use of every book that the browsers recorded, measured
 * (the estimates are on the dashboard), in the one formatter of money. Nothing when nothing was spent this month. Below a wide screen the bar shows the month only (the room of the bar is short) and a
 * screen reader hears both. Loaded after the page is drawn (`Topbar`), never with it.
 */
export function CostsIndicator() {
  const { t } = useTranslation();
  const money = useMoney();
  const file = useCostsStore((state) => state.file);
  const now = new Date();
  const today = localDay(now);
  const month = localMonth(now);
  const { day, current } = useMemo(() => {
    const rows = usageRows(file, money.display);
    return {
      day: summarize(rows, (row) => row.period === today, money.relabels).money,
      current: summarize(rows, (row) => inMonth(row, month), money.relabels).money,
    };
  }, [file, money.display, money.relabels, today, month]);
  if (!spent(current) && !spent(day)) return null;
  const dayText = money.totals(day, { empty: "—" });
  const monthText = money.totals(current, { empty: "—" });
  return (
    <Link
      to="/app/costs"
      data-costs-indicator
      title={`${t("costs.indicator.today")} ${dayText} · ${t("costs.indicator.month")} ${monthText}`}
      className="inline-flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Coins className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t("costs.indicator.today")}</span>{" "}
      <span aria-hidden="true" className="hidden lg:inline">{t("costs.indicator.todayShort")}</span>
      <span data-costs-today className="sr-only lg:not-sr-only">{dayText}</span>
      <span aria-hidden="true" className="hidden lg:inline">·</span>{" "}
      <span className="sr-only">{t("costs.indicator.month")}</span>{" "}
      <span aria-hidden="true" className="hidden lg:inline">{t("costs.indicator.monthShort")}</span>
      <span data-costs-month className="truncate">{monthText}</span>{" "}
      <span className="sr-only">— {t("costs.indicator.open")}</span>
    </Link>
  );
}
