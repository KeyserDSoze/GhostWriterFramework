import { useId } from "react";
import { useTranslation } from "react-i18next";
import { normalizePromptCaching } from "narrarium-engine";
import "@/i18n/aiRouter";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ChatModel } from "@/types/settings";

type Choice = "unknown" | "supported" | "unsupported" | "learned";

/**
 * «Supports prompt caching», in the row of a model of an integration: whether the model's provider caches the start of the prompts it is sent, which makes the input it serves from the cache cheaper (the price
 * next to it). `unknown` (nothing said) is what every model starts as: Narrarium sends the hint that helps a provider find its cache where it is safe to, and learns from the responses. `supported` and
 * `unsupported` are the author's word (`unsupported`: no hint is sent and no saving is counted on). `learned` is not a choice: it is what the row shows for a model that has said nothing when the provider
 * served tokens from its cache in a call of the ledger (`cached`: the page never changes the settings for it), or when a configuration says it (`promptCaching: learned`); choosing a value says it instead.
 * `hintId` is the paragraph of the row that explains the setting; the label names the model for a screen reader.
 */
export function PromptCachingField({ model, cached = false, hintId, onChange }: { model: ChatModel; cached?: boolean; hintId: string; onChange: (value: "supported" | "unsupported" | undefined) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const said = normalizePromptCaching(model.promptCaching);
  const stored = said ?? (cached ? "learned" : undefined);
  const value: Choice = stored ?? "unknown";
  return (
    <div data-prompt-caching={value} className="grid gap-1">
      <Label htmlFor={`${id}-select`} className="text-xs">
        {t("settings.promptCaching")}
        {model.name.trim() && <>{" "}<span className="sr-only">— {model.name}</span></>}
      </Label>
      <Select value={value} onValueChange={(next) => onChange(next === "supported" || next === "unsupported" ? next : undefined)}>
        <SelectTrigger id={`${id}-select`} aria-describedby={hintId} className="h-8 text-left text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unknown">{t("settings.promptCachingUnknown")}</SelectItem>
          <SelectItem value="supported">{t("settings.promptCachingSupported")}</SelectItem>
          <SelectItem value="unsupported">{t("settings.promptCachingUnsupported")}</SelectItem>
          {stored === "learned" && <SelectItem value="learned">{t("settings.promptCachingLearned")}</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}
