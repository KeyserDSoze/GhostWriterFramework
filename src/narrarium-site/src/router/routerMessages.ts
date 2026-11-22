import type { BulkOutcome, SkipReason, SwapOutcome } from "@/router/routerTableModel";

/** The part of i18next's `t` these messages need. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The order the reasons are told in, and the key each one has. */
const REASONS: Array<[SkipReason, string]> = [
  ["no-target", "noTarget"],
  ["no-primary", "noPrimary"],
  ["gap", "gap"],
  ["no-model", "noModel"],
  ["invalid-model", "invalidModel"],
  ["limit", "limit"],
];

/** "Swapped 14 rows between Primary and Fallback 1.", and how many rows had to stay as they were. */
export function swapMessage(t: Translate, outcome: SwapOutcome, a: string, b: string): string {
  if (outcome.swapped.length === 0) return t(outcome.skipped.length > 0 ? "routing.result.nothingSwapped" : "routing.result.nothingChanged", { a, b });
  const parts = [t("routing.result.swapped", { count: outcome.swapped.length, a, b })];
  if (outcome.skipped.length > 0) parts.push(t("routing.result.swapSkipped", { count: outcome.skipped.length }));
  return parts.join(" ");
}

/** What a group edit did: how many rows changed, got a target, took the first valid model, were already so, or were skipped and why. */
export function applyMessage(t: Translate, outcome: BulkOutcome): string {
  const parts = [outcome.changed.length > 0 ? t("routing.result.applied", { count: outcome.changed.length }) : t("routing.result.nothingChanged")];
  if (outcome.created.length > 0) parts.push(t("routing.result.created", { count: outcome.created.length }));
  if (outcome.adjusted.length > 0) parts.push(t("routing.result.adjusted", { count: outcome.adjusted.length }));
  if (outcome.unchanged.length > 0) parts.push(t("routing.result.unchanged", { count: outcome.unchanged.length }));
  const reasons = REASONS
    .map(([reason, key]) => ({ key, count: outcome.skipped.filter((entry) => entry.reason === reason).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => t(`routing.result.reason.${entry.key}`, { count: entry.count }));
  if (reasons.length > 0) parts.push(t("routing.result.skipped", { reasons: reasons.join("; ") }));
  return parts.join(" ");
}

export function deleteMessage(t: Translate, tab: string, lost: number): string {
  return t("routing.result.deleted", { tab, count: lost });
}
