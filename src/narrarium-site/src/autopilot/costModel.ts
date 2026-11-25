import type { AutopilotActivity } from "narrarium-engine";
import { taskCostByTask, taskCostOf, type TaskCost } from "@/autopilot/taskCosts";
import { addRecordedMoney, keyCurrency, moneyKey, type MoneyTotals } from "@/costs/money";
import type { CostRelabel } from "@/types/settings";

/**
 * What a step or a run of the autopilot cost, for its card and for the band, from what is known of each attempt of it (an activity): the record of this
 * browser when it ran it (its calls, the money of each currency, the estimates apart, the models without a price), or the engine's own record of the step
 * (`activity.cost` in the currency the run recorded, and its tokens, which hold the engine's estimate for calls whose tokens were not reported) when it
 * ran elsewhere: on a personal server, on another device, or before this version. `source` says which, so that the view says where its numbers come from.
 * Nothing is ever worked out that no record says: no calls for a step this browser did not run, no cost for a model without a price.
 */
export interface CostView {
  money: MoneyTotals;
  estimated: MoneyTotals;
  /** `null` when an attempt ran elsewhere: its calls are not known here. */
  calls: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  estimatedTokens: number;
  unpricedCalls: number;
  unknownUsageCalls: number;
  unpriced: Array<{ integrationId: string; model: string }>;
  /** `device`: every attempt was recorded by this browser; `autopilot`: none was (the engine's record); `mixed`: some were. `none`: nothing was spent. */
  source: "device" | "autopilot" | "mixed" | "none";
}

export function emptyCostView(): CostView {
  return { money: {}, estimated: {}, calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, estimatedTokens: 0, unpricedCalls: 0, unknownUsageCalls: 0, unpriced: [], source: "none" };
}

function relabelled(totals: MoneyTotals, at: string, relabels: readonly CostRelabel[] | undefined): MoneyTotals {
  let next: MoneyTotals = {};
  for (const [key, amount] of Object.entries(totals)) next = addRecordedMoney(next, keyCurrency(key).recorded ?? key, amount, at, relabels);
  return next;
}

function addTotals(left: MoneyTotals, right: MoneyTotals): MoneyTotals {
  const next = { ...left };
  for (const [key, amount] of Object.entries(right)) if (amount) next[key] = (next[key] ?? 0) + amount;
  return next;
}

function joinSource(left: CostView["source"], right: CostView["source"]): CostView["source"] {
  if (left === "none") return right;
  if (right === "none") return left;
  return left === right ? left : "mixed";
}

/** What one attempt of a step cost: the browser's record of it, or the engine's. `recordedCurrency` is the currency the run recorded (`stats.currency`). */
export function attemptCost(activity: AutopilotActivity, record: TaskCost | undefined, recordedCurrency: string | undefined, relabels?: readonly CostRelabel[]): CostView {
  if (record) {
    return {
      money: relabelled(record.money, record.at, relabels),
      estimated: relabelled(record.estimated, record.at, relabels),
      calls: record.calls,
      inputTokens: record.inputTokens,
      cachedTokens: record.cachedTokens,
      outputTokens: record.outputTokens,
      estimatedTokens: record.estimatedTokens,
      unpricedCalls: record.unpricedCalls,
      unknownUsageCalls: record.unknownUsageCalls,
      unpriced: record.unpriced,
      source: "device",
    };
  }
  const spent = (activity.cost ?? 0) > 0 || (activity.usage?.inputTokens ?? 0) + (activity.usage?.outputTokens ?? 0) > 0;
  if (!spent) return emptyCostView();
  const at = activity.endedAt ?? activity.startedAt;
  return {
    ...emptyCostView(),
    money: activity.cost && recordedCurrency ? { [moneyKey(recordedCurrency, at, relabels)]: activity.cost } : {},
    calls: null,
    inputTokens: activity.usage?.inputTokens ?? 0,
    cachedTokens: activity.usage?.cachedInputTokens ?? 0,
    outputTokens: activity.usage?.outputTokens ?? 0,
    source: "autopilot",
  };
}

/** The sum of views: money by currency, the counts, the models without a price once each; calls only while every part knows them. */
export function joinCosts(views: readonly CostView[]): CostView {
  return views.reduce<CostView>((total, view) => ({
    money: addTotals(total.money, view.money),
    estimated: addTotals(total.estimated, view.estimated),
    calls: total.calls === null || view.calls === null ? null : total.calls + view.calls,
    inputTokens: total.inputTokens + view.inputTokens,
    cachedTokens: total.cachedTokens + view.cachedTokens,
    outputTokens: total.outputTokens + view.outputTokens,
    estimatedTokens: total.estimatedTokens + view.estimatedTokens,
    unpricedCalls: total.unpricedCalls + view.unpricedCalls,
    unknownUsageCalls: total.unknownUsageCalls + view.unknownUsageCalls,
    unpriced: [...total.unpriced, ...view.unpriced.filter((entry) => !total.unpriced.some((known) => known.integrationId === entry.integrationId && known.model === entry.model))],
    source: joinSource(total.source, view.source),
  }), emptyCostView());
}

/** What a step cost: every attempt of it, the retries and the fallbacks that were billed included. `bookId` absent: the attempts are found by their ids alone. */
export function stepCost(bookId: string | undefined, attempts: readonly AutopilotActivity[], tasks: Record<string, TaskCost>, recordedCurrency: string | undefined, relabels?: readonly CostRelabel[]): CostView {
  return joinCosts(attempts.map((activity) => attemptCost(activity, bookId ? taskCostOf(tasks, bookId, activity.id) : taskCostByTask(tasks, activity.id), recordedCurrency, relabels)));
}

/** The run the band speaks of: the one that runs, else the last one there is a step of. */
export function runIdOf(runnerRunId: string | null | undefined, activities: readonly AutopilotActivity[]): string | null {
  if (runnerRunId) return runnerRunId;
  let newest: AutopilotActivity | null = null;
  for (const activity of activities) if (!newest || activity.startedAt > newest.startedAt) newest = activity;
  return newest?.runId ?? null;
}

/**
 * What a run cost: its steps that are saved, and the step that runs now (`live`, recorded by this browser while its calls end). A step that is both (saved
 * while the live one is still shown) is counted once.
 */
export function runCost(bookId: string, runId: string | null, activities: readonly AutopilotActivity[], live: AutopilotActivity | null, tasks: Record<string, TaskCost>, recordedCurrency: string | undefined, relabels?: readonly CostRelabel[]): CostView {
  if (!runId) return emptyCostView();
  const steps = activities.filter((activity) => activity.runId === runId);
  const all = live && live.runId === runId && !steps.some((activity) => activity.id === live.id) ? [...steps, live] : steps;
  return stepCost(bookId, all, tasks, recordedCurrency, relabels);
}

/** What the step that runs has spent so far, when this browser runs it (its calls are recorded as they end); `null` otherwise. */
export function liveStepCost(bookId: string, live: AutopilotActivity | null, tasks: Record<string, TaskCost>, relabels?: readonly CostRelabel[]): CostView | null {
  if (!live) return null;
  const record = taskCostOf(tasks, bookId, live.id);
  return record ? attemptCost(live, record, undefined, relabels) : null;
}
