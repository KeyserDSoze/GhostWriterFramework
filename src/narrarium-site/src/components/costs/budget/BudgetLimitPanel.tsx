import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Gauge, Loader2, Play, TrendingUp } from "lucide-react";
import type { AutopilotStateSummary } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBudgetWords } from "@/components/costs/budget/BudgetBar";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { LIMIT_PANEL_ID } from "@/autopilot/reviewPolicy";
import { suggestedBudget, typedAmount, validAmount, type BudgetLine } from "@/costs/budgets";
import { raiseBudget } from "@/costs/budgetSettings";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

/**
 * The panel of a stop at the cap the budgets gave the autopilot (spec point 5): the budget that was used up, in words, and the two ways on with one click. «Raise the budget» gives
 * the budget that stopped it a new limit and starts the autopilot again, which gives the engine the cap that is left of it; «Continue anyway» starts it once past the budgets, with the
 * cap the person had set (none, or their own), and the next start counts the budgets again. Nothing is blocked: the person decides.
 */
export function BudgetLimitPanel({ bookId, summary, line }: { bookId: string; summary: AutopilotStateSummary; line: BudgetLine }) {
  const { t } = useTranslation();
  const id = useId();
  const words = useBudgetWords();
  const { run, busy } = useAutopilotActions(bookId);
  const suggested = suggestedBudget(line.limit, line.spent);
  const [value, setValue] = useState(String(suggested));
  const typed = typedAmount(value);
  const valid = typed !== null && validAmount(typed) && typed > line.spent;
  const problem = value.trim() === "" || valid ? null : t("costs.budget.limitPanel.problem", { used: words.amount(line.spent, line.currency) });
  if (summary.status === "running") return null;

  const raise = () => {
    if (!valid || typed === null) return;
    void raiseBudget(line, typed);
    void run("start", (runtime, target) => runtime.start(target, {}));
  };
  const anyway = () => void run("start", async (runtime, target) => {
    runtime.allowBudgetOverrun(target);
    await runtime.start(target, {});
  });

  return (
    <section id={LIMIT_PANEL_ID} tabIndex={-1} aria-labelledby={`${id}-title`} data-limit-panel="budget" className="space-y-3 rounded-2xl border border-amber-500/50 bg-amber-500/5 p-4 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><Gauge className="h-4 w-4 text-amber-800 dark:text-amber-300" aria-hidden="true" />{t("costs.budget.limitPanel.title")}</h2>
      <p className="text-sm">{t("costs.budget.limitPanel.body", { scope: words.scope(line), period: words.period(line).toLowerCase(), spent: words.amount(line.spent, line.currency), limit: words.amount(line.limit, line.currency) })}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[10rem] flex-col gap-1">
          <Label htmlFor={`${id}-value`} className="text-xs font-medium">{t(`costs.budget.limitPanel.field.${line.period}`, { currency: line.currency })}</Label>
          <Input id={`${id}-value`} type="text" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-hint`} className={cn("h-9 w-40", problem && "border-destructive")} />
        </div>
        <Button type="button" size="sm" onClick={raise} disabled={!valid || busy !== null} data-budget-raise-go="">
          {busy === "start" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <TrendingUp className="h-4 w-4" aria-hidden="true" />}
          {t("costs.budget.limitPanel.raise", { amount: valid && typed !== null ? words.amount(typed, line.currency) : "…" })}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={anyway} disabled={busy !== null} data-budget-anyway="">
          <Play className="h-4 w-4" aria-hidden="true" />{t("costs.budget.limitPanel.anyway")}
        </Button>
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", problem ? "font-medium text-destructive" : "text-muted-foreground")}>{problem ?? t("costs.budget.limitPanel.hint")}</p>
      <Link to="/app/costs" className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.budget.limitPanel.open")}</Link>
    </section>
  );
}
