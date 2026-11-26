import { useMemo } from "react";
import { budgetLines, normalizeBudgets, warnAtOf, type BudgetLine, type UnrecordedCost } from "@/costs/budgets";
import { localDay } from "@/costs/period";
import type { UsageRow } from "@/costs/ledger";
import { useMoney } from "@/costs/useMoney";
import { useSettingsStore } from "@/store/settingsStore";
import type { CostBudgets } from "@/types/settings";

export interface BudgetsView {
  budgets: CostBudgets | undefined;
  lines: BudgetLine[];
  warnAt: number;
}

/**
 * The budgets of the settings against the rows of the ledger, followed live: a new record, a limit changed, a rate or a relabel change the lines at once. `unrecorded` is what the
 * personal server's autopilots cost beyond what the ledger holds (it counts in the total budgets only).
 */
export function useBudgetLines(rows: readonly UsageRow[], unrecorded?: readonly UnrecordedCost[]): BudgetsView {
  const raw = useSettingsStore((state) => state.settings.costBudgets);
  const money = useMoney();
  const budgets = useMemo(() => normalizeBudgets(raw), [raw]);
  const today = localDay(new Date());
  const lines = useMemo(() => budgetLines(budgets, rows, { today, rates: money.rates, relabels: money.relabels, ...(unrecorded ? { unrecorded } : {}) }), [budgets, rows, today, money.rates, money.relabels, unrecorded]);
  return { budgets, lines, warnAt: warnAtOf(budgets) };
}
