import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { useBudgetWords } from "@/components/costs/budget/BudgetBar";
import { alertLines, linesOf } from "@/costs/budgets";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import { useBudgetLines } from "@/costs/useBudgets";
import { useMoney } from "@/costs/useMoney";
import "@/i18n/costs";

/**
 * In the Autopilot of a book: a notice, in words, when a budget that applies to it is at the share it warns at or over it (spec point 5), and the way to the budgets. Nothing without
 * one, and nothing while the panel of a stop says it already.
 */
export function BudgetNotice({ bookId, bookName, hidden = false }: { bookId: string; bookName: string; hidden?: boolean }) {
  const { t } = useTranslation();
  const words = useBudgetWords();
  const file = useCostsStore((state) => state.file);
  const display = useMoney().display;
  const rows = useMemo(() => usageRows(file, display), [file, display]);
  const { lines } = useBudgetLines(rows);
  const alert = alertLines(linesOf(lines, bookId))[0];
  if (!alert || hidden) return null;
  return (
    <div role="status" data-budget-book-notice={alert.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-sm">
      <span className="flex min-w-0 flex-1 items-start gap-2 basis-72">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden="true" />
        <span>
          <span className="font-semibold">{t(`costs.budget.notice.${alert.state}`)}</span>{" "}
          {t(`costs.budget.bookNotice.${alert.state}`, { scope: words.scope(alert, bookName), period: words.period(alert).toLowerCase(), percent: words.percent(alert), spent: words.amount(alert.spent, alert.currency), limit: words.amount(alert.limit, alert.currency) })}
        </span>
      </span>
      <Link to="/app/costs" className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.budget.limitPanel.open")}</Link>
    </div>
  );
}
