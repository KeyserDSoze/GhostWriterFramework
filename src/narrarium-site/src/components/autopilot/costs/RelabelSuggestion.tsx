import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { saveSettingsNow } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import "@/i18n/costs";

const DISMISSED_KEY = "narrarium-relabel-suggestion-v1";

function dismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Said once, in the cost line of a book whose autopilot recorded its costs in another currency than the one of the settings (the prices were typed in euro while
 * the setting still said USD): «were they EUR? show them as EUR». Accepted, it sets the relabel of Settings › Costs (shown as «relabelled» wherever the amounts
 * are, removable there); declined, it is not said again for that pair on this device. Nothing is said when a rate or a relabel already covers the currency.
 */
export function RelabelSuggestion({ recorded, display }: { recorded: string; display: string }) {
  const { t } = useTranslation();
  const relabels = useSettingsStore((state) => state.settings.costRelabels);
  const rates = useSettingsStore((state) => state.settings.costRates);
  const [closed, setClosed] = useState(() => dismissed().includes(`${recorded}>${display}`));
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const covered = (relabels ?? []).some((entry) => entry.from === recorded) || (rates ?? []).some((rate) => (rate.from === recorded && rate.to === display) || (rate.from === display && rate.to === recorded));
  if (closed || covered || !recorded || recorded === display) return null;

  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissed(), `${recorded}>${display}`])]));
    } catch {
      // Said again on the next page of this device: nothing else changes.
    }
    setClosed(true);
  };
  const accept = async () => {
    setState("saving");
    try {
      const current = useSettingsStore.getState().settings.costRelabels ?? [];
      useSettingsStore.getState().patchSettings({ costRelabels: [...current.filter((entry) => entry.from !== recorded), { from: recorded, to: display, until: new Date().toISOString() }] });
      await saveSettingsNow();
      close();
    } catch {
      setState("failed");
    }
  };

  return (
    <div data-relabel-suggestion role="note" className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed px-3 py-2 text-xs">
      <Tags className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-56">{t("costs.relabel.suggest", { recorded, display })}</span>
      <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={state === "saving"} onClick={() => void accept()}>{t("costs.relabel.accept", { recorded, display })}</Button>
      <Button type="button" size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={close}>{t("costs.relabel.decline", { recorded })}</Button>
      {state === "failed" && <span role="status" className="basis-full text-destructive">{t("costs.relabel.failed")}</span>}
    </div>
  );
}
