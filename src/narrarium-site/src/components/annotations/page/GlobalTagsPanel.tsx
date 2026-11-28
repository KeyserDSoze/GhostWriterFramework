import { useTranslation } from "react-i18next";
import "@/i18n/annotationsPage";
import { AnnotationTagsSettingsBody } from "@/components/settings/AnnotationTagsSettingsBody";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import type { AppSettings } from "@/types/settings";

/**
 * The tags for EVERY book, made here as in Settings › Annotation tags (the same form and the same data: they are account data), but saved at once: on this page
 * there is no bar of the settings to press. A change that cannot be saved right now (offline) stays in the settings of this device and goes with the next save.
 */
export function GlobalTagsPanel() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const { save } = useSettings();
  const change = (patch: Partial<AppSettings>) => {
    patchSettings(patch);
    void save().catch(() => undefined);
  };
  return (
    <section aria-labelledby="annotations-global-tags" className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h2 id="annotations-global-tags" className="text-lg font-semibold">{t("annotationsPage.tags.globalTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("annotationsPage.tags.globalDescription")}</p>
      </div>
      <AnnotationTagsSettingsBody settings={settings} patchSettings={change} />
    </section>
  );
}
