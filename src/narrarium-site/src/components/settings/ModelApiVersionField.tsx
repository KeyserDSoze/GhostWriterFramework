import { useId } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_AZURE_API_VERSION, effectiveApiVersion } from "narrarium-engine";
import "@/i18n/aiRouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { AIIntegration, ChatModel } from "@/types/settings";

/** Whether what was typed can be an API version (`2025-01-01-preview`, `v1`): empty is fine (it inherits), a word with spaces or signs of an address is not. */
export function apiVersionLooksValid(value: string | undefined): boolean {
  const text = (value ?? "").trim();
  return !text || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
}

/** The version a model with no version of its own takes: its integration's, else the engine's default. The one rule is the engine's (`effectiveApiVersion`). */
export function inheritedApiVersion(integration: Pick<AIIntegration, "apiVersion">): string {
  return effectiveApiVersion({ provider: "azure_openai", endpoint: undefined, apiVersion: integration.apiVersion }, null) ?? DEFAULT_AZURE_API_VERSION;
}

/**
 * The «API version» of a model, in its row of the integration card (Azure OpenAI): empty, it takes the version of the integration, which the placeholder says; written, it is the version this
 * model's requests carry, and a badge says that the model has its own. What is stored is the text with its spaces taken off, and nothing when it is empty. The help is read with the field, and a
 * value that cannot be a version is said in the field itself (`aria-invalid`), not by colour. The label says the same word as the integration's field, so a screen reader is told whose it is: the name
 * of the model follows it, hidden from the eye (the card shows it above). `ignored`: the model has an address of its own, so no version is used for it, and the field says so.
 */
export function ModelApiVersionField({ model, inherited, hintId, ignored = false, onChange }: { model: ChatModel; inherited: string; hintId: string; ignored?: boolean; onChange: (apiVersion: string | undefined) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const own = (model.apiVersion ?? "").trim();
  const valid = apiVersionLooksValid(model.apiVersion);
  return (
    <div className="grid gap-1" data-model-api-version={own ? "own" : "inherited"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Label htmlFor={id} className="text-xs">{t("settings.modelApiVersion")}{model.name.trim() && <>{" "}<span className="sr-only">— {model.name}</span></>}</Label>
        {own && <span data-api-version-badge className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-foreground">{t("settings.modelApiVersionOwn")}</span>}
      </div>
      <Input
        id={id}
        value={model.apiVersion ?? ""}
        onChange={(event) => onChange(event.target.value.trim() || undefined)}
        placeholder={t("settings.modelApiVersionInherit", { value: inherited })}
        aria-describedby={cn(hintId, !valid && `${id}-invalid`, ignored && `${id}-ignored`)}
        aria-invalid={!valid || undefined}
        className="h-8 text-sm"
      />
      {!valid && <p id={`${id}-invalid`} role="alert" className="text-xs text-destructive">{t("settings.modelApiVersionInvalid")}</p>}
      {ignored && <p id={`${id}-ignored`} data-api-version-ignored className="text-xs text-muted-foreground">{t("settings.modelApiVersionIgnored")}</p>}
    </div>
  );
}
