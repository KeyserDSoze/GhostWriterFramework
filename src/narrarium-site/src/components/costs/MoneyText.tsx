import { useTranslation } from "react-i18next";
import { conversionNote, viewMoney, type MoneyTotals } from "@/costs/money";
import { useMoney } from "@/costs/useMoney";
import { cn } from "@/lib/utils";
import "@/i18n/costs";

/**
 * Amounts by currency as one line, by the rule of `costs/money.ts`: in the display currency of the settings (followed live), converted where the person
 * gave a rate (marked «≈», and said «converted at …» to a screen reader, or under the line with `note`), and the rest beside it in its own currency.
 */
export function MoneyText({ totals, className, empty, note = false }: { totals: MoneyTotals; className?: string; empty?: string; note?: boolean }) {
  const money = useMoney();
  const view = viewMoney(totals, money);
  const said = view.converted ? conversionNote(view.rates, money.locale) : "";
  return (
    <span className={cn("tabular-nums", className)}>
      {money.totals(totals, empty !== undefined ? { empty } : {})}
      {said && (note ? <span className="block text-xs font-normal text-muted-foreground">{said}</span> : <span className="sr-only">{` (${said})`}</span>)}
    </span>
  );
}

/** «≈ €0.0011 estimated»: money that is an estimate, always said to be one, never added to the measured amounts. Nothing when there is none. */
export function EstimatedMoney({ totals, className }: { totals: MoneyTotals; className?: string }) {
  const { t } = useTranslation();
  const money = useMoney();
  if (!Object.values(totals).some((value) => value)) return null;
  return <span className={cn("tabular-nums", className)}>{t("costs.money.estimated", { amount: money.totals(totals) })}</span>;
}
