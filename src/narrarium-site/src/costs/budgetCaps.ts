import type { BudgetPeriod, CapPlan } from "@/costs/budgets";

/**
 * What the budgets did to the money cap of a book's autopilot (`options.budgetLimit`), kept on this device so that the cap the person typed (`own`) is not lost when a cap
 * derived from the budgets takes its place, and so that a stop at it can say it was the budget's. The cap the engine holds is one number: the budgets only ever lower it to
 * what they leave, and give the person's own cap back when they no longer apply.
 */
export interface AppliedCap {
  /** The cap the budgets gave the engine. */
  applied: number;
  /** The cap the person had set before (0: none), given back when the budgets stop limiting the book. */
  own: number;
  /** The budget that left least when it was applied. */
  binding: { scope: "global" | "book"; bookId: string; period: BudgetPeriod; currency: string; limit: number };
}

const KEY = "narrarium-budget-caps-v1";
const SAME = 1e-6;

const same = (left: number, right: number): boolean => Math.abs(left - right) <= SAME;

function readAll(): Record<string, AppliedCap> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, AppliedCap>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, AppliedCap>): void {
  try {
    if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the budgets still apply; the person's own cap is then taken from what the book holds.
  }
}

/** What the budgets last did to the cap of a book on this device, or `null`. */
export function appliedCapOf(bookId: string): AppliedCap | null {
  const entry = readAll()[bookId];
  return entry && typeof entry.applied === "number" && typeof entry.own === "number" ? entry : null;
}

export function rememberAppliedCap(bookId: string, applied: AppliedCap | null): void {
  const all = readAll();
  if (applied) all[bookId] = applied;
  else delete all[bookId];
  writeAll(all);
}

/** Whether a cap the engine stopped at is the one the budgets gave it (and not one the person set). */
export function isAppliedCap(bookId: string, cap: number): AppliedCap | null {
  const applied = appliedCapOf(bookId);
  return applied && same(applied.applied, cap) ? applied : null;
}

export interface CapDecision {
  /** The cap to start the run with, `undefined` to leave the options as they are. */
  budgetLimit: number | undefined;
  /** What to remember: the cap the budgets gave, or `null` when they give none. */
  applied: AppliedCap | null;
}

/**
 * The cap a start sends. `current` is the cap the book holds; `explicit` the one the start itself carries (a person's choice, unless it is the very cap the budgets gave, which a
 * form that shows it sends back); `plan` what the budgets leave; `ignore` the person's choice to go on whatever the budgets say, for this start.
 * The run stops at the smaller of the person's own cap (0: none) and what the budgets leave; when the budgets no longer limit the book, its own cap is given back.
 */
export function decideCap(input: { marker: AppliedCap | null; current: number; explicit?: number; plan: CapPlan | null; ignore: boolean }): CapDecision {
  const { marker, current, explicit, plan, ignore } = input;
  const echo = Boolean(marker && same(current, marker.applied));
  const given = explicit !== undefined && !(marker && same(explicit, marker.applied)) ? explicit : undefined;
  const own = given ?? (echo && marker ? marker.own : current);
  // The budgets do not limit the book: it holds its own cap, which is sent only when what the book would hold is not it (the cap the budgets gave, still there).
  const restore = (): CapDecision => ({ budgetLimit: own !== (explicit ?? current) ? own : undefined, applied: null });
  if (ignore || !plan || plan.cap === null || !plan.binding) return restore();
  if (own > 0 && own <= plan.cap) return restore();
  const { scope, bookId, period, currency, limit } = plan.binding;
  return { budgetLimit: plan.cap, applied: { applied: plan.cap, own, binding: { scope, bookId, period, currency, limit } } };
}
