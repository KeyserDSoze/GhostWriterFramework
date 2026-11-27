import type { UsageRow } from "@/costs/ledger";
import { cachedShare } from "@/costs/cacheSavings";
import { addRecordedMoney, type MoneyTotals } from "@/costs/money";
import { localDay } from "@/costs/period";
import type { CostRelabel } from "@/types/settings";

/**
 * What the providers' prompt caches did for the person, from the rows of the ledger (`UsageCounters.cachedTokens` is what a provider reported as served from its cache, `cachedSavings` what that saved at the
 * prices of its model): the share of the input that was served from the cache, and the money that saved against the full input rate. Pure functions of the rows, so that the dashboard, the estimate and the tests agree.
 */

export interface CacheLine {
  integrationId: string;
  model: string;
  /** The use of the call (`UsageRow.source`). */
  source: string;
  inputTokens: number;
  cachedTokens: number;
  /** 0 to 1. */
  share: number;
  saved: MoneyTotals;
}

export interface CacheTotals {
  inputTokens: number;
  cachedTokens: number;
  share: number;
  saved: MoneyTotals;
}

/** The rows of a chat model that reported its input: the other kinds (an image, a voice) have no prompt to cache. */
const isChat = (row: UsageRow): boolean => row.model !== "" && row.inputTokens > 0;

export function cacheTotals(rows: readonly UsageRow[], relabels?: readonly CostRelabel[]): CacheTotals {
  let inputTokens = 0;
  let cachedTokens = 0;
  let saved: MoneyTotals = {};
  for (const row of rows) {
    if (!isChat(row)) continue;
    inputTokens += row.inputTokens;
    cachedTokens += Math.min(row.cachedTokens, row.inputTokens);
    if (row.cachedSavings) saved = addRecordedMoney(saved, row.currency, row.cachedSavings, row.period, relabels);
  }
  return { inputTokens, cachedTokens, share: cachedShare(inputTokens, cachedTokens), saved };
}

/** The lines of the table: each model for each use, the models that were served from a cache first (by what they saved, then by the tokens), then the others by their input. */
export function cacheLines(rows: readonly UsageRow[], relabels?: readonly CostRelabel[]): CacheLine[] {
  const lines = new Map<string, CacheLine>();
  for (const row of rows) {
    if (!isChat(row)) continue;
    const id = `${row.integrationId}\u0000${row.model}\u0000${row.source}`;
    const line = lines.get(id) ?? { integrationId: row.integrationId, model: row.model, source: row.source, inputTokens: 0, cachedTokens: 0, share: 0, saved: {} };
    line.inputTokens += row.inputTokens;
    line.cachedTokens += Math.min(row.cachedTokens, row.inputTokens);
    if (row.cachedSavings) line.saved = addRecordedMoney(line.saved, row.currency, row.cachedSavings, row.period, relabels);
    lines.set(id, line);
  }
  return [...lines.values()]
    .map((line) => ({ ...line, share: cachedShare(line.inputTokens, line.cachedTokens) }))
    .sort((left, right) => right.cachedTokens - left.cachedTokens || right.inputTokens - left.inputTokens || left.model.localeCompare(right.model) || left.source.localeCompare(right.source));
}

/** How far back the hit rate of a model is measured, in days: older calls may have been asked another way (a prompt in another order) and say nothing of what the next ones will get. */
export const HIT_RATE_DAYS = 60;
/** The least a model must have been asked before its rate is believed: a few calls and a few thousand tokens. */
const MIN_CALLS = 3;
const MIN_INPUT_TOKENS = 4096;

/**
 * The share of the input of each model that its provider served from its cache, for the estimate: measured on the rows of the last `HIT_RATE_DAYS` days, by the name of the model, and only for a model that
 * showed a cache at all (a model that never reported a cached token says nothing: it is left to the declared start of its requests). Months the ledger compacted are not days and are not counted.
 */
export function cacheHitRates(rows: readonly UsageRow[], today: Date = new Date()): Record<string, number> {
  const from = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - HIT_RATE_DAYS));
  const sums = new Map<string, { calls: number; input: number; cached: number }>();
  for (const row of rows) {
    if (!isChat(row) || !/^\d{4}-\d{2}-\d{2}$/.test(row.period) || row.period < from) continue;
    const sum = sums.get(row.model) ?? { calls: 0, input: 0, cached: 0 };
    sum.calls += row.calls;
    sum.input += row.inputTokens;
    sum.cached += Math.min(row.cachedTokens, row.inputTokens);
    sums.set(row.model, sum);
  }
  const rates: Record<string, number> = {};
  for (const [model, sum] of sums) if (sum.calls >= MIN_CALLS && sum.input >= MIN_INPUT_TOKENS && sum.cached > 0) rates[model] = cachedShare(sum.input, sum.cached);
  return rates;
}

/** The key of a model of an integration in `modelsThatCached`. */
export const cachedModelKey = (integrationId: string, model: string): string => `${integrationId}\u0000${model}`;

/**
 * The models (as `cachedModelKey` says them) whose provider served tokens from its cache in any call of the ledger: what the settings call «learned automatically». The ledger is what keeps it, so that the page
 * never has to change the settings for it.
 */
export function modelsThatCached(rows: readonly UsageRow[]): Set<string> {
  const models = new Set<string>();
  for (const row of rows) if (isChat(row) && row.cachedTokens > 0) models.add(cachedModelKey(row.integrationId, row.model));
  return models;
}
