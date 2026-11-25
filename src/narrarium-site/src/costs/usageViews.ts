import { emptyCounters, type UsageCounters, type UsageRow } from "@/costs/ledger";
import { addMoney, type MoneyTotals } from "@/costs/money";

/**
 * Sums of rows of the ledger, for what the person reads: money by currency (measured and estimated apart: never added to each other), and the counts.
 * Rows of different currencies are never added into one amount here: `money` keeps one total per currency (see `money.ts` for how they are shown).
 */
export interface UsageSummary extends Omit<UsageCounters, "cost" | "estimatedCost"> {
  /** Measured money, by currency. */
  money: MoneyTotals;
  /** Estimated money (calls whose tokens were not reported, at the price of their model), by currency. */
  estimated: MoneyTotals;
  rows: number;
}

export function emptySummary(): UsageSummary {
  const { cost: _cost, estimatedCost: _estimated, ...counts } = emptyCounters();
  return { ...counts, money: {}, estimated: {}, rows: 0 };
}

const COUNT_FIELDS = ["calls", "tasks", "inputTokens", "cachedTokens", "outputTokens", "unpricedCalls", "unknownUsageCalls", "estimatedInputTokens", "estimatedOutputTokens"] as const;

export function addRow(summary: UsageSummary, row: UsageRow): UsageSummary {
  const next: UsageSummary = { ...summary, rows: summary.rows + 1 };
  for (const field of COUNT_FIELDS) next[field] = summary[field] + (Number.isFinite(row[field]) ? row[field] : 0);
  if (row.cost) next.money = addMoney(summary.money, row.currency, row.cost);
  if (row.estimatedCost) next.estimated = addMoney(summary.estimated, row.currency, row.estimatedCost);
  return next;
}

export function summarize(rows: Iterable<UsageRow>, keep: (row: UsageRow) => boolean = () => true): UsageSummary {
  let summary = emptySummary();
  for (const row of rows) if (keep(row)) summary = addRow(summary, row);
  return summary;
}

/** Rows grouped by a key (a book, a source, a month…), each group summed. */
export function summarizeBy(rows: Iterable<UsageRow>, keyOf: (row: UsageRow) => string | null, keep: (row: UsageRow) => boolean = () => true): Map<string, UsageSummary> {
  const groups = new Map<string, UsageSummary>();
  for (const row of rows) {
    if (!keep(row)) continue;
    const key = keyOf(row);
    if (key === null) continue;
    groups.set(key, addRow(groups.get(key) ?? emptySummary(), row));
  }
  return groups;
}

/** Whether a row is of a month (`2026-11`): its days and the month row compaction made of them. The «earlier» rows are of no month. */
export function inMonth(row: Pick<UsageRow, "period">, month: string): boolean {
  return row.period.startsWith(month);
}

export function totalTokens(summary: Pick<UsageSummary, "inputTokens" | "outputTokens">): number {
  return summary.inputTokens + summary.outputTokens;
}

/** The models that were used without a price, with their integration and how many calls they made: what the warning about calls without a price lists. */
export interface UnpricedModel {
  integrationId: string;
  model: string;
  calls: number;
}

export function unpricedModels(rows: Iterable<UsageRow>, keep: (row: UsageRow) => boolean = () => true): UnpricedModel[] {
  const models = new Map<string, UnpricedModel>();
  for (const row of rows) {
    if (!row.unpricedCalls || !keep(row)) continue;
    const key = `${row.integrationId}\u0000${row.model}`;
    const entry = models.get(key) ?? { integrationId: row.integrationId, model: row.model, calls: 0 };
    entry.calls += row.unpricedCalls;
    models.set(key, entry);
  }
  return [...models.values()].sort((left, right) => right.calls - left.calls || left.model.localeCompare(right.model));
}
