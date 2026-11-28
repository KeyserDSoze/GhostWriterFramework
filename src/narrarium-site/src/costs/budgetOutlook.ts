import type { EstimateResult } from "narrarium-engine";
import { suggestedBudget, type BudgetLine, type CapPlan } from "@/costs/budgets";
import { rateBetween } from "@/costs/money";
import type { CostExchangeRate } from "@/types/settings";

/**
 * What the budgets say of a run before it starts: the estimate of its cost against what the budget that leaves least has left. It reads the same plan the start gives the engine (`budgetPlan`, `planCap`), so that
 * what is said here is what the engine's cap then does; there is no second mechanism.
 */

/** The chapters the run goes through, to say where the money would run out: the first, how many, and whether they are written or designed. */
export interface OutlookChapters {
  first: number;
  count: number;
  kind: "written" | "designed";
}

export type OutlookKind = "fits" | "may-stop" | "stops" | "unknown";

export interface BudgetOutlook {
  kind: OutlookKind;
  /** The budget that leaves least: it is the one the engine's cap is made of. */
  line: BudgetLine;
  /** What it leaves, in the currency of the run. */
  left: number;
  /** The estimate of the run, in the currency of the run (`null`: it has no price, so it cannot be compared). */
  cost: { min: number; max: number } | null;
  currency: string;
  /** The chapter the money runs out in: with the highest estimate (`from`) and with the lowest one (`to`, absent when even the lowest fits). Absent: the run does not go through chapters, or it fits. */
  stopsAt?: { from: number; to: number | null; kind: OutlookChapters["kind"] };
  /** The limit that would cover the run, in the currency of the budget: what «Raise the budget» sets. */
  raiseTo?: number;
  /** Budgets in a currency with no rate to the run's: they cannot limit it, and are not counted here. */
  unlimited: number;
}

/** The chapter a run reaches before `left` is gone, when the whole costs `cost`: the money is spent evenly over the chapters, which is rough, and said so. */
function chapterAt(left: number, cost: number, chapters: OutlookChapters): number {
  const done = Math.floor((Math.max(0, left) / cost) * chapters.count);
  return chapters.first + Math.min(chapters.count - 1, done);
}

/**
 * The outlook of a run against the budgets, or `null` when no budget limits it (none applies, or what applies has no rate to the currency of the run). `cost` is the estimate in the currency
 * of the run; without one the outlook says only what is left (`unknown`).
 */
export function budgetOutlook(input: { plan: CapPlan; cost: { min: number; max: number } | null; currency: string; chapters?: OutlookChapters | null; rates: readonly CostExchangeRate[] }): BudgetOutlook | null {
  const { plan, cost, currency } = input;
  if (!plan.binding) return null;
  const line: BudgetLine = plan.binding;
  const leftInRun = plan.binding.leftInRun;
  const base = { line, left: leftInRun, cost, currency, unlimited: plan.unlimited.length };
  if (!cost || !(cost.max > 0)) return { ...base, kind: "unknown" };
  if (cost.max <= leftInRun) return { ...base, kind: "fits" };
  const factor = line.currency === currency ? 1 : rateBetween(line.currency, currency, input.rates)?.factor ?? 1;
  const raiseTo = suggestedBudget(line.limit, line.spent + cost.max / factor);
  const chapters = input.chapters && input.chapters.count > 0 ? input.chapters : null;
  const stops = cost.min > leftInRun;
  return {
    ...base,
    kind: stops ? "stops" : "may-stop",
    raiseTo,
    ...(chapters ? { stopsAt: { from: chapterAt(leftInRun, cost.max, chapters), to: stops ? chapterAt(leftInRun, cost.min, chapters) : null, kind: chapters.kind } } : {}),
  };
}

/**
 * What the outlook needs of an estimate of the engine: the cost and its currency (the one of the prices, else `fallback`), and the chapters it goes through: those it writes (`written`), those it designs
 * (`designed`), or none (`null`: a review of the finished book goes through chapters of its own choosing, so it is not told by their number).
 */
export function outlookOf(estimate: Pick<EstimateResult, "cost" | "chapters" | "chaptersToWrite">, fallback: string, through: OutlookChapters["kind"] | null = "written"): { cost: { min: number; max: number } | null; currency: string; chapters: OutlookChapters | null } {
  const chapters: OutlookChapters | null = through === "designed"
    ? estimate.chapters > 0 ? { first: 1, count: estimate.chapters, kind: "designed" } : null
    : through === "written" && estimate.chaptersToWrite > 0 ? { first: Math.max(1, estimate.chapters - estimate.chaptersToWrite + 1), count: estimate.chaptersToWrite, kind: "written" } : null;
  return { cost: estimate.cost ? { min: estimate.cost.min, max: estimate.cost.max } : null, currency: estimate.cost?.currency || fallback, chapters };
}
