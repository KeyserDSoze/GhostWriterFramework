import type { UsageRow } from "@/costs/ledger";
import { CURRENCY_CODE, keyCurrency, rateBetween, type MoneyTotals } from "@/costs/money";
import { inMonth, summarize } from "@/costs/usageViews";
import type { CostBudgetLimit, CostBudgets, CostExchangeRate, CostRelabel } from "@/types/settings";

/**
 * The budgets of the costs (spec point 5), as pure functions of the settings (`costBudgets`) and of the rows of the usage ledger.
 *
 * A budget is a limit in one currency, per calendar month or in total, for all the books together or for one book. What counts against it is what the ledger recorded in that currency
 * (every use, or the autopilot only: `counts`), plus, converted at a rate of the settings, what was recorded in another currency that has one; an amount in a currency with no
 * rate is not counted, and is said. Amounts are never added across currencies without a rate.
 *
 * The autopilot is stopped by the engine's own cap, never by a second mechanism: `planCap` turns what the budgets leave of a book into the cap (`options.budgetLimit`) the engine
 * compares with the cost of the book it counts itself, over all its runs: the cost the book has now plus what is left.
 */

/** The share of a budget at which it is warned about, unless the person chose another. */
export const DEFAULT_WARN_AT = 80;
/** The most a budget can say: the most the engine accepts for the cap of a book. */
export const MAX_BUDGET = 1_000_000;

export type BudgetPeriod = "month" | "total";
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["month", "total"];
export type BudgetState = "ok" | "warn" | "over";
export type BudgetLimits = Record<string, CostBudgetLimit>;

const amountOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_BUDGET ? value : undefined);

/** The limits of a scope that can be used: three-letter currencies, amounts over zero up to the most the engine takes; nothing for a scope with none. */
export function normalizeLimits(value: unknown): BudgetLimits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const limits: BudgetLimits = {};
  for (const [currency, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CURRENCY_CODE.test(currency) || !entry || typeof entry !== "object") continue;
    const month = amountOf((entry as CostBudgetLimit).month);
    const total = amountOf((entry as CostBudgetLimit).total);
    if (month !== undefined || total !== undefined) limits[currency] = { ...(month !== undefined ? { month } : {}), ...(total !== undefined ? { total } : {}) };
  }
  return Object.keys(limits).length ? limits : undefined;
}

/** The budgets of the settings that can be used, and `undefined` without any: settings that never had budgets read as they were. */
export function normalizeBudgets(value: unknown): CostBudgets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as CostBudgets;
  const global = normalizeLimits(source.global);
  const books: Record<string, BudgetLimits> = {};
  if (source.books && typeof source.books === "object" && !Array.isArray(source.books)) {
    for (const [bookId, limits] of Object.entries(source.books)) {
      const normal = bookId ? normalizeLimits(limits) : undefined;
      if (normal) books[bookId] = normal;
    }
  }
  if (!global && !Object.keys(books).length) return undefined;
  const warnAt = typeof source.warnAt === "number" && Number.isInteger(source.warnAt) && source.warnAt >= 1 && source.warnAt <= 99 ? source.warnAt : undefined;
  return {
    ...(warnAt !== undefined && warnAt !== DEFAULT_WARN_AT ? { warnAt } : {}),
    ...(source.counts === "autopilot" ? { counts: "autopilot" as const } : {}),
    ...(global ? { global } : {}),
    ...(Object.keys(books).length ? { books } : {}),
  };
}

/** An amount as a person types it, with a decimal comma too: `null` for a blank field, `NaN` for one that is not a number. */
export function typedAmount(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) return null;
  const normalized = /^\d{1,3}(\.\d{3})+,\d+$/.test(trimmed) ? trimmed.replace(/\./g, "").replace(",", ".") : trimmed.replace(",", ".");
  return /^(\d+(\.\d*)?|\.\d+)$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/** Whether a typed amount is a limit that can be used: over zero, up to the most the engine takes. */
export function validAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_BUDGET;
}

export function warnAtOf(budgets: CostBudgets | undefined): number {
  const warnAt = budgets?.warnAt;
  return typeof warnAt === "number" && warnAt >= 1 && warnAt <= 99 ? warnAt : DEFAULT_WARN_AT;
}

/** The limits of the budget of all the books (`""`) or of one book. */
export function limitsOf(budgets: CostBudgets | undefined, bookId: string): BudgetLimits {
  return (bookId ? budgets?.books?.[bookId] : budgets?.global) ?? {};
}

