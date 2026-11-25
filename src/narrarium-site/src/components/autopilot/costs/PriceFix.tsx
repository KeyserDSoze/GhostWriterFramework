import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { integrationLink, mediaPriceAnchor, modelPriceAnchor, priceLink } from "@/components/settings/endpoint/anchor";
import { isMediaCapability } from "@/costs/legacyCosts";
import { saveSettingsNow } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { AIPricing } from "@/types/settings";
import "@/i18n/costs";

type Prices = Pick<AIPricing, "inputPerMTok" | "cachedPerMTok" | "outputPerMTok">;

function number(text: string): number | undefined {
  const value = Number(text.replace(",", ".").trim());
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The fix of «calls without a price», where the calls are told: the prices of the model, typed here in the currency of the settings and saved at once (the next
 * call is priced with them; the calls already made keep having none), and the way to the prices in AI Integrations. A model of the voice or the images, or one
 * the settings no longer have, has the way only.
 */
export function PriceFix({ integrationId, model, capability }: { integrationId: string; model: string; capability?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const unit = useSettingsStore((state) => (state.settings.costCurrency || "USD").toUpperCase());
  const integrations = useSettingsStore((state) => state.settings.aiIntegrations);
  const integration = integrations.find((entry) => entry.id === integrationId);
  const chat = integration?.chatModels?.find((entry) => entry.name === model);
  const media = capability !== undefined && isMediaCapability(capability);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ input: "", cached: "", output: "" });
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  // The prices of the model; of the voice and the images for a call of theirs; the card of the integration for a model it no longer lists; the page when the integration is gone.
  const link = !integration ? "/app/settings/ai-integrations" : media ? priceLink(mediaPriceAnchor(integration.id)) : chat ? priceLink(modelPriceAnchor(integration.id, chat.id)) : integrationLink(integration.id);
  const where = integration ? `${model} · ${integration.name}` : model;

  async function save() {
    if (!integration || !chat) return;
    const prices: Prices = { inputPerMTok: number(values.input), cachedPerMTok: number(values.cached), outputPerMTok: number(values.output) };
    if (prices.inputPerMTok === undefined && prices.outputPerMTok === undefined) return;
    setState("saving");
    try {
      const next = useSettingsStore.getState().settings.aiIntegrations.map((entry) => entry.id !== integration.id ? entry : {
        ...entry,
        chatModels: (entry.chatModels ?? []).map((candidate) => candidate.id !== chat.id ? candidate : { ...candidate, pricing: { ...candidate.pricing, ...Object.fromEntries(Object.entries(prices).filter(([, value]) => value !== undefined)) } }),
      });
      useSettingsStore.getState().patchSettings({ aiIntegrations: next });
      await saveSettingsNow();
      setState("saved");
      setOpen(false);
    } catch {
      setState("failed");
    }
  }

  const field = (key: keyof typeof values, label: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`${id}-${key}`} className="text-xs">{label}</Label>
      <Input id={`${id}-${key}`} inputMode="decimal" value={values[key]} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} placeholder="0" className="h-9 w-28 text-sm" />
    </div>
  );

  return (
    <div data-price-fix className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {chat && !media && (
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {t("costs.fix.setPrice")}{" "}<span className="sr-only">— {where}</span>
          </Button>
        )}
        <Link to={link} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 sm:min-h-6">{t("costs.fix.openPrices")}{" "}<span className="sr-only">— {where}</span></Link>
        {state === "saved" && <span role="status" className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><Check className="h-3.5 w-3.5" aria-hidden="true" />{t("costs.fix.saved", { model })}</span>}
        {state === "failed" && <span role="status" className="text-destructive">{t("costs.fix.failed")}</span>}
      </div>
      {open && chat && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={t("costs.fix.form", { model: where })}>
          {field("input", t("costs.priceInput", { unit }))}
          {field("cached", t("costs.priceCached", { unit }))}
          {field("output", t("costs.priceOutput", { unit }))}
          <Button type="submit" size="sm" className="min-h-11 sm:min-h-9" disabled={state === "saving" || (number(values.input) === undefined && number(values.output) === undefined)}>
            {state === "saving" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{t("costs.fix.save")}
          </Button>
          <p className="basis-full text-xs text-muted-foreground">{t("costs.fix.hint", { currency: unit })}</p>
        </form>
      )}
    </div>
  );
}
