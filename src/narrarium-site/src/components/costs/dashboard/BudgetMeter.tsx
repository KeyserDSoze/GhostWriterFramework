import { useTranslation } from "react-i18next";
import { BudgetBar } from "@/components/costs/budget/BudgetBar";
import type { BookAutopilot } from "@/components/costs/dashboard/useBookAutopilots";
import { worstLine, type BudgetLine } from "@/costs/budgets";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";

function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

/**
 * The budget of a book (spec point 5), as its row shows it: the budget the person set for the book, against what the ledger says it spent (the one of the line that is furthest on),
 * with the words «Warning» and «Over budget» and, when the engine stopped the autopilot at the cap the budgets gave it, «stopped». A book with no budget of its own shows the
 * money cap of its autopilot (`budgetLimit`, the one the run stops at) against the autopilot's own count, in the currency of that count; else its token cap; «No budget» without one.
 * A meter for a screen reader, with the figures in words.
 */
export function BudgetMeter({ autopilot, name, lines, className }: { autopilot: BookAutopilot | undefined; name: string; lines?: readonly BudgetLine[]; className?: string }) {
  const { t, i18n } = useTranslation();
  const money = useMoney();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const own = worstLine(lines ?? []);
  if (own) {
    const engineStopped = autopilot?.limitReached && (autopilot.limitReached.kind === "money" || autopilot.limitReached.kind === "tokens");
    return <BudgetBar line={own} name={name} className={className} {...(engineStopped ? { extra: t("costs.dashboard.budget.stopped") } : {})} />;
  }
  if (autopilot?.unavailable) {
    return <span data-budget="unavailable" className={cn("text-xs text-muted-foreground", className)}>{t("costs.dashboard.budget.unavailable")}</span>;
  }
  if (!autopilot?.read) {
    return <span data-budget="reading" className={cn("text-xs text-muted-foreground", className)}><span aria-hidden="true">{t("costs.dashboard.budget.notRead")}</span><span className="sr-only">{t("costs.dashboard.budget.notReadLabel")}</span></span>;
  }
  const options = autopilot.options;
  const stats = autopilot.stats;
  const limit = options?.budgetLimit ?? 0;
  const tokensLimit = options?.budgetTokens ?? 0;
  // When the cap stopped the run, the numbers are the ones the engine compared at the stop, not a recount.
  const stopped = autopilot.limitReached && autopilot.limitReached.kind !== "review-rounds" ? autopilot.limitReached : null;
  let ratio: number;
  let text: string;
  if (stopped?.kind === "money" && stopped.limit > 0) {
    ratio = stopped.used / stopped.limit;
    text = t("costs.dashboard.budget.of", { spent: money.amount(stopped.used, stopped.currency ?? stats?.currency, { zero: "amount" }), limit: money.amount(stopped.limit, stopped.currency ?? stats?.currency, { zero: "amount" }) });
  } else if (stopped?.kind === "tokens" && stopped.limit > 0) {
    ratio = stopped.used / stopped.limit;
    text = t("costs.dashboard.budget.tokensOf", { spent: compact(stopped.used, locale), limit: compact(stopped.limit, locale) });
  } else if (limit > 0) {
    const spent = stats?.cost ?? 0;
    ratio = spent / limit;
    text = t("costs.dashboard.budget.of", { spent: money.amount(spent, stats?.currency, { zero: "amount" }), limit: money.amount(limit, stats?.currency, { zero: "amount" }) });
  } else if (tokensLimit > 0) {
    const spent = (stats?.inputTokens ?? 0) + (stats?.outputTokens ?? 0);
    ratio = spent / tokensLimit;
    text = t("costs.dashboard.budget.tokensOf", { spent: compact(spent, locale), limit: compact(tokensLimit, locale) });
  } else {
    return <span data-budget="none" className={cn("text-xs text-muted-foreground", className)}>{t("costs.dashboard.budget.none")}</span>;
  }
  const percent = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
  const tone = ratio >= 1 ? "bg-destructive" : ratio >= 0.8 ? "bg-amber-500" : "bg-primary";
  const caption = stopped ? `${text} · ${t("costs.dashboard.budget.stopped")}` : text;
  return (
    <span data-budget="set" data-budget-stopped={stopped ? "" : undefined} className={cn("inline-flex min-w-0 flex-col gap-0.5", className)} title={t("costs.dashboard.budget.hint")}>
      <span
        role="meter"
        aria-label={t("costs.dashboard.budget.label", { name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${caption} (${percent}%)`}
        className="block h-1.5 w-20 overflow-hidden rounded-full bg-muted"
      >
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${percent}%` }} />
      </span>
      <span className={cn("text-xs tabular-nums", stopped ? "font-medium text-destructive" : "text-muted-foreground")}>{caption}</span>
    </span>
  );
}
