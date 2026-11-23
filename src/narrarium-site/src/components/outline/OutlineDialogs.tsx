import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConvertedSynopsis } from "@/outline/outlineModel";

/**
 * Asks before an entry is deleted: what happens to its chapter, whether the following ones close the gap, what is lost. `written`: the chapter has text in the book.
 * `stays`: the autopilot's plan remembers the entry of a chapter that is written (the engine's rule, `changeOfWritten`): it does not take the chapter out of the plan,
 * it only says once that the entry is gone.
 */
export function DeleteEntryDialog({ number, written, stays, unsaved, busy, onCancel, onConfirm }: { number: number | null; written: boolean; stays: boolean; unsaved: boolean; busy: boolean; onCancel: () => void; onConfirm: (renumber: boolean) => void }) {
  const { t } = useTranslation();
  const [renumber, setRenumber] = useState(false);
  useEffect(() => setRenumber(false), [number]);
  return (
    <Dialog open={number !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent role="alertdialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("outline.delete.title", { number })}</DialogTitle>
          <DialogDescription>{t(stays ? "outline.delete.bodyStays" : "outline.delete.body")}</DialogDescription>
        </DialogHeader>
        {written && <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">{t("outline.delete.written")}</p>}
        {unsaved && <p className="text-sm">{t("outline.delete.unsaved")}</p>}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={renumber} onChange={(event) => setRenumber(event.target.checked)} aria-describedby="outline-delete-renumber-hint" />
          <span>
            {t("outline.delete.renumber")}
            <span id="outline-delete-renumber-hint" className="block text-xs text-muted-foreground">{t("outline.delete.renumberHint")}</span>
          </span>
        </label>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => onConfirm(renumber)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}{t("outline.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What converting the brief's synopsis will write, before anything is written. */
export function ConvertSynopsisDialog({ converted, busy, onCancel, onConfirm }: { converted: ConvertedSynopsis | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const entries = converted?.entries ?? [];
  return (
    <Dialog open={converted !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("outline.convert.title")}</DialogTitle>
          <DialogDescription>{entries.length ? t("outline.convert.intro") : t("outline.convert.none")}</DialogDescription>
        </DialogHeader>
        {converted?.description && (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold">{t("outline.convert.description")}</h3>
            <p className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-sm">{converted.description}</p>
          </section>
        )}
        {entries.length > 0 && (
          <ol className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.number} className="rounded-lg border p-3 text-sm">
                <p className="font-semibold">{t("outline.entry.heading", { number: entry.number })}{entry.title ? <> — <span>{entry.title}</span></> : null}</p>
                {entry.body && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.body}</p>}
              </li>
            ))}
          </ol>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button type="button" disabled={busy || !entries.length} onClick={onConfirm}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{t("outline.convert.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
