import type { StartOptions } from "narrarium-engine";
import i18n from "@/i18n";
import { bookAutopilotOf } from "@/autopilot/bookAutopilot";
import { useAutopilotStore } from "@/autopilot/store";
import { appliedCapOf, decideCap, rememberAppliedCap, type AppliedCap } from "@/costs/budgetCaps";
import { normalizeBudgets } from "@/costs/budgets";
import { budgetPlan } from "@/costs/budgetPlan";
import { serverSpend } from "@/costs/serverSpend";
import { useCostsStore } from "@/costs/costsStore";
import { usageRows } from "@/costs/legacyCosts";
import { moneyContextOf } from "@/costs/useMoney";
import { localDay } from "@/costs/period";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookEntry } from "@/types/settings";
import "@/i18n/costs";

/**
 * The budgets are used up and the book has spent nothing yet: the engine's cap cannot say «stop before the first step» (a cap of 0 is none), so the start is refused, and the person
 * decides whether to start anyway (`allowBudgetOverrun`) or to raise the budget. Never thrown when the book has run: the engine's own cap stops it before its next step.
 */
export class AutopilotBudgetUsedUpError extends Error {
  readonly code = "budget-used-up";
  constructor(readonly binding: NonNullable<AppliedCap["binding"]>) {
    super(i18n.t("costs.budget.usedUpError", { scope: binding.scope === "global" ? i18n.t("costs.budget.scope.global") : i18n.t("costs.budget.scope.book"), period: i18n.t(`costs.budget.period.${binding.period}`).toLowerCase() }));
    this.name = "AutopilotBudgetUsedUpError";
  }
}

/** Whether the budgets could change what a start of the book sends: there are some, or they gave the book a cap that is still to be given back. */
export function budgetsApply(bookId: string): boolean {
  return Boolean(normalizeBudgets(useSettingsStore.getState().settings.costBudgets)) || appliedCapOf(bookId) !== null;
}

export function isBudgetUsedUp(error: unknown): error is AutopilotBudgetUsedUpError {
  return error instanceof Error && (error as { code?: unknown }).code === "budget-used-up";
}

type Start = StartOptions & { force?: boolean; afterRestart?: boolean };

/**
 * The start of an autopilot with the money cap the budgets leave (spec point 5). The cap is the engine's own (`options.budgetLimit`): what the budgets that apply to the book leave,
 * counted from the ledger, added to the cost the engine counts for the book, so that the run is paused by the engine before the first step that would pass them, with the reason panel
 * of every cap. The person's own cap is kept (the run stops at the smaller) and given back when the budgets no longer limit the book. The same start options go to a book on the personal server.
 *
 * `ignore` is the person's choice to go on whatever the budgets say, for this start only. Nothing happens, and nothing is read, for a book without budgets that never had a cap of them.
 */
export function startWithBudgets<T extends Start>(book: BookEntry, start: T, ignore: boolean, now = new Date()): T {
  const settings = useSettingsStore.getState().settings;
  const budgets = normalizeBudgets(settings.costBudgets);
  const marker = appliedCapOf(book.id);
  if (!budgets && !marker) return start;
  const known = bookAutopilotOf(useAutopilotStore.getState(), book.id);
  const current = known.options?.budgetLimit ?? 0;
  const explicit = start.options?.budgetLimit;
  const context = moneyContextOf(settings);
  const rows = usageRows(useCostsStore.getState().file, context.display);
  let plan = null;
  if (budgets && !ignore) {
    const { books: served } = serverSpend(settings.books, useAutopilotStore.getState(), context, "");
    plan = budgetPlan({ budgets, rows, context, today: localDay(now), served, bookId: book.id, runCurrency: context.display, statsCost: known.stats?.cost ?? 0 }).plan;
    if (plan.usedUp && plan.binding) {
      const { scope, bookId, period, currency, limit } = plan.binding;
      throw new AutopilotBudgetUsedUpError({ scope, bookId, period, currency, limit });
    }
  }
  const decision = decideCap({ marker, current, ...(explicit !== undefined ? { explicit } : {}), plan, ignore });
  rememberAppliedCap(book.id, decision.applied);
  if (decision.budgetLimit === undefined) return start;
  return { ...start, options: { ...start.options, budgetLimit: decision.budgetLimit } };
}
