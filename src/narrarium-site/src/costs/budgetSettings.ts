import { limitsOf, normalizeBudgets, withLimits, type BudgetLimits, type BudgetLine } from "@/costs/budgets";
import { saveSettingsNow } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { CostBudgets } from "@/types/settings";

/**
 * What a person changes of the budgets, written to the settings (`costBudgets`): the store of the settings follows at once (what reads them, the next start of an autopilot
 * included, sees the change), and the account's store, and the cloud when it can, are written as every setting is (`saveSettingsNow`). The promise says whether that went well.
 */

function current(): CostBudgets | undefined {
  return normalizeBudgets(useSettingsStore.getState().settings.costBudgets);
}

function write(next: CostBudgets | undefined): Promise<boolean> {
  useSettingsStore.getState().patchSettings({ costBudgets: next });
  return saveSettingsNow().then(() => true, () => false);
}

/** The limits of one scope (a book, or `""` for all of them) replaced by `limits`; with the share a budget is warned at and what counts, when given (they are of all the budgets). */
export function saveBudgetLimits(bookId: string, limits: BudgetLimits, options: { warnAt?: number; counts?: "all" | "autopilot" } = {}): Promise<boolean> {
  const base: CostBudgets = { ...current() };
  if (options.warnAt !== undefined) base.warnAt = options.warnAt;
  if (options.counts !== undefined) {
    if (options.counts === "autopilot") base.counts = "autopilot";
    else delete base.counts;
  }
  return write(withLimits(base, bookId, limits));
}

/** The limit of one budget (its scope, its period, its currency) set to `limit`, the others as they were. */
export function raiseBudget(line: Pick<BudgetLine, "bookId" | "period" | "currency">, limit: number): Promise<boolean> {
  const limits = limitsOf(current(), line.bookId);
  return write(withLimits(current(), line.bookId, { ...limits, [line.currency]: { ...limits[line.currency], [line.period]: limit } }));
}
