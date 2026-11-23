import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AUTOPILOT_PRESETS, autopilotPresetSkeleton, type AutopilotPresetId } from "narrarium-engine";
import { formatWhole } from "@/autopilot/runEstimateFormat";
import { cn } from "@/lib/utils";

export interface StartSizePickerProps {
  /** The size chosen, or `null` for none: the Scaletta starts empty. */
  value: AutopilotPresetId | null;
  onChange: (id: AutopilotPresetId | null) => void;
}

/**
 * The sizes a new book can start from («Parti da una misura»), at the creation of the book only: a group of native radio buttons (Tab enters it once and
 * the arrow keys move between the sizes), each with its name, what it is in numbers and who it is for. Choosing one fills the new book's words per scene and
 * its review settings, and creates one empty chapter entry for each chapter of the size; none creates nothing. A book that exists has no such choice.
 */
export function StartSizePicker({ value, onChange }: StartSizePickerProps) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const locale = i18n.resolvedLanguage || i18n.language || "en";
  const hintId = `${base}-hint`;
  const options: Array<{ id: AutopilotPresetId | null; name: string; facts?: string; about?: string }> = [
    { id: null, name: t("autopilot.presets.none") },
    ...AUTOPILOT_PRESETS.map((preset) => ({
      id: preset.id,
      name: t(`autopilot.presets.${preset.id}.name`),
      facts: t("autopilot.presets.facts", { chapters: preset.chapters, words: formatWhole(autopilotPresetSkeleton(preset.id)!.wordsPerScene, locale) }),
      about: t(`autopilot.presets.${preset.id}.about`),
    })),
  ];
  return (
    <fieldset className="space-y-2" aria-describedby={hintId}>
      <legend className="text-sm font-medium">{t("autopilot.presets.legend")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const selected = value === option.id;
          const nameId = `${base}-${option.id ?? "none"}-name`;
          const described = option.about ? `${base}-${option.id}-facts ${base}-${option.id}-about` : undefined;
          return (
            <label key={option.id ?? "none"} className={cn("flex min-h-11 cursor-pointer gap-3 rounded-lg border p-3 transition focus-within:ring-2 focus-within:ring-ring", selected ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
              <input
                type="radio"
                name={`${base}-size`}
                value={option.id ?? ""}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={selected}
                aria-labelledby={nameId}
                aria-describedby={described}
                onChange={() => onChange(option.id)}
              />
              <span className="min-w-0 space-y-1">
                <span id={nameId} className="block text-sm font-medium">{option.name}</span>
                {option.facts && <span id={`${base}-${option.id}-facts`} className="block text-xs text-muted-foreground">{option.facts}</span>}
                {option.about && <span id={`${base}-${option.id}-about`} className="block text-xs text-muted-foreground">{option.about}</span>}
              </span>
            </label>
          );
        })}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">{t("autopilot.presets.hint")}</p>
    </fieldset>
  );
}
