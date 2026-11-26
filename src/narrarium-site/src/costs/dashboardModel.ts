import { EARLIER } from "@/costs/legacyCosts";
import type { UsageRow } from "@/costs/ledger";
import { viewMoney, addRecordedMoney, type MoneyContext, type MoneyTotals } from "@/costs/money";
import { localDay, localMonth } from "@/costs/period";
import { summarize, type UsageSummary } from "@/costs/usageViews";
import type { CostRelabel } from "@/types/settings";

/**
 * The dashboard of the costs (spec point 4), as pure functions of the rows of the ledger: what a filter keeps, how the rows are grouped (by book, by month,
 * by source), the trend of each group, the order of the table and the lines of the CSV. Every amount stays in its currency (`MoneyTotals`); the views
 * of `costs/money.ts` decide how they are shown.
 */

export type GroupBy = "books" | "months" | "sources";

/** This month, the last 30 days, every row there is (the «earlier» part included), or the days from `from` to `to` (inclusive, `YYYY-MM-DD`). */
export type PeriodFilter = { kind: "month" } | { kind: "30d" } | { kind: "all" } | { kind: "custom"; from: string; to: string };

export interface DashboardFilters {
  period: PeriodFilter;
  /** `""`: every one. */
  bookId: string;
  source: string;
  capability: string;
  model: string;
  integrationId: string;
  currency: string;
}

export const ALL = "";

export function defaultFilters(): DashboardFilters {
  return { period: { kind: "month" }, bookId: ALL, source: ALL, capability: ALL, model: ALL, integrationId: ALL, currency: ALL };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDay(new Date(year, month - 1, date + days));
}

/** The first and the last day of a month (`YYYY-MM`). */
function monthDays(month: string): { first: string; last: string } {
  const [year, number] = month.split("-").map(Number);
  return { first: localDay(new Date(year, number - 1, 1)), last: localDay(new Date(year, number, 0)) };
}

/** The days a period covers, both included, or `null` for every row there is. */
export function periodRange(period: PeriodFilter, today: string): { from: string; to: string } | null {
  if (period.kind === "all") return null;
  if (period.kind === "month") {
    const { first, last } = monthDays(today.slice(0, 7));
    return { from: first, to: last };
  }
  if (period.kind === "30d") return { from: addDays(today, -29), to: today };
  const from = DAY.test(period.from) ? period.from : "0000-01-01";
  const to = DAY.test(period.to) ? period.to : "9999-12-31";
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Whether a row is of a period: a day by its date; a month (what compaction made of the days of a month older than three months) when the period
 * touches that month, counted whole, as it is the finest the ledger keeps of it; the «earlier» part only for every row there is.
 */
export function inPeriod(row: Pick<UsageRow, "period">, period: PeriodFilter, today: string): boolean {
  const range = periodRange(period, today);
  if (!range) return true;
  if (DAY.test(row.period)) return row.period >= range.from && row.period <= range.to;
  if (MONTH.test(row.period)) {
    const { first, last } = monthDays(row.period);
    return first <= range.to && last >= range.from;
  }
  return false;
}

/** Whether a row passes the filters: the period, and each of the others when it names one. */
export function matches(row: UsageRow, filters: DashboardFilters, today: string): boolean {
  if (!inPeriod(row, filters.period, today)) return false;
  if (filters.bookId !== ALL && row.bookId !== filters.bookId) return false;
  if (filters.source !== ALL && row.source !== filters.source) return false;
  if (filters.capability !== ALL && row.capability !== filters.capability) return false;
  if (filters.model !== ALL && row.model !== filters.model) return false;
  if (filters.integrationId !== ALL && row.integrationId !== filters.integrationId) return false;
  if (filters.currency !== ALL && row.currency !== filters.currency) return false;
  return true;
}

export function filterRows(rows: readonly UsageRow[], filters: DashboardFilters, today: string): UsageRow[] {
  return rows.filter((row) => matches(row, filters, today));
}

/** How many filters other than the period name something. */
export function activeFilters(filters: DashboardFilters): number {
  return [filters.bookId, filters.source, filters.capability, filters.model, filters.integrationId, filters.currency].filter((value) => value !== ALL).length;
}

/** The key of a row in a grouping: its book, its month (`EARLIER` for the part before the ledger), its source. */
export function groupKey(row: Pick<UsageRow, "bookId" | "period" | "source">, by: GroupBy): string {
  if (by === "books") return row.bookId;
  if (by === "months") return MONTH.test(row.period) || DAY.test(row.period) ? row.period.slice(0, 7) : EARLIER;
  return row.source;
}

/** A point of a trend: its period (`YYYY-MM` or `YYYY-MM-DD`) and its money by currency. */
export interface TrendPoint {
  period: string;
  money: MoneyTotals;
}

export interface DashboardGroup {
  key: string;
  summary: UsageSummary;
  /** The models of its rows, the most expensive first, with their integration. */
  models: Array<{ integrationId: string; model: string }>;
  trend: TrendPoint[];
}

/** The months a trend shows: six, the last one the month the trend ends in. */
export const TREND_MONTHS = 6;

/** The `count` months that end in `end` (a month, or a day: its month), the last one included. */
function monthsEnding(end: string, count: number): string[] {
  const [year, month] = end.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => localMonth(new Date(year, month - 1 - (count - 1 - index), 1)));
}

