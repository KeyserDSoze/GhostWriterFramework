import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { conversionNote, relabelNote, viewMoney, type MoneyTotals } from "@/costs/money";
import { useMoney, type Money } from "@/costs/useMoney";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

/**
 * Amounts by currency as one line, by the rule of `costs/money.ts`: in the display currency of the settings (followed live), converted where the person
 * gave a rate (marked «≈»), relabelled where a relabel names them (marked «relabelled»), and the rest beside it in its own currency. What a conversion or a
 * relabel did is said to a screen reader, or under the line with `note`.
 */
export function MoneyText({ totals, className, empty, note = false }: { totals: MoneyTotals; className?: string; empty?: string; note?: boolean }) {
  const money = useMoney();
  const view = viewMoney(totals, money);
  const said = [view.converted ? conversionNote(view.rates, money.locale) : "", relabelNote(view.relabelled)].filter(Boolean).join(" · ");
  return (
    <span className={cn("tabular-nums", className)}>
      {money.totals(totals, empty !== undefined ? { empty } : {})}
      {said && (note ? <span className="block text-xs font-normal text-muted-foreground">{said}</span> : <span className="sr-only">{` (${said})`}</span>)}
    </span>
  );
}

/** The amounts of an estimate as one line, without the «≈» of a conversion: the phrase of the estimate says «≈» once. */
function estimateAmount(money: Money, totals: MoneyTotals): string {
  return Object.values(totals).some((value) => value) ? money.totals(totals).replace(/^≈\s*/, "") : "";
}

/** «≈ €0.0011 estimated»: money that is an estimate, always said to be one, never added to the measured amounts. Nothing when there is none. */
export function EstimatedMoney({ totals, className }: { totals: MoneyTotals; className?: string }) {
  const { t } = useTranslation();
  const money = useMoney();
  const amount = estimateAmount(money, totals);
  if (!amount) return null;
  return <span className={cn("tabular-nums", className)}>{t("costs.money.estimated", { amount })}</span>;
}

/**
 * What the calls whose tokens were not reported are estimated to have used and cost, in one phrase («≈ 1,320 tokens and ≈ $0.0041, estimated»), never added
 * to what was measured; `tokens` is the count already written in the language of the page, `null` when there is none. Empty when nothing is estimated.
 */
export function estimatePhrase(t: TFunction, money: Money, tokens: string | null, totals: MoneyTotals): string {
  const amount = estimateAmount(money, totals);
  if (tokens && amount) return t("costs.estimate.withCost", { tokens, amount });
  if (tokens) return t("costs.figures.estimatedTokens", { value: tokens });
  return amount ? t("costs.money.estimated", { amount }) : "";
}