/** The budgets with the limits of one scope replaced by `limits` (none at all removes the scope); the result is normal, or `undefined` when nothing is left. */
export function withLimits(budgets: CostBudgets | undefined, bookId: string, limits: BudgetLimits): CostBudgets | undefined {
  const next: CostBudgets = { ...budgets };
  if (bookId) next.books = { ...budgets?.books, [bookId]: limits };
  else next.global = limits;
  return normalizeBudgets(next);
}

/** One limit of one budget against what was spent: the unit the dashboard, the top bar and the cap of the autopilot read. */
export interface BudgetLine {
  scope: "global" | "book";
  /** `""` for the budget of all the books. */
  bookId: string;
  period: BudgetPeriod;
  currency: string;
  limit: number;
  /** What counts against it, in `currency`. */
  spent: number;
  ratio: number;
  state: BudgetState;
  /** Part of `spent` was recorded in another currency and converted at a rate of the settings. */
  converted: boolean;
  /** What the ledger holds in currencies with no rate to `currency`: not in `spent`, so the real figure may be higher. */
  uncounted: MoneyTotals;
}

/** The cost of an autopilot of a book that runs on the personal server, which this browser's ledger does not hold: it counts in the total budgets. */
export interface UnrecordedCost {
  bookId: string;
  currency: string;
  cost: number;
}

export interface BudgetContext {
  /** The day of today (`YYYY-MM-DD`): its month is «this month». */
  today: string;
  rates: readonly CostExchangeRate[];
  relabels?: readonly CostRelabel[];
  unrecorded?: readonly UnrecordedCost[];
}

export function stateOf(ratio: number, warnAt: number): BudgetState {
  if (ratio >= 1) return "over";
  return ratio * 100 >= warnAt ? "warn" : "ok";
}

/** The amounts by currency expressed in one currency: those in it, those that have a rate to it (converted), and what has none (apart). */
function expressed(currency: string, totals: MoneyTotals, rates: readonly CostExchangeRate[]): { amount: number; converted: boolean; uncounted: MoneyTotals } {
  let amount = 0;
  let converted = false;
  const uncounted: MoneyTotals = {};
  for (const [key, value] of Object.entries(totals)) {
    if (!Number.isFinite(value) || value === 0) continue;
    const own = keyCurrency(key).currency;
    if (own === currency) {
      amount += value;
      continue;
    }
    const conversion = rateBetween(own, currency, rates);
    if (conversion) {
      amount += value * conversion.factor;
      converted = true;
    } else {
      uncounted[own] = (uncounted[own] ?? 0) + value;
    }
  }
  return { amount, converted, uncounted };
}

/** Every limit of the budgets against what the ledger says was spent, for the scopes the budgets name. */
export function budgetLines(budgets: CostBudgets | undefined, rows: readonly UsageRow[], context: BudgetContext): BudgetLine[] {
  if (!budgets) return [];
  const warnAt = warnAtOf(budgets);
  const month = context.today.slice(0, 7);
  const lines: BudgetLine[] = [];
  const scopes: Array<{ bookId: string; limits: BudgetLimits }> = [];
  if (budgets.global) scopes.push({ bookId: "", limits: budgets.global });
  for (const [bookId, limits] of Object.entries(budgets.books ?? {})) scopes.push({ bookId, limits });
  for (const { bookId, limits } of scopes) {
    const mine = (row: UsageRow) => (bookId === "" || row.bookId === bookId) && (budgets.counts !== "autopilot" || row.source === "autopilot");
    const totals: Record<BudgetPeriod, MoneyTotals | null> = { month: null, total: null };
    for (const period of BUDGET_PERIODS) {
      if (!Object.values(limits).some((limit) => limit[period] !== undefined)) continue;
      let money = summarize(rows, (row) => mine(row) && (period === "total" || inMonth(row, month)), context.relabels).money;
      if (period === "total") {
        for (const extra of context.unrecorded ?? []) {
          if ((bookId === "" || extra.bookId === bookId) && extra.currency && extra.cost > 0) money = { ...money, [extra.currency]: (money[extra.currency] ?? 0) + extra.cost };
        }
      }
      totals[period] = money;
    }
    for (const [currency, limit] of Object.entries(limits).sort(([left], [right]) => left.localeCompare(right))) {
      for (const period of BUDGET_PERIODS) {
        const max = limit[period];
        const money = totals[period];
        if (max === undefined || !money) continue;
        const spent = expressed(currency, money, context.rates);
        const ratio = spent.amount / max;
        lines.push({ scope: bookId ? "book" : "global", bookId, period, currency, limit: max, spent: spent.amount, ratio, state: stateOf(ratio, warnAt), converted: spent.converted, uncounted: spent.uncounted });
      }
    }
  }
  return lines;
}

