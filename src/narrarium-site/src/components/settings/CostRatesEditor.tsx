import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENCY_CODE, normalizeRates } from "@/costs/rates";
import type { CostExchangeRate } from "@/types/settings";
import "@/i18n/costs";

/**
 * The exchange rates of the settings (`costRates`), for the display of costs only: «1 USD = 0.92 EUR» shows the costs recorded in USD in EUR, marked «≈».
 * A rate is given towards the currency of the settings; one already given for a pair (either way round) is replaced by the new one.
 */
export function CostRatesEditor({ currency, rates, onChange }: { currency: string; rates: CostExchangeRate[] | undefined; onChange: (rates: CostExchangeRate[] | undefined) => void }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [from, setFrom] = useState("");
  const [rate, setRate] = useState("");
  const list = normalizeRates(rates);
  const code = from.trim().toUpperCase();
  const value = Number(rate.replace(",", "."));
  const valid = CURRENCY_CODE.test(code) && code !== currency && Number.isFinite(value) && value > 0;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, { maximumSignificantDigits: 6 });
  const add = () => {
    if (!valid) return;
    const others = list.filter((entry) => !((entry.from === code && entry.to === currency) || (entry.from === currency && entry.to === code)));
    onChange([...others, { from: code, to: currency, rate: value }]);
    setFrom("");
    setRate("");
  };
  const remove = (entry: CostExchangeRate) => {
    const next = list.filter((other) => other !== entry);
    onChange(next.length ? next : undefined);
  };
  return (
    <fieldset className="grid gap-2 sm:max-w-md" aria-describedby={`${id}-hint`}>
      <legend className="text-sm font-medium">{t("settings.costRates.title")}</legend>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("settings.costRates.hint", { currency })}</p>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.costRates.empty")}</p>
      ) : (
        <ul className="space-y-1" aria-label={t("settings.costRates.title")}>
          {list.map((entry) => (
            <li key={`${entry.from}>${entry.to}`} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1 text-sm">
              <span className="tabular-nums">{t("settings.costRates.row", { from: entry.from, rate: number.format(entry.rate), to: entry.to })}</span>
              <Button type="button" variant="ghost" size="icon" className="h-11 w-11 sm:h-8 sm:w-8" aria-label={t("settings.costRates.remove", { from: entry.from === currency ? entry.to : entry.from })} onClick={() => remove(entry)}>
                <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-from`} className="text-xs">{t("settings.costRates.from")}</Label>
          <Input id={`${id}-from`} value={from} onChange={(event) => setFrom(event.target.value)} placeholder="USD" maxLength={3} autoCapitalize="characters" className="h-9 w-24 text-sm uppercase" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-rate`} className="text-xs">{t("settings.costRates.rateLabel", { currency, from: code || "…" })}</Label>
          <Input id={`${id}-rate`} value={rate} onChange={(event) => setRate(event.target.value)} inputMode="decimal" placeholder="0.92" className="h-9 w-32 text-sm" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        </div>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={!valid} onClick={add}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("settings.costRates.add")}</Button>
      </div>
    </fieldset>
  );
}
