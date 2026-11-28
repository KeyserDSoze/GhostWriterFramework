import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CONTEXT_THRESHOLD_MAX, CONTEXT_THRESHOLD_MIN, DEFAULT_CONTEXT_COMPACTION, type AppSettings } from "@/types/settings";
// Its words travel with the Copilot's own texts.
import "@/i18n/pageCopilot";

const THRESHOLDS = Array.from({ length: (CONTEXT_THRESHOLD_MAX - CONTEXT_THRESHOLD_MIN) / 5 + 1 }, (_, index) => CONTEXT_THRESHOLD_MIN + index * 5);

/** The compaction of the context of the chats (#122): on or off, and at which share of the model's window. */
export function ContextCompactionSettingsBody({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  const { t } = useTranslation();
  const value = settings.contextCompaction ?? DEFAULT_CONTEXT_COMPACTION;
  const autoId = useId();
  const autoHintId = useId();
  const thresholdId = useId();
  const thresholdHintId = useId();
  const thresholds = THRESHOLDS.includes(value.threshold) ? THRESHOLDS : [...THRESHOLDS, value.threshold].sort((left, right) => left - right);
  return (
    <div className="space-y-5" data-context-compaction-settings="">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={autoId}>{t("pageCopilot.context.settings.auto")}</Label>
          <p id={autoHintId} className="text-sm text-muted-foreground">{t("pageCopilot.context.settings.autoHint")}</p>
        </div>
        <Switch id={autoId} aria-describedby={autoHintId} checked={value.auto} onCheckedChange={(auto) => patchSettings({ contextCompaction: { ...value, auto } })} />
      </div>
      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor={thresholdId}>{t("pageCopilot.context.settings.threshold")}</Label>
        <Select value={String(value.threshold)} onValueChange={(next) => patchSettings({ contextCompaction: { ...value, threshold: Number(next) } })}>
          <SelectTrigger id={thresholdId} aria-describedby={thresholdHintId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {thresholds.map((percent) => <SelectItem key={percent} value={String(percent)}>{t("pageCopilot.context.settings.thresholdValue", { percent })}</SelectItem>)}
          </SelectContent>
        </Select>
        <p id={thresholdHintId} className="text-sm text-muted-foreground">{t("pageCopilot.context.settings.thresholdHint")}</p>
      </div>
      {!value.auto && <p className="text-sm text-muted-foreground" role="status">{t("pageCopilot.context.settings.manual")}</p>}
    </div>
  );
}
