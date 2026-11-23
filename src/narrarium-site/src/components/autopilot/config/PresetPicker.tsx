import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { AUTOPILOT_PRESETS, type AutopilotPresetId } from "narrarium-engine";
import { formatWhole } from "@/autopilot/runEstimateFormat";
import { cn } from "@/lib/utils";

export interface PresetPickerProps {
  /** The size the numbers of the form are, or `null` when they are the author's own. */
  value: AutopilotPresetId | null;
  /** The numbers are locked: the autopilot runs. */
  disabled: boolean;
  onChoose: (id: AutopilotPresetId) => void;
}

/**
 * The sizes a book can start from, at the head of the form: a group of native radio buttons (Tab enters it once and the arrow keys move between the sizes), each with its name, what
 * it is in numbers and who it is for. Choosing one fills in the numbers of the form and nothing else; the choice follows every edit by itself (the engine says whether the numbers
 * still are the ones of a size), and says «Custom» in words when they are not.
 */
export function PresetPicker({ value, disabled, onChoose }: PresetPickerProps) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const hintId = `${base}-hint`;
  const customId = `${base}-custom`;
  return (
    <fieldset className="space-y-2" aria-describedby={value === null ? `${hintId} ${customId}` : hintId}>
      <legend className="text-sm font-medium">{t("autopilot.presets.legend")}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {AUTOPILOT_PRESETS.map((preset) => {
          const selected = value === preset.id;
          const nameId = `${base}-${preset.id}-name`;
          const factsId = `${base}-${preset.id}-facts`;
          const aboutId = `${base}-${preset.id}-about`;
          const words = preset.brief.targetChapters * preset.brief.scenesPerChapter * preset.brief.wordsPerScene;
          return (
            <label
              key={preset.id}
              className={cn(
                "flex min-h-11 gap-3 rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-ring",
                disabled ? "cursor-not-allowed" : "cursor-pointer",
                selected ? "border-primary/60 bg-primary/5" : !disabled && "hover:bg-muted/40",
              )}
            >
              <input
                type="radio"
                name={`${base}-preset`}
                value={preset.id}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={selected}
                disabled={disabled}
                aria-labelledby={nameId}
                aria-describedby={`${factsId} ${aboutId}`}
                onChange={() => onChoose(preset.id)}
              />
              <span className="min-w-0 space-y-1">
                <span id={nameId} className="block text-sm font-medium">{t(`autopilot.presets.${preset.id}.name`)}</span>
                <span id={factsId} className="block text-xs text-muted-foreground">
                  {t("autopilot.presets.facts", { chapters: preset.brief.targetChapters, scenes: preset.brief.scenesPerChapter, words: formatWhole(words, locale) })}
                </span>
                <span id={aboutId} className="block text-xs text-muted-foreground">{t(`autopilot.presets.${preset.id}.about`)}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">{t("autopilot.presets.hint")}</p>
      {value === null && (
        <p id={customId} className="flex items-center gap-1.5 text-xs font-medium">
          <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("autopilot.presets.custom")}
        </p>
      )}
    </fieldset>
  );
}
