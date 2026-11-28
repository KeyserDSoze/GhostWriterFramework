import { budgetLines, planCap, unrecordedCosts, type BudgetLine, type CapPlan } from "@/costs/budgets";
import type { UsageRow } from "@/costs/ledger";
import type { MoneyContext } from "@/costs/money";
import type { ServerBookSpend } from "@/costs/serverSpend";
import type { CostBudgets } from "@/types/settings";

export interface BudgetPlanInput {
  budgets: CostBudgets;
  rows: readonly UsageRow[];
  context: Pick<MoneyContext, "rates" | "relabels">;
  /** The day of today (`YYYY-MM-DD`): its month is «this month». */
  today: string;
  /** What the personal server counts of its books (`serverSpend`): it counts in the total budgets, less what the ledger already holds of the same book. */
  served: readonly ServerBookSpend[];
  bookId: string;
  /** The currency the run is priced in, and the cost the engine counts for the book so far (in it): what the cap of the engine is made of. */
  runCurrency: string;
  statsCost: number;
}

/**
 * What the budgets leave of a book: every line of the budgets against the ledger, and the money cap the engine would be given (`planCap`). The one computation the start of an autopilot
 * (`startWithBudgets`) and the estimate of a run before it starts (`budgetOutlook`) both read, so that what is said before a run is what the engine then does.
 */
export function budgetPlan(input: BudgetPlanInput): { lines: BudgetLine[]; plan: CapPlan } {
  const unrecorded = unrecordedCosts(input.rows, input.served.map((entry) => ({ bookId: entry.bookId, currency: entry.currency, cost: entry.cost })));
  const lines = budgetLines(input.budgets, input.rows, { today: input.today, rates: input.context.rates, relabels: input.context.relabels, unrecorded });
  return { lines, plan: planCap(lines, { bookId: input.bookId, runCurrency: input.runCurrency, statsCost: input.statsCost, rates: input.context.rates }) };
}
