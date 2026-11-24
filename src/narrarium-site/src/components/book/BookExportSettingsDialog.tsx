import { useEffect, useState } from "react";
import { Loader2, Save, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { applyExportDraft, exportDraftOfBook, type ExportDraft } from "@/bookSettings/exportDraft";
import { BookExportSettingsFields } from "@/components/book/BookExportSettingsFields";

interface BookExportSettingsDialogProps {
  bookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The export presets of a book in a dialog, for the export page, where the export is made. The same settings are in the Export tab of the book's settings;
 * both edit what `exportDraft` says and write it back the same way.
 */
export function BookExportSettingsDialog({ bookId, open, onOpenChange }: BookExportSettingsDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus } = useSettings();
  const book = settings.books.find((entry) => entry.id === bookId);
  const [draft, setDraft] = useState<ExportDraft | null>(() => (book ? exportDraftOfBook(book) : null));

  // The draft starts again from the book each time the dialog opens.
  useEffect(() => {
    if (open && book) setDraft(exportDraftOfBook(book));
  }, [open, book?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!book || !draft) return;
    patchSettings({ books: settings.books.map((entry) => (entry.id === book.id ? applyExportDraft(book, draft) : entry)) });
    try { await save(); } catch { return; }
    toast({ title: t("export.settingsSaved") });
    onOpenChange(false);
  }

  const isSaving = syncStatus === "saving";
  if (!book || !draft) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-1/2 top-1/2 flex h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[680px]">
        <DialogHeader className="flex-shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-primary" />
            {t("export.settingsTitle")}
          </DialogTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("export.settingsDescription")}</p>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 py-5">
            <BookExportSettingsFields draft={draft} onChange={setDraft} book={book} />
          </div>
        </ScrollArea>

        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {t("settings.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
