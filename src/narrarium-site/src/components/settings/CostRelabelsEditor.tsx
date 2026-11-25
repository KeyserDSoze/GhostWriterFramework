import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/autopilot/format";
import { CURRENCY_CODE, normalizeRelabels } from "@/costs/rates";
import type { CostRelabel } from "@/types/settings";
import "@/i18n/costs";

/**
 * The relabels of the settings (`costRelabels`): «the amounts recorded as USD until today were really EUR», for costs priced in a currency the setting named by
 * mistake (the prices were in euro, the setting said USD). Only how they are shown changes, marked «relabelled» wherever they appear; removing one shows them
 * as recorded again. One for each recorded currency; it covers what was recorded up to the moment it is set.
 */
export function CostRelabelsEditor({ currency, relabels, onChange }: { currency: string; relabels: CostRelabel[] | undefined; onChange: (relabels: CostRelabel[] | undefined) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [from, setFrom] = useState("");
  const list = normalizeRelabels(relabels);
  const code = from.trim().toUpperCase();
  const valid = CURRENCY_CODE.test(code) && code !== currency;
  const add = () => {
    if (!valid) return;
    onChange([...list.filter((entry) => entry.from !== code), { from: code, to: currency, until: new Date().toISOString() }]);
    setFrom("");
  };
  const remove = (entry: CostRelabel) => {
    const next = list.filter((other) => other !== entry);
    onChange(next.length ? next : undefined);
  };
  return (
    <fieldset className="grid gap-2 sm:max-w-xl" aria-describedby={`${id}-hint`}>
      <legend className="text-sm font-medium">{t("settings.costRelabels.title")}</legend>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("settings.costRelabels.hint")}</p>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.costRelabels.empty")}</p>
      ) : (
        <ul className="space-y-1" aria-label={t("settings.costRelabels.title")}>
          {list.map((entry) => (
            <li key={entry.from} data-cost-relabel={entry.from} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1 text-sm">
              <span>{t("settings.costRelabels.row", { from: entry.from, to: entry.to, date: formatDate(entry.until) })}</span>
              <Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0 sm:min-h-8" onClick={() => remove(entry)}>
                <Undo2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("settings.costRelabels.remove")}{" "}
                <span className="sr-only">— {t("settings.costRelabels.removeWhich", { from: entry.from })}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-from`} className="text-xs">{t("settings.costRelabels.from")}</Label>
          <Input id={`${id}-from`} value={from} onChange={(event) => setFrom(event.target.value)} placeholder="USD" maxLength={3} autoCapitalize="characters" className="h-9 w-24 text-sm uppercase" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
        </div>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={!valid} onClick={add}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{t("settings.costRelabels.add", { currency })}</Button>
      </div>
    </fieldset>
  );
}