/**
 * Where a group stands over the last six months: what a book or a use spent each month up to this month, or, for the row of a month, what every use spent
 * in the six months that end in it (a month the ledger compacted has no days, only a month: the month is the finest a trend can be). The rows are all the
 * rows the other filters keep, whatever the period: a trend is the history the period is part of. The «earlier» part has none.
 */
export function trendOf(rows: readonly UsageRow[], by: GroupBy, key: string, today: string, relabels?: readonly CostRelabel[]): TrendPoint[] {
  const end = by === "months" ? (key === EARLIER ? null : key) : today.slice(0, 7);
  const periods = end ? monthsEnding(end, TREND_MONTHS) : [];
  const points = new Map(periods.map((period) => [period, {} as MoneyTotals]));
  for (const row of rows) {
    if (!row.cost || (by !== "months" && groupKey(row, by) !== key)) continue;
    const slot = row.period.slice(0, 7);
    const current = points.get(slot);
    if (current) points.set(slot, addRecordedMoney(current, row.currency, row.cost, row.period, relabels));
  }
  return periods.map((period) => ({ period, money: points.get(period) ?? {} }));
}

/**
 * The groups of the rows that pass the filters, with their trend from every row of the group (`allRows`, what the other filters keep whatever the period:
 * a trend is the history the period is part of).
 */
export function buildGroups(rows: readonly UsageRow[], allRows: readonly UsageRow[], by: GroupBy, today: string, relabels?: readonly CostRelabel[]): DashboardGroup[] {
  const grouped = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = groupKey(row, by);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  return [...grouped.entries()].map(([key, groupRows]) => {
    const spend = new Map<string, { integrationId: string; model: string; cost: number }>();
    for (const row of groupRows) {
      if (!row.model) continue;
      const id = `${row.integrationId}\u0000${row.model}`;
      const entry = spend.get(id) ?? { integrationId: row.integrationId, model: row.model, cost: 0 };
      entry.cost += row.cost;
      spend.set(id, entry);
    }
    return {
      key,
      summary: summarize(groupRows, undefined, relabels),
      models: [...spend.values()].sort((left, right) => right.cost - left.cost || left.model.localeCompare(right.model)).map(({ integrationId, model }) => ({ integrationId, model })),
      trend: trendOf(allRows, by, key, today, relabels),
    };
  });
}

export type SortKey = "name" | "spend" | "tasks" | "calls" | "tokens";
export type SortDirection = "ascending" | "descending";

/** The amount a total comes to in the display currency, for ordering: what cannot be converted counts after what can, never added to it. */
export function orderValue(totals: MoneyTotals, context: MoneyContext): number {
  const view = viewMoney(totals, context);
  return (view.shown?.amount ?? 0) + view.others.reduce((sum, other) => sum + other.amount * 1e-9, 0);
}

