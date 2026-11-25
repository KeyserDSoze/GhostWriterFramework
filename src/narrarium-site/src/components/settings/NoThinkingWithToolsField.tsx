import { useId } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/aiRouter";
import { Label } from "@/components/ui/label";
import type { ChatModel } from "@/types/settings";

/**
 * «Do not use thinking when tools are used», in the row of a model of an integration: some models refuse a thinking level when the request carries function tools, and a model with this on is sent
 * its requests with tools without a level (its requests without tools keep theirs). The author sets it, and the page sets it when the provider says so (`model-learned`): the row shows it either way,
 * and the author can turn it off. What is stored is `true` when it is ticked by hand, `"none"` when the engine learned that the model takes `none` and no request without a level (the box is ticked for either), and
 * nothing when it is off. `hintId` is the paragraph of the card that explains the setting once for all its
 * models. The label names the model for a screen reader, hidden from the eye (the row shows it above).
 */
export function NoThinkingWithToolsField({ model, hintId, onChange }: { model: ChatModel; hintId: string; onChange: (value: true | undefined) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const on = model.noThinkingWithTools === true || model.noThinkingWithTools === "none";
  return (
    <div data-no-thinking-with-tools={on ? "on" : "off"} className="flex items-start gap-2 rounded-md border px-3 py-2 sm:col-span-3">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={on} aria-describedby={hintId} onChange={(event) => onChange(event.target.checked ? true : undefined)} />
      <Label htmlFor={id} className="text-xs">
        {t("settings.noThinkingWithTools")}
        {model.name.trim() && <>{" "}<span className="sr-only">— {model.name}</span></>}
      </Label>
    </div>
  );
}
