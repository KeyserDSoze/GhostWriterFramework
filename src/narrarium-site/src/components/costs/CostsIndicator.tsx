import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Coins } from "lucide-react";
import { alertLines } from "@/costs/budgets";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import type { MoneyTotals } from "@/costs/money";
import { localDay, localMonth } from "@/costs/period";
import { inMonth, summarize } from "@/costs/usageViews";
import { useBudgetLines } from "@/costs/useBudgets";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

const spent = (totals: MoneyTotals) => Object.values(totals).some((value) => Number.isFinite(value) && value !== 0);

/**
 * What was spent today and this month, in the top bar, a link to the dashboard of the costs: every use of every book that the browsers recorded, measured
 * (the estimates are on the dashboard), in the one formatter of money. Nothing when nothing was spent this month. Below a wide screen the bar shows the month only (the room of the bar is short) and a
 * screen reader hears both. When a budget is at the share it warns at, or over it, the pill says so, with a sign and the share («85%»), and the screen reader hears which budget
 * (spec point 5). Loaded after the page is drawn (`Topbar`), never with it.
 */
export function CostsIndicator() {
  const { t } = useTranslation();
  const money = useMoney();
  const file = useCostsStore((state) => state.file);
  const now = new Date();
  const today = localDay(now);
  const month = localMonth(now);
  const rows = useMemo(() => usageRows(file, money.display), [file, money.display]);
  const { day, current } = useMemo(() => ({
    day: summarize(rows, (row) => row.period === today, money.relabels).money,
    current: summarize(rows, (row) => inMonth(row, month), money.relabels).money,
  }), [rows, money.relabels, today, month]);
  const { lines } = useBudgetLines(rows);
  const alert = alertLines(lines)[0];
  if (!spent(current) && !spent(day) && !alert) return null;
  const dayText = money.totals(day, { empty: "—" });
  const monthText = money.totals(current, { empty: "—" });
  const alertText = alert ? t("costs.indicator.budget", { state: t(`costs.budget.state.${alert.state}`), percent: Math.round(alert.ratio * 100), scope: alert.scope === "global" ? t("costs.budget.scope.global") : t("costs.budget.scope.book"), period: t(`costs.budget.period.${alert.period}`).toLowerCase() }) : "";
  return (
    <Link
      to="/app/costs"
      data-costs-indicator
      title={`${t("costs.indicator.today")} ${dayText} · ${t("costs.indicator.month")} ${monthText}${alertText ? ` · ${alertText}` : ""}`}
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
      {alert && (
        <span data-costs-budget={alert.state} className={cn("inline-flex shrink-0 items-center gap-0.5 font-medium", alert.state === "over" ? "text-destructive" : "text-amber-800 dark:text-amber-300")}>
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          <span aria-hidden="true">{Math.round(alert.ratio * 100)}%</span>
          <span className="sr-only">— {alertText}</span>
        </span>
      )}{" "}
      <span className="sr-only">— {t("costs.indicator.open")}</span>
    </Link>
  );
}
