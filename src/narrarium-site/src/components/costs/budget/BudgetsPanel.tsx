import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BudgetBar, useBudgetWords } from "@/components/costs/budget/BudgetBar";
import { BudgetEditor } from "@/components/costs/budget/BudgetEditor";
import { limitsOf, suggestedBudget, type BudgetLine } from "@/costs/budgets";
import { raiseBudget, saveBudgetLimits } from "@/costs/budgetSettings";
import { formatMoney } from "@/costs/money";
import { rateBetween } from "@/costs/rates";
import { cn } from "@/lib/utils";
import type { CostBudgets, CostExchangeRate } from "@/types/settings";

/**
 * The budgets in one compact place of the dashboard (spec point 5): what the budgets of all the books have used, a notice in words for every budget at the share it warns at or over
 * it (with one click to raise one that is used up), and the form to set them. The budget of a book is in its row. A budget never blocks anything by itself: the autopilot is
 * paused by the engine's own cap, and going on is the person's choice, in the Autopilot.
 */
export function BudgetsPanel({ lines, budgets, warnAt, bookName, currency, rates, serverBooks }: {
  lines: readonly BudgetLine[];
  budgets: CostBudgets | undefined;
  warnAt: number;
  bookName: (bookId: string) => string;
  /** The currency of the settings: what the form starts with, and what the autopilot's runs are priced in. */
  currency: string;
  rates: readonly CostExchangeRate[];
  /** Whether a book runs its autopilot on the personal server. */
  serverBooks: boolean;
}) {
  const { t } = useTranslation();
  const words = useBudgetWords();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState("");
  const ownBooks = new Set(lines.filter((line) => line.scope === "book").map((line) => line.bookId)).size;
  const hasBudgets = lines.length > 0;
  // The budgets of all the books are always in sight; a book's own is in its row, and here only when it calls for a word.
  const shown = lines.filter((line) => line.scope === "global" || line.state !== "ok").sort((left, right) => Number(right.state !== "ok") - Number(left.state !== "ok") || right.ratio - left.ratio);
  // A budget in another currency limits the runs only through a rate to the currency of their prices.
  const unlimited = lines.filter((line) => line.currency !== currency && !rateBetween(line.currency, currency, rates));
  const uncounted = lines.filter((line) => Object.keys(line.uncounted).length > 0);
  const notes = uncounted.length + (unlimited.length ? 1 : 0) + (serverBooks && hasBudgets ? 1 : 0);

  const raise = (line: BudgetLine) => {
    const limit = suggestedBudget(line.limit, line.spent);
    const said = t("costs.budget.raised", { scope: words.scope(line, bookName(line.bookId)), period: words.period(line).toLowerCase(), limit: words.amount(limit, line.currency) });
    setSaid(said);
    void raiseBudget(line, limit).then((saved) => { if (!saved) setSaid(`${said} ${t("costs.budget.notSaved")}`); });
  };

  return (
    <section data-budgets-panel aria-labelledby={`${id}-title`} className="space-y-2 rounded-xl border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="flex items-center gap-1.5 text-sm font-semibold"><Gauge className="h-4 w-4" aria-hidden="true" />{t("costs.budget.title")}</h2>
        <Button type="button" variant="outline" size="sm" className="min-h-9 [@media(pointer:coarse)]:min-h-11" aria-expanded={open} aria-controls={`${id}-editor`} onClick={() => { setOpen((current) => !current); setSaid(""); }}>
          {hasBudgets ? t("costs.budget.edit") : t("costs.budget.set")}
        </Button>
      </div>

      <div role="status" aria-live="polite" data-budget-notices>
        {shown.length > 0 && (
          <ul className="space-y-1">
            {shown.map((line) => {
              const alert = line.state !== "ok";
              return (
                <li key={`${line.scope}:${line.bookId}:${line.period}:${line.currency}`} data-budget-notice={alert ? line.state : undefined} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1 text-xs", alert && "border border-amber-500/50 bg-amber-500/5")}>
                  <span className="flex min-w-0 flex-1 basis-60 items-start gap-1.5">
                    {alert && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-800 dark:text-amber-300" aria-hidden="true" />}
                    <span>
                      {alert && <><span className="font-semibold">{t(`costs.budget.notice.${line.state}`)}</span>{" "}</>}
                      {t("costs.budget.line", { scope: words.scope(line, bookName(line.bookId)), period: words.period(line).toLowerCase(), spent: words.amount(line.spent, line.currency), limit: words.amount(line.limit, line.currency), percent: words.percent(line) })}
                    </span>
                  </span>
                  <BudgetBar line={line} name={words.scope(line, bookName(line.bookId))} caption={false} />
                  {line.state === "over" && (
                    <Button type="button" size="sm" variant="outline" className="min-h-9 [@media(pointer:coarse)]:min-h-11" onClick={() => raise(line)} data-budget-raise="">
                      {t("costs.budget.raise", { amount: words.amount(suggestedBudget(line.limit, line.spent), line.currency) })}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {said && <p data-budget-raised className="px-2 text-xs text-muted-foreground">{said}</p>}
      </div>

      {hasBudgets ? (
        <div className="space-y-1">
          <p className="px-2 text-xs text-muted-foreground">
            {t("costs.budget.how", { percent: warnAt })}{budgets?.counts === "autopilot" ? ` ${t("costs.budget.countsAutopilotNote")}` : ""}
            {ownBooks > 0 ? ` ${t("costs.budget.ownBooks", { count: ownBooks })}` : ""}
          </p>
          {notes > 0 && (
            <details data-budget-notes className="px-2 text-xs">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.budget.notes", { count: notes })}</summary>
              <div className="space-y-1 pb-1 text-muted-foreground">
                {uncounted.length > 0 && (
                  <div data-budget-uncounted className="space-y-0.5 text-amber-800 dark:text-amber-300">
                    <ul>
                      {uncounted.map((line) => (
                        <li key={`${line.scope}:${line.bookId}:${line.period}:${line.currency}`}>
                          {t("costs.budget.uncounted", { scope: words.scope(line, bookName(line.bookId)), period: words.period(line).toLowerCase(), currency: line.currency, amounts: Object.entries(line.uncounted).map(([code, value]) => formatMoney(value, code)).join(", ") })}
                        </li>
                      ))}
                    </ul>
                    <Link to="/app/settings/costs" className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 sm:min-h-6">{t("costs.changeCurrency")}</Link>
                  </div>
                )}
                {unlimited.length > 0 && <p data-budget-unlimited className="text-amber-800 dark:text-amber-300">{t("costs.budget.noRate", { currencies: [...new Set(unlimited.map((line) => line.currency))].join(", "), display: currency })}</p>}
                {serverBooks && <p data-budget-server>{t("costs.budget.serverNote")}</p>}
              </div>
            </details>
          )}
        </div>
      ) : (
        <p className="px-2 text-xs text-muted-foreground">{t("costs.budget.none")}</p>
      )}

      {open && (
        <div id={`${id}-editor`}>
          <BudgetEditor
            bookId=""
            name=""
            limits={limitsOf(budgets, "")}
            currency={currency}
            global={{ warnAt, counts: budgets?.counts ?? "all" }}
            autoFocus
            onSave={(limits, options) => {
              setOpen(false);
              setSaid(t("costs.budget.saved"));
              void saveBudgetLimits("", limits, options).then((saved) => { if (!saved) setSaid(t("costs.budget.notSaved")); });
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </section>
  );
}
