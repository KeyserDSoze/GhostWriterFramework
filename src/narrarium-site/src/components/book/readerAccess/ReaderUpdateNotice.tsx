import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import "@/i18n/readerUpdate";
import { Button } from "@/components/ui/button";
import type { BookEntry } from "@/types/settings";
import { useReaderUpdate } from "@/readerUpdate/useReaderUpdate";

/**
 * In the status of the GitHub tab: said once, in plain words, when the reader of the book is older than the current one, with the way to the update. It shows
 * nothing while checking, when the reader is current and when there is no reader to check; it is a notice, not an alert, so it is not read out at every visit.
 */
export function ReaderUpdateNotice({ book, onOpen }: { book: BookEntry; onOpen: () => void }) {
  const { t } = useTranslation();
  const { inspection } = useReaderUpdate(book);
  const decision = inspection?.decision;
  if (decision?.kind !== "update" && decision?.kind !== "on-device") return null;
  if (decision.kind === "on-device" && decision.remoteWorkflow !== "old" && decision.remoteWorkflow !== "missing" && decision.unpublished.length === 0) return null;
  const exposed = decision.exposure === "password-old-reader";
  return (
    <section aria-label={t("readerUpdate.notice.title")} className={`space-y-2 rounded-md border p-3 text-sm ${exposed ? "border-destructive/60 bg-destructive/5" : "border-amber-600/50 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"}`} data-testid="reader-update-notice">
      <h3 className="flex items-start gap-2 font-semibold"><ShieldAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{decision.kind === "on-device" ? t("readerUpdate.onDevice.title") : t("readerUpdate.notice.title")}</h3>
      <p>{decision.kind === "on-device" ? t("readerUpdate.notice.onDevice") : exposed ? t("readerUpdate.notice.password") : t("readerUpdate.notice.plain")}</p>
      <Button type="button" size="sm" variant="outline" onClick={onOpen}>{t("readerUpdate.notice.go")}</Button>
    </section>
  );
}