/**
 * What the autopilot of the books that run on the personal server cost beyond what this browser's ledger holds of it: the server's own count (`cost`, over all its runs) less what the
 * ledger recorded of that book's autopilot in the same currency (the steps it ran here before the book moved). Only what is over zero.
 */
export function unrecordedCosts(rows: readonly UsageRow[], served: ReadonlyArray<{ bookId: string; currency: string; cost: number }>): UnrecordedCost[] {
  const extra: UnrecordedCost[] = [];
  for (const entry of served) {
    if (!entry.currency || !(entry.cost > 0)) continue;
    let recorded = 0;
    for (const row of rows) if (row.bookId === entry.bookId && row.source === "autopilot" && row.currency === entry.currency) recorded += row.cost;
    if (entry.cost > recorded) extra.push({ bookId: entry.bookId, currency: entry.currency, cost: entry.cost - recorded });
  }
  return extra;
}

/** The lines that apply to a book: the budget of every book together and its own. */
export function linesOf(lines: readonly BudgetLine[], bookId: string): BudgetLine[] {
  return lines.filter((line) => line.scope === "global" || line.bookId === bookId);
}

/** The line that is furthest on (the highest share used), or `null` without any. */
export function worstLine(lines: readonly BudgetLine[]): BudgetLine | null {
  let worst: BudgetLine | null = null;
  for (const line of lines) if (!worst || line.ratio > worst.ratio) worst = line;
  return worst;
}

/** The lines that call for a word: at the share they are warned about, or over. */
export function alertLines(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines.filter((line) => line.state !== "ok").sort((left, right) => right.ratio - left.ratio);
}

/** A new limit a person is likely to want when one is used up: half as much again, or a quarter over what was spent, rounded up to a figure that reads well. */
export function suggestedBudget(limit: number, spent: number): number {
  const raised = Math.max(limit * 1.5, spent * 1.25);
  const rounded = raised >= 10 ? Math.ceil(raised) : Math.ceil(raised * 100) / 100;
  return Math.min(MAX_BUDGET, Math.max(rounded, limit + 0.01));
}

export interface CapPlan {
  /**
   * The cap to give the engine (`options.budgetLimit`), in the currency of the run: the cost the book has now (what the engine counts) plus what the budgets leave. `null`: no budget
   * limits this run (none applies, or what applies has no rate to the currency of the run, or what is left is more than the engine takes).
   */
  cap: number | null;
  /** The budget that leaves least, with what it leaves in its own currency and in the run's. */
  binding: (BudgetLine & { left: number; leftInRun: number }) | null;
  /** Budgets in a currency with no rate to the run's: they cannot limit it. */
  unlimited: BudgetLine[];
  /**
   * Nothing is left and the book has spent nothing yet: the cap would be 0, which for the engine means none, so it cannot be told to stop before its first step. The start is refused instead.
   */
  usedUp: boolean;
}

const MICRO = 1_000_000;

/**
 * What the budgets leave of one book for a run priced in `runCurrency`: the smallest of what is left of each budget that applies (a budget in another currency counts at a rate
 * of the settings, and one with none cannot limit the run), added to `statsCost`, the cost the engine counts for the book (over all its runs, in the currency of the prices).
 */
export function planCap(lines: readonly BudgetLine[], input: { bookId: string; runCurrency: string; statsCost: number; rates: readonly CostExchangeRate[] }): CapPlan {
  let binding: CapPlan["binding"] = null;
  const unlimited: BudgetLine[] = [];
  for (const line of linesOf(lines, input.bookId)) {
    const factor = line.currency === input.runCurrency ? 1 : rateBetween(line.currency, input.runCurrency, input.rates)?.factor;
    if (!factor) {
      unlimited.push(line);
      continue;
    }
    const left = Math.max(0, line.limit - line.spent);
    const leftInRun = left * factor;
    if (!binding || leftInRun < binding.leftInRun) binding = { ...line, left, leftInRun };
  }
  if (!binding) return { cap: null, binding: null, unlimited, usedUp: false };
  const cap = Math.round((Math.max(0, input.statsCost) + binding.leftInRun) * MICRO) / MICRO;
  if (cap > MAX_BUDGET) return { cap: null, binding, unlimited, usedUp: false };
  // A cap of 0 means «none» to the engine: a book that has spent nothing, with nothing left, cannot be stopped by it before its first step.
  if (cap <= 0) return { cap: null, binding, unlimited, usedUp: true };
  return { cap, binding, unlimited, usedUp: false };
}