/**
 * The groups in order. `orderOf` is what the name of a group sorts by: the name the person reads for a book or a use, the month itself (`2026-11`, the
 * «earlier» part before them all) for a month, whose name in words does not sort by date.
 */
export function sortGroups(groups: readonly DashboardGroup[], key: SortKey, direction: SortDirection, orderOf: (key: string) => string, context: MoneyContext): DashboardGroup[] {
  const sign = direction === "ascending" ? 1 : -1;
  const value = (group: DashboardGroup): number => {
    if (key === "spend") return orderValue(group.summary.money, context);
    if (key === "tasks") return group.summary.tasks;
    if (key === "calls") return group.summary.calls;
    return group.summary.inputTokens + group.summary.outputTokens;
  };
  return [...groups].sort((left, right) => {
    const byName = orderOf(left.key).localeCompare(orderOf(right.key));
    if (key === "name") return sign * byName || sign * left.key.localeCompare(right.key);
    return sign * (value(left) - value(right)) || byName;
  });
}

/** What each filter can choose from: the values the rows have, in order. */
export interface FilterOptions {
  bookIds: string[];
  sources: string[];
  capabilities: string[];
  models: string[];
  integrationIds: string[];
  currencies: string[];
}

export function optionsOf(rows: readonly UsageRow[], sourceOrder: readonly string[]): FilterOptions {
  const distinct = (pick: (row: UsageRow) => string) => [...new Set(rows.map(pick).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const sources = new Set(rows.map((row) => row.source));
  return {
    bookIds: distinct((row) => row.bookId),
    sources: [...sourceOrder.filter((source) => sources.has(source)), ...[...sources].filter((source) => !sourceOrder.includes(source)).sort()],
    capabilities: distinct((row) => row.capability),
    models: distinct((row) => row.model),
    integrationIds: distinct((row) => row.integrationId),
    currencies: distinct((row) => row.currency),
  };
}

const CSV_COLUMNS = [
  "period", "book", "source", "capability", "integration", "model", "currency", "calls", "tasks", "input_tokens", "cached_tokens", "output_tokens", "cost",
  "estimated_cost", "estimated_input_tokens", "estimated_output_tokens", "unpriced_calls", "unknown_usage_calls",
] as const;

/** A cell of a CSV: quoted when it has to be, and never read as a formula by a spreadsheet (a text that starts with = + - @ is written after a quote). */
export function csvCell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function plainMoney(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : 0;
}

/**
 * The rows that pass the filters as a CSV, one line for each row of the ledger (its period, book, source, capability, integration, model and currency) with
 * its counters: every amount in its own currency, the estimates apart, as recorded. Names are the ones the person reads; the «earlier» part is `earlier`.
 */
export function toCsv(rows: readonly UsageRow[], bookName: (bookId: string) => string, integrationName: (integrationId: string) => string): string {
  const lines = [CSV_COLUMNS.join(",")];
  // Newest first; the «earlier» part, older than every day, last.
  const when = (row: UsageRow) => (row.period === EARLIER ? "" : row.period);
  const ordered = [...rows].sort((left, right) => when(right).localeCompare(when(left)) || left.bookId.localeCompare(right.bookId) || left.source.localeCompare(right.source) || left.model.localeCompare(right.model));
  for (const row of ordered) {
    lines.push([
      row.period, row.bookId ? bookName(row.bookId) : "", row.source, row.capability, row.integrationId ? integrationName(row.integrationId) : "", row.model, row.currency,
      row.calls, row.tasks, row.inputTokens, row.cachedTokens, row.outputTokens, plainMoney(row.cost), plainMoney(row.estimatedCost), row.estimatedInputTokens,
      row.estimatedOutputTokens, row.unpricedCalls, row.unknownUsageCalls,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Today, in the local day of this device, as the ledger counts its days. */
export function todayOf(now: Date = new Date()): string {
  return localDay(now);
}
