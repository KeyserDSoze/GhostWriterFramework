import { useMemo } from "react";
import { useAutopilotStore } from "@/autopilot/store";
import { budgetOutlook, type BudgetOutlook, type OutlookChapters } from "@/costs/budgetOutlook";
import { budgetPlan } from "@/costs/budgetPlan";
import { normalizeBudgets } from "@/costs/budgets";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import { localDay } from "@/costs/period";
import { serverSpend, autopilotStatsOf } from "@/costs/serverSpend";
import { useMoney } from "@/costs/useMoney";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * The budgets against the estimate of a run of a book, followed live (a record, a limit, a rate, the server's count): what is left, and whether the run fits. `null` when no budget limits the run, or
 * when it has no estimate yet. Read from what the browser already holds: nothing is asked of GitHub or of the server.
 */
export function useBudgetOutlook(input: { bookId: string; cost: { min: number; max: number } | null | undefined; currency: string; chapters?: OutlookChapters | null }): BudgetOutlook | null {
  const rawBudgets = useSettingsStore((state) => state.settings.costBudgets);
  const books = useSettingsStore((state) => state.settings.books);
  const money = useMoney();
  const file = useCostsStore((state) => state.file);
  const views = useAutopilotStore((state) => state.views);
  const summaries = useAutopilotStore((state) => state.summaries);
  const serverBooks = useAutopilotStore((state) => state.server.books);
  const budgets = useMemo(() => normalizeBudgets(rawBudgets), [rawBudgets]);
  const { bookId, cost, currency, chapters } = input;
  const costMin = cost?.min;
  const costMax = cost?.max;
  const first = chapters?.first;
  const count = chapters?.count;
  const kind = chapters?.kind;
  return useMemo(() => {
    if (!budgets || cost === undefined) return null;
    const store = { views, summaries, server: { books: serverBooks } };
    const rows = usageRows(file, money.display);
    const { books: served } = serverSpend(books, store, money, "");
    const { plan } = budgetPlan({ budgets, rows, context: money, today: localDay(new Date()), served, bookId, runCurrency: currency, statsCost: autopilotStatsOf(store, bookId)?.cost ?? 0 });
    return budgetOutlook({ plan, cost: costMin === undefined || costMax === undefined ? null : { min: costMin, max: costMax }, currency, chapters: first === undefined || count === undefined || kind === undefined ? null : { first, count, kind }, rates: money.rates });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgets, books, file, views, summaries, serverBooks, money, bookId, currency, costMin, costMax, first, count, kind, cost === undefined]);
}
