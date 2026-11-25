import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import "@/i18n/annotations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSettingsStore } from "@/store/settingsStore";
import { useSettings } from "@/drive/useSettings";
import { bookStorageMode, type BookEntry } from "@/types/settings";
import { publicNoticeKey, publicNoticesSeen } from "@/annotations/accountTags";

/**
 * The notice, once per GitHub book, that the annotations are saved in its repository, where they are public if the repository is: shown before the first
 * annotation or tag of the book is saved, which waits for it. Whether a repository is public is not read from GitHub: the notice says what follows if
 * it is. A book kept on this device has no notice. It is remembered in the account data, so another device does not show it again.
 */
export function usePublicNotice(book: BookEntry | undefined) {
  const { t } = useTranslation();
  const { save } = useSettings();
  const [pending, setPending] = useState<"annotation" | "tag" | null>(null);
  const resolver = useRef<((go: boolean) => void) | null>(null);

  const needsNotice = useCallback(() => {
    if (!book || bookStorageMode(book) !== "github" || !book.owner || !book.repo) return false;
    return !publicNoticesSeen(useSettingsStore.getState().settings.annotations).includes(publicNoticeKey(book));
  }, [book]);

  /** Resolves to true when the save can go on: no notice is due, or the author read it and went on. */
  const confirm = useCallback((kind: "annotation" | "tag"): Promise<boolean> => {
    if (!needsNotice()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPending(kind);
    });
  }, [needsNotice]);

  const finish = (go: boolean) => {
    if (go && book) {
      const settings = useSettingsStore.getState().settings;
      const seen = publicNoticesSeen(settings.annotations);
      const key = publicNoticeKey(book);
      if (!seen.includes(key)) {
        useSettingsStore.getState().patchSettings({ annotations: { ...settings.annotations, publicNoticeSeen: [...seen, key].sort() } });
        void save().catch(() => undefined);
      }
    }
    setPending(null);
    resolver.current?.(go);
    resolver.current = null;
  };

  const element = (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) finish(false); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe className="h-5 w-5 shrink-0" aria-hidden="true" />{t("annotations.notice.title")}</DialogTitle>
          <DialogDescription>{t("annotations.notice.body")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => finish(false)} className="[@media(pointer:coarse)]:h-11">{t("annotations.notice.cancel")}</Button>
          <Button type="button" onClick={() => finish(true)} className="[@media(pointer:coarse)]:h-11">{pending === "tag" ? t("annotations.notice.continueTag") : t("annotations.notice.continue")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, element };
}
