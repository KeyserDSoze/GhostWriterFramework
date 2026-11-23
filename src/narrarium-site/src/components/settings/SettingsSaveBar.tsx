import "@/i18n/shell";
import { useTranslation } from "react-i18next";
import { SaveBar, type SaveBarState } from "@/components/layout/SaveBar";

/**
 * The save bar of a page of the settings: shown only while there is something to say (changes to save, a save under way or failed, a save just
 * done), at the bottom of the window, so that Save is on the screen next to the field the author changed, however far down the page it is.
 */
export function SettingsSaveBar({ anchor, state, reason, canSave, onSave }: { anchor: HTMLElement | null; state: Exclude<SaveBarState, "defaults">; reason?: string; canSave: boolean; onSave: () => void }) {
  const { t } = useTranslation();
  return (
    <SaveBar
      anchor={anchor}
      label={t("settingsBar.label")}
      state={state}
      status={state === "failed" ? t("settingsBar.failed", { reason }) : t(`settingsBar.${state}`)}
      saveLabel={t("common.save")}
      canSave={canSave}
      busy={state === "saving"}
      onSave={onSave}
    />
  );
}
