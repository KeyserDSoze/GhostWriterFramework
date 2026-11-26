import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BudgetLine } from "@/costs/budgets";
import { formatMoney } from "@/costs/money";
import { cn } from "@/lib/utils";

/** The words of a line of a budget: where it applies, how much of it is used, and whether it is over the share it is warned at, never by colour alone. */
export function useBudgetWords() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const amount = (value: number, currency: string) => formatMoney(value, currency, { locale });
  return {
    scope: (line: Pick<BudgetLine, "scope">, bookName?: string) => (line.scope === "global" ? t("costs.budget.scope.global") : bookName || t("costs.budget.scope.book")),
    period: (line: Pick<BudgetLine, "period">) => t(`costs.budget.period.${line.period}`),
    percent: (line: Pick<BudgetLine, "ratio">) => Math.round(line.ratio * 100),
    amount,
    /** «€17.00 of €20.00» */
    of: (line: BudgetLine) => t("costs.budget.of", { spent: amount(line.spent, line.currency), limit: amount(line.limit, line.currency) }),
    state: (line: Pick<BudgetLine, "state">) => t(`costs.budget.state.${line.state}`),
  };
}

/**
 * One limit of a budget against what was spent: a meter for a screen reader, and under it the share used, the limit, the period and, when it is at the share the budget warns at or
 * over it, the word that says so, with a sign: «85% of €20.00 per month · Warning». `name` is what the meter is called (the book, or all of them).
 */
export function BudgetBar({ line, name, extra, caption: showCaption = true, className }: { line: BudgetLine; name: string; extra?: string; /** Without the words under the meter, where the line says them already. */ caption?: boolean; className?: string }) {
  const { t } = useTranslation();
  const words = useBudgetWords();
  const percent = Math.min(Math.round(line.ratio * 100), 100);
  const alert = line.state !== "ok";
  const tone = line.state === "over" ? "bg-destructive" : line.state === "warn" ? "bg-amber-500" : "bg-primary";
  const caption = t("costs.budget.caption", { percent: words.percent(line), limit: words.amount(line.limit, line.currency), period: words.period(line).toLowerCase() });
  const stateText = alert ? words.state(line) : "";
  return (
    <span data-budget="set" data-budget-line={`${line.scope}:${line.bookId}:${line.period}:${line.currency}`} data-budget-state={line.state} className={cn("inline-flex min-w-0 flex-col gap-0.5", className)} title={t("costs.budget.hint")}>
      <span
        role="meter"
        aria-label={t("costs.budget.meterLabel", { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={[`${words.of(line)} ${words.period(line).toLowerCase()} (${words.percent(line)}%)`, stateText, extra].filter(Boolean).join(" — ")}
        className="block h-1.5 w-24 overflow-hidden rounded-full bg-muted"
      >
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${percent}%` }} />
      </span>
      {showCaption && (
        <span className={cn("flex items-start gap-1 text-xs tabular-nums", line.state === "over" ? "font-medium text-destructive" : line.state === "warn" ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>
          {alert && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />}
          <span>{[caption, stateText, extra].filter(Boolean).join(" · ")}</span>
        </span>
      )}
    </span>
  );
}
