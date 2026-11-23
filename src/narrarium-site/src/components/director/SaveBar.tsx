import { useTranslation } from "react-i18next";
import { SaveBar as PageSaveBar, type SaveBarState } from "@/components/layout/SaveBar";

export type { SaveBarState };

/**
 * The bar that saves the director, at the bottom of the window over the page's column (the whole width on a phone): whether the director is saved,
 * has changes, or is only the defaults (always in words, with an icon), Discard changes and Save. It is the save bar of the app with the director's
 * words. Leaving the page with changes asks first: the page registers them with the app, which asks.
 */
export function SaveBar({ anchor, state, reason, edited, canSave, busy, onSave, onDiscard }: { anchor: HTMLElement | null; state: SaveBarState; reason?: string; edited: boolean; canSave: boolean; busy: boolean; onSave: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  return (
    <PageSaveBar
      anchor={anchor}
      label={t("director.bar.label")}
      state={state}
      status={state === "failed" ? t("director.bar.failed", { reason }) : t(`director.bar.${state}`)}
      saveLabel={t("director.save")}
      canSave={canSave}
      busy={busy}
      onSave={onSave}
      discard={{ label: t("director.bar.discard"), enabled: edited, onDiscard }}
    />
  );
}
