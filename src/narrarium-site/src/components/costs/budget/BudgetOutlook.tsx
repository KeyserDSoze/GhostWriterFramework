import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, Play, TrendingUp, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBudgetWords } from "@/components/costs/budget/BudgetBar";
import { formatMoney, roundMoneyRange } from "@/autopilot/runEstimateFormat";
import type { BudgetOutlook as Outlook, OutlookChapters } from "@/costs/budgetOutlook";
import { raiseBudget } from "@/costs/budgetSettings";
import { useBudgetOutlook } from "@/costs/useBudgetOutlook";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

export interface BudgetOutlookProps {
  bookId: string;
  /** The estimate of the run, in `currency`: absent when it has no price (it is then only said what is left). */
  cost: { min: number; max: number } | null | undefined;
  currency: string;
  /** The chapters the run goes through, to say where the money would run out; absent for a run that does not (a review of the whole book). */
  chapters?: OutlookChapters | null;
  /** The dialog that shows it can start the run past the budgets: «Start anyway». Without it the block only informs and offers to raise the budget. */
  onStartAnyway?: () => void;
  /** Something is already being done (a start): the buttons wait. */
  busy?: boolean;
}

/**
 * The estimate of a run against what its budget has left: «this run is estimated at $4 to $9, you have $6 left in the budget (all books, per month): it would stop at about chapter 7». It is the plan the
 * engine's own cap is made of (`budgetPlan`), so a start gives the engine what is said here. «Raise the budget» sets the limit that covers the run; «Start anyway» (where the dialog starts something) goes on
 * once past the budgets, and Cancel is the dialog's own. Nothing is shown without a budget that limits the run, and nothing is blocked.
 */
export function BudgetOutlook({ bookId, cost, currency, chapters, onStartAnyway, busy = false }: BudgetOutlookProps) {
  const outlook = useBudgetOutlook({ bookId, cost, currency, chapters });
  if (!outlook) return null;
  return <OutlookBox outlook={outlook} {...(onStartAnyway ? { onStartAnyway } : {})} busy={busy} />;
}

function OutlookBox({ outlook, onStartAnyway, busy }: { outlook: Outlook; onStartAnyway?: () => void; busy: boolean }) {
  const { t, i18n } = useTranslation();
  const words = useBudgetWords();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const [raising, setRaising] = useState(false);
  const [raised, setRaised] = useState<string | null>(null);
  const { line, cost, currency, stopsAt } = outlook;
  const money = (value: number) => formatMoney(value, currency, locale);
  const costText = cost ? (() => { const shown = roundMoneyRange(cost); return shown.min === shown.max ? money(shown.min) : t("costs.outlook.range", { min: money(shown.min), max: money(shown.max) }); })() : "";
  const budget = t("costs.outlook.budget", { scope: words.scope(line), period: words.period(line).toLowerCase() });
  const left = words.amount(outlook.left, currency);
  const over = outlook.kind === "stops" || outlook.kind === "may-stop";
  const where = stopsAt
    ? stopsAt.to !== null && stopsAt.to !== stopsAt.from
      ? t("costs.outlook.between", { from: stopsAt.from, to: stopsAt.to })
      : t(stopsAt.kind === "designed" ? "costs.outlook.atDesign" : "costs.outlook.at", { chapter: stopsAt.from })
    : t("costs.outlook.beforeEnd");
  const sentence = outlook.kind === "unknown"
    ? t("costs.outlook.unknown", { left, budget })
    : outlook.kind === "fits"
      ? t("costs.outlook.fits", { cost: costText, left, budget })
      : t(outlook.kind === "stops" ? "costs.outlook.stops" : "costs.outlook.mayStop", { cost: costText, left, budget, where });
  const raiseTo = outlook.raiseTo;

  const raise = async () => {
    if (raiseTo === undefined) return;
    setRaising(true);
    await raiseBudget(line, raiseTo);
    setRaised(t("costs.budget.raised", { scope: words.scope(line), period: words.period(line).toLowerCase(), limit: words.amount(raiseTo, line.currency) }));
    setRaising(false);
  };

  return (
    <section data-budget-outlook={outlook.kind} aria-label={t("costs.outlook.title")} className={cn("space-y-2 rounded-lg border p-2.5 text-xs", over ? "border-amber-500/60 bg-amber-500/5" : "bg-muted/30")}>
      <p className="flex items-start gap-1.5">
        {over ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden="true" /> : <Wallet className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span><span className="font-medium">{t("costs.outlook.title")}.</span> <span data-outlook-text>{sentence}</span></span>
      </p>
      {outlook.unlimited > 0 && <p data-outlook-unlimited className="text-muted-foreground">{t("costs.outlook.unlimited", { count: outlook.unlimited })}</p>}
      {over && (
        <>
          <p className="text-muted-foreground">{t(onStartAnyway ? "costs.outlook.howAnyway" : "costs.outlook.howInform")}</p>
          <div className="flex flex-wrap items-center gap-2">
            {raiseTo !== undefined && !raised && (
              <Button type="button" size="sm" variant="outline" onClick={() => void raise()} disabled={raising || busy} data-outlook-raise="">
                {raising ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <TrendingUp className="h-4 w-4" aria-hidden="true" />}
                {t("costs.outlook.raise", { amount: words.amount(raiseTo, line.currency) })}
              </Button>
            )}
            {onStartAnyway && (
              <Button type="button" size="sm" variant="outline" onClick={onStartAnyway} disabled={busy || raising} data-outlook-anyway="">
                <Play className="h-4 w-4" aria-hidden="true" />{t("costs.outlook.anyway")}
              </Button>
            )}
            <Link to="/app/costs" className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.outlook.open")}</Link>
          </div>
        </>
      )}
      <p role="status" data-outlook-raised className="text-muted-foreground empty:hidden">{raised}</p>
    </section>
  );
}
