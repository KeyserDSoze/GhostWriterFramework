import { useId } from "react";
import { useTranslation } from "react-i18next";
import { normalizeReasoningParameter, suggestedReasoningParameter } from "narrarium-engine";
import "@/i18n/aiRouter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REASONING_PARAMETERS, type ChatModel, type ReasoningParameter } from "@/types/settings";

/**
 * The «Thinking parameter» of a model, in its row of the integration card: how the level of thinking reaches it (the OpenAI field, the argument of the chat template that Muse Glimmer takes, or no
 * level). A model that has not said gets the default, as it always did, and the select shows it. What is stored is exactly what the author chooses: the default too, so that a model that
 * has said has said, and the suggestion does not come back for it.
 *
 * For a name that the engine's `suggestedReasoningParameter` ties to the chat-template argument, and only while the model has not said, a note offers it with a button. It is never applied by
 * itself, and it is not announced: the select is described by it, so a screen reader says it when the field is reached. `hintId` is the paragraph of the card that explains the setting once for
 * all its models.
 */
export function ReasoningParameterField({ model, hintId, onChange }: { model: ChatModel; hintId: string; onChange: (parameter: ReasoningParameter) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const selectId = `${id}-select`;
  const suggestionId = `${id}-suggestion`;
  // As the engine reads it: a value it would not use is no value.
  const stored = normalizeReasoningParameter(model.reasoningParameter);
  const suggestion = stored === undefined ? suggestedReasoningParameter(model.name, model.underlyingModel) : undefined;

  return (
    <div className="grid gap-1 sm:col-span-3">
      <Label htmlFor={selectId} className="text-xs">{t("settings.thinkingParameter")}</Label>
      <Select value={stored ?? "reasoning_effort"} onValueChange={(next) => onChange(next as ReasoningParameter)}>
        <SelectTrigger id={selectId} aria-describedby={suggestion ? `${hintId} ${suggestionId}` : hintId} className="h-auto min-h-8 py-1.5 text-left text-sm sm:max-w-md [&>span]:line-clamp-none [&>span]:break-all">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REASONING_PARAMETERS.map((parameter) => (
            <SelectItem key={parameter} value={parameter}>{parameter === "reasoning_effort" ? t("settings.thinkingParameterDefault", { value: parameter }) : parameter}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {suggestion && (
        <div id={suggestionId} data-thinking-suggestion className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-layer bg-muted/30 px-3 py-2 text-xs">
          <p className="min-w-0 flex-1 basis-60">{t("settings.thinkingParameterSuggestion", { value: suggestion })}</p>
          <Button type="button" size="sm" variant="outline" aria-label={t("settings.thinkingParameterUseFor", { name: model.name || model.underlyingModel || "" })} onClick={() => onChange(suggestion)}>
            {t("settings.thinkingParameterUse")}
          </Button>
        </div>
      )}
    </div>
  );
}
