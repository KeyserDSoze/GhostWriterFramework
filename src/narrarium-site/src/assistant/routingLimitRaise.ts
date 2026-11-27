import type { AppSettings, RoutingExecutionLimits } from "@/types/settings";

/**
 * Raising a routing limit of the AI Router where it lives (Settings > AI Router > Routing options), on the author's click, never silently. The limits are a safety for the fallbacks
 * after the first attempt of a call (the first is bounded by its model's window alone): the value is the next round number that holds what the fallbacks the limit left out needed,
 * with room, within the bounds the settings accept, and the value it replaces is remembered (`routingExecution.raisedFrom`) so that the author can put it back, here or in the
 * settings. The Copilot, Brainstorming and the autopilot's error panel offer it the same way.
 */

export type RoutingLimitKey = "maxTokenAttempts" | "maxEstimatedCost";

/** Which limit left the fallbacks of a call out, and by how much: the `budget` of the error a call ends with, in the engine and in the site alike. */
export interface RoutingBudget {
  limit: "tokens" | "cost";
  estimated: number;
  allowed: number;
}

/** What the settings accept for each limit (the same bounds as the settings page and the cloud settings). */
export const ROUTING_LIMIT_BOUNDS: Readonly<Record<RoutingLimitKey, { min: number; max: number }>> = Object.freeze({
  maxTokenAttempts: { min: 1_000, max: 2_000_000 },
  maxEstimatedCost: { min: 0.01, max: 1_000 },
});

export const limitKeyOf = (budget: Pick<RoutingBudget, "limit">): RoutingLimitKey => (budget.limit === "tokens" ? "maxTokenAttempts" : "maxEstimatedCost");

/** The budget an error carries, from either layer and also from an error that crossed a boundary (read softly): `null` when it says none, as an older engine's. */
export function routingBudgetOfError(error: unknown): RoutingBudget | null {
  const budget = error && typeof error === "object" ? (error as { budget?: unknown }).budget : undefined;
  if (!budget || typeof budget !== "object") return null;
  const { limit, estimated, allowed } = budget as Record<string, unknown>;
  if ((limit !== "tokens" && limit !== "cost") || typeof estimated !== "number" || !Number.isFinite(estimated) || typeof allowed !== "number" || !Number.isFinite(allowed)) return null;
  return { limit, estimated, allowed };
}

/** The smallest round number (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) at least `value`. */
export function roundUp(value: number): number {
  if (!(value > 0)) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = Number((step * power).toPrecision(12));
    if (candidate >= value) return candidate;
  }
  return 10 * power;
}

export interface RoutingLimitRaise {
  key: RoutingLimitKey;
  /** The limit now. */
  from: number;
  /** The limit it is raised to. */
  to: number;
  /** What the refused call needed. */
  estimated: number;
}

/** The raise that lets the fallbacks be tried, with a quarter more room; `null` when the limit already holds them or even the most the settings accept cannot. */
export function raiseFor(budget: RoutingBudget, limits: Pick<RoutingExecutionLimits, RoutingLimitKey>): RoutingLimitRaise | null {
  const key = limitKeyOf(budget);
  const { max } = ROUTING_LIMIT_BOUNDS[key];
  if (budget.estimated > max) return null;
  const to = Math.min(max, roundUp(budget.estimated * 1.25));
  const from = limits[key] ?? budget.allowed;
  return to > from ? { key, from, to, estimated: budget.estimated } : null;
}

/** The routing limits with one raised, and the value it replaces remembered (the first one of a series of raises: what the author had chosen). */
export function raisedLimits(limits: RoutingExecutionLimits, raise: Pick<RoutingLimitRaise, "key" | "to">, at = new Date()): RoutingExecutionLimits {
  const before = limits.raisedFrom?.[raise.key] ?? limits[raise.key];
  return { ...limits, [raise.key]: raise.to, raisedFrom: { ...limits.raisedFrom, [raise.key]: before, at: at.toISOString() } };
}

/** The routing limits with a raised one put back to the value it had, and forgotten as raised. */
export function restoredLimits(limits: RoutingExecutionLimits, key: RoutingLimitKey): RoutingExecutionLimits {
  const previous = limits.raisedFrom?.[key];
  if (previous === undefined) return limits;
  const { [key]: _gone, ...rest } = limits.raisedFrom ?? { at: "" };
  const others = Object.keys(rest).filter((entry) => entry !== "at");
  return { ...limits, [key]: previous, ...(others.length ? { raisedFrom: rest as RoutingExecutionLimits["raisedFrom"] } : { raisedFrom: undefined }) };
}

/** The routing limits with what a refusal raised one from forgotten: the author set it by hand. */
export function forgetRaise(limits: RoutingExecutionLimits, key: RoutingLimitKey): RoutingExecutionLimits {
  if (limits.raisedFrom?.[key] === undefined) return limits;
  const { [key]: _gone, ...rest } = limits.raisedFrom;
  const others = Object.keys(rest).filter((entry) => entry !== "at");
  return { ...limits, raisedFrom: others.length ? (rest as RoutingExecutionLimits["raisedFrom"]) : undefined };
}

/** The settings' patch that raises a limit (for `patchSettings`). */
export function raiseLimitPatch(settings: Pick<AppSettings, "routingExecution">, raise: Pick<RoutingLimitRaise, "key" | "to">): Pick<AppSettings, "routingExecution"> {
  return { routingExecution: raisedLimits(settings.routingExecution, raise) };
}
